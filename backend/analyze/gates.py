import hashlib
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

_ddb = boto3.client("dynamodb")
_ssm = boto3.client("ssm")
_secrets = {}

TABLE = os.environ.get("TABLE_NAME", "")
IP_HOURLY_LIMIT = int(os.environ.get("IP_HOURLY_LIMIT", "10"))
GLOBAL_DAILY_LIMIT = int(os.environ.get("GLOBAL_DAILY_LIMIT", "200"))
HISTORY_TTL_DAYS = int(os.environ.get("HISTORY_TTL_DAYS", "90"))
LOGIN_HOURLY_LIMIT = int(os.environ.get("LOGIN_HOURLY_LIMIT", "30"))


class GateError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def _secret(param_name):
    if param_name not in _secrets:
        _secrets[param_name] = _ssm.get_parameter(Name=param_name, WithDecryption=True)["Parameter"]["Value"]
    return _secrets[param_name]


def verify_turnstile(token, ip):
    param = os.environ.get("TURNSTILE_SECRET_PARAM", "")
    if not param:
        if os.environ.get("DISABLE_TURNSTILE") == "1":
            return
        raise GateError(500, "misconfigured", "Service is not configured.")
    if not token or len(token) > 2048:
        raise GateError(403, "captcha_failed", "Please complete the verification challenge.")
    body = urllib.parse.urlencode({"secret": _secret(param), "response": token, "remoteip": ip}).encode()
    req = urllib.request.Request("https://challenges.cloudflare.com/turnstile/v0/siteverify", data=body)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            ok = json.loads(resp.read()).get("success") is True
    except Exception:
        raise GateError(503, "captcha_unavailable", "Verification service unavailable. Try again.")
    if not ok:
        raise GateError(403, "captcha_failed", "Verification failed. Please retry.")


def check_invite(code):
    """Return the invite record; raises if unknown, disabled or expired."""
    code = (code or "").strip().upper()
    if not code or len(code) > 64:
        raise GateError(403, "invalid_invite", "Invalid or expired access code.")
    item = _ddb.get_item(TableName=TABLE, Key={"pk": {"S": "INVITE#" + _sha(code)}, "sk": {"S": "META"}}).get("Item")
    if (not item or item.get("enabled", {}).get("BOOL") is False
            or int(item.get("expires_at", {}).get("N", "0")) < time.time()):
        raise GateError(403, "invalid_invite", "Invalid or expired access code.")
    return {"hash": _sha(code), "label": item.get("label", {}).get("S", ""),
            "daily_quota": int(item.get("daily_quota", {}).get("N", "10"))}


def _bump(pk, sk, limit, ttl_seconds, message):
    """Atomically increment a counter; refuse once it reaches the limit."""
    try:
        _ddb.update_item(
            TableName=TABLE, Key={"pk": {"S": pk}, "sk": {"S": sk}},
            UpdateExpression="ADD cnt :one SET #t = :ttl",
            ConditionExpression="attribute_not_exists(cnt) OR cnt < :limit",
            ExpressionAttributeNames={"#t": "ttl"},
            ExpressionAttributeValues={":one": {"N": "1"}, ":limit": {"N": str(limit)},
                                       ":ttl": {"N": str(int(time.time()) + ttl_seconds)}})
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise GateError(429, "rate_limited", message)
        raise


def consume_login_attempt(ip):
    hour = datetime.now(timezone.utc).strftime("%Y%m%d%H")
    _bump("IP#" + _sha(ip), "L#" + hour, LOGIN_HOURLY_LIMIT, 2 * 3600, "Too many sign-in attempts. Try again later.")


def consume_quotas(invite, ip):
    now = datetime.now(timezone.utc)
    day, hour = now.strftime("%Y%m%d"), now.strftime("%Y%m%d%H")
    _bump("IP#" + _sha(ip), "H#" + hour, IP_HOURLY_LIMIT, 2 * 3600, "Too many requests from your network. Try again later.")
    _bump("GLOBAL", "D#" + day, GLOBAL_DAILY_LIMIT, 2 * 86400, "The service has reached its daily capacity. Try again tomorrow.")
    _bump("INVITE#" + invite["hash"], "D#" + day, invite["daily_quota"], 2 * 86400,
          "Daily limit for this access code reached. Try again tomorrow.")


def save_history(analysis_id, invite_label, text, llm_output, model_id, usage):
    item = {
        "pk": {"S": "ANALYSIS#" + analysis_id}, "sk": {"S": "META"},
        "created_at": {"S": datetime.now(timezone.utc).isoformat(timespec="seconds")},
        "invite_label": {"S": invite_label or "-"},
        "input": {"S": text}, "llm_output": {"S": json.dumps(llm_output, ensure_ascii=False)},
        "model_id": {"S": model_id},
        "input_tokens": {"N": str(usage.get("inputTokens", 0))},
        "output_tokens": {"N": str(usage.get("outputTokens", 0))},
        "ttl": {"N": str(int(time.time()) + HISTORY_TTL_DAYS * 86400)},
    }
    try:
        _ddb.put_item(TableName=TABLE, Item=item)
    except ClientError:
        pass  # History is best-effort; never fail the user's analysis.
