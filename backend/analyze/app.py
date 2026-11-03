import base64
import hmac
import json
import os
import re
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

import gates
import retrieve
from analyzer import AnalysisError, assemble, call_llm
from data import get_data
from prompt import build_examples_block

MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-haiku-4-5-20251001-v1:0")
MAX_INPUT_CHARS = int(os.environ.get("MAX_INPUT_CHARS", "1500"))
RETRIEVE_K = int(os.environ.get("RETRIEVE_K", "6"))
MIN_INPUT_CHARS = 20
MAX_BODY_BYTES = 16 * 1024

_bedrock = boto3.client(
    "bedrock-runtime", config=Config(read_timeout=26, connect_timeout=3, retries={"max_attempts": 1}))


def _response(status, body):
    return {"statusCode": status, "headers": {"Content-Type": "application/json", "Cache-Control": "no-store"},
            "body": json.dumps(body, ensure_ascii=False)}


def _error(status, code, message):
    return _response(status, {"error": code, "message": message})


def _client_ip(event):
    viewer = (event.get("headers") or {}).get("cloudfront-viewer-address", "")
    if viewer:
        return viewer.rsplit(":", 1)[0].strip("[]")
    return event.get("requestContext", {}).get("http", {}).get("sourceIp", "unknown")


def _parse_body(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8", "replace")
    if len(raw.encode()) > MAX_BODY_BYTES:
        raise gates.GateError(413, "too_large", "Request is too large.")
    try:
        body = json.loads(raw)
    except ValueError:
        raise gates.GateError(400, "bad_request", "Request body must be JSON.")
    if not isinstance(body, dict):
        raise gates.GateError(400, "bad_request", "Request body must be a JSON object.")
    return body


def _is_noise(text):
    """Cheap check for random or repeated characters, so they never reach Bedrock."""
    words = {w.lower() for w in re.findall(r"[A-Za-z]{2,}", text)}
    return len(words) < 4 or sum(c.isalpha() or c.isspace() for c in text) < 0.7 * len(text)


def lambda_handler(event, context):
    try:
        expected = os.environ.get("ORIGIN_VERIFY", "")
        sent = (event.get("headers") or {}).get("x-origin-verify", "")
        if not expected or not hmac.compare_digest(sent, expected):
            raise gates.GateError(403, "forbidden", "Forbidden.")

        body = _parse_body(event)
        ip = _client_ip(event)
        if event.get("rawPath", "").endswith("/api/login"):
            gates.consume_login_attempt(ip)
            invite = gates.check_invite(body.get("invite_code"))
            return _response(200, {"ok": True, "daily_quota": invite["daily_quota"]})

        text = body.get("summary")
        if not isinstance(text, str) or not (MIN_INPUT_CHARS <= len(text.strip()) <= MAX_INPUT_CHARS):
            raise gates.GateError(
                400, "invalid_summary",
                f"Describe the incident in {MIN_INPUT_CHARS} to {MAX_INPUT_CHARS} characters.")
        text = text.strip()
        if _is_noise(text):
            raise gates.GateError(400, "invalid_summary",
                                  "Describe the incident in words: what happened, which systems are affected and what the attackers want.")

        invite = gates.check_invite(body.get("invite_code"))
        gates.verify_turnstile(body.get("turnstile_token"), ip)
        gates.consume_quotas(invite, ip)

        playbook, incidents, prefix, tool = get_data()
        examples = build_examples_block(retrieve.similar(incidents, text, RETRIEVE_K))
        llm_output, usage = call_llm(_bedrock, MODEL_ID, prefix, tool, text, examples=examples)
        analysis = assemble(llm_output, playbook)
        analysis["id"] = str(uuid.uuid4())
        analysis["playbook_generated_at"] = playbook.get("generated_at", "")
        gates.save_history(analysis["id"], invite["label"], text, llm_output, MODEL_ID, usage)
        return _response(200, analysis)

    except gates.GateError as exc:
        print(json.dumps({"event": "rejected", "code": exc.code}))
        return _error(exc.status, exc.code, exc.message)
    except ClientError as exc:
        code = exc.response["Error"]["Code"]
        print(json.dumps({"event": "aws_error", "code": code}))
        if code in ("ThrottlingException", "ServiceQuotaExceededException", "ModelNotReadyException"):
            return _error(503, "busy", "The analysis service is busy. Try again in a minute.")
        return _error(502, "upstream_error", "The analysis failed. Try again.")
    except AnalysisError:
        print(json.dumps({"event": "analysis_error"}))
        return _error(502, "analysis_error", "The analysis could not be completed. Try again.")
    except Exception as exc:  # Never echo internals (or the input) to the client.
        print(json.dumps({"event": "unhandled", "type": type(exc).__name__}))
        return _error(500, "internal_error", "Something went wrong.")
