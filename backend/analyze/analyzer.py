import json
import os
import re

from botocore.exceptions import ClientError

from prompt import TOOL_NAME, wrap_user_text

SECTIONS = ("internal", "phi", "ransom", "general")
LLM_KEYS = {"internal": "internal_triggers", "phi": "phi_labels", "ransom": "ransom_labels", "general": "general_labels"}
MAX_TOKENS = int(os.environ.get("MAX_OUTPUT_TOKENS", "2500"))
MAX_ATTEMPTS = 3
REQUIRED_LISTS = ("internal_triggers", "phi_labels", "ransom_labels", "general_labels", "next_steps")
_PARAM = re.compile(r'<parameter name="(\w+)">')
_TRAILING_TAG = re.compile(r"\s*</[^>]*>\s*$")


class AnalysisError(Exception):
    pass


def recover(llm):
    """The model sometimes runs later tool parameters into an earlier string value as pseudo-XML; split them back out."""
    for key, value in list(llm.items()):
        if not isinstance(value, str) or "<parameter name=" not in value:
            continue
        head, _, rest = value.partition("<parameter name=")
        llm[key] = _TRAILING_TAG.sub("", head).strip()
        parts = _PARAM.split('<parameter name=' + rest)
        for name, body in zip(parts[1::2], parts[2::2]):
            body = re.sub(r"\s*</parameter>\s*$", "", body).strip()
            try:
                parsed = json.loads(body)
            except ValueError:
                parsed = body
            if name not in llm or llm[name] in (None, "", [], {}):
                llm[name] = parsed
    return llm


def is_complete(llm):
    return llm.get("report_status") == "insufficient" or all(isinstance(llm.get(k), list) for k in REQUIRED_LISTS)


def _invoke(client, model_id, prefix, tool_spec, text, use_cache, examples, temperature):
    kwargs = {
        "modelId": model_id,
        "system": [{"text": prefix}] + ([{"cachePoint": {"type": "default"}}] if use_cache else []),
        "messages": [{"role": "user", "content": [{"text": examples + wrap_user_text(text)}]}],
        "inferenceConfig": {"maxTokens": MAX_TOKENS, "temperature": temperature},
        "toolConfig": {"tools": [{"toolSpec": tool_spec}], "toolChoice": {"tool": {"name": TOOL_NAME}}},
    }
    try:
        resp = client.converse(**kwargs)
    except ClientError as exc:
        # Some models reject cache points; retry once without.
        if use_cache and exc.response["Error"]["Code"] == "ValidationException" and "cache" in str(exc).lower():
            return _invoke(client, model_id, prefix, tool_spec, text, False, examples, temperature)
        raise
    for block in resp["output"]["message"]["content"]:
        if "toolUse" in block:
            return block["toolUse"]["input"], resp.get("usage", {})
    raise AnalysisError("model returned no structured output")


def call_llm(client, model_id, prefix, tool_spec, text, use_cache=True, examples=""):
    # Temperature 0 repeats a malformed answer, so retries sample.
    for attempt in range(MAX_ATTEMPTS):
        out, usage = _invoke(client, model_id, prefix, tool_spec, text, use_cache, examples, 0 if attempt == 0 else 0.4)
        out = recover(out)
        if is_complete(out):
            return out, usage
    raise AnalysisError("model output was incomplete")


def _as_list(value):
    return value if isinstance(value, list) else []


def _by_id(rows):
    return {r["id"]: r for r in rows}


def _ruled_out_by_count(count):
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        return set()
    return {"P3"} if count >= 500 else {"P2", "P4"}


def _apply_breach_threshold(phi, count):
    """P2/P3/P4 hinge on 500 individuals; the model extracts the number and the code applies the threshold."""
    if "P2" in phi and "P3" in phi:
        phi.pop("P3")
    if not _ruled_out_by_count(count) or not (phi.keys() & {"P1", "P2", "P3"}):
        return
    if count >= 500:
        phi.pop("P3", None)
        phi.setdefault("P2", {"id": "P2", "reason": f"The report states {count:,} individuals affected (500 or more)."})
    else:
        phi.pop("P2", None)
        phi.pop("P4", None)
        phi.setdefault("P3", {"id": "P3", "reason": f"The report states {count:,} individuals affected (fewer than 500)."})


def assemble(llm, playbook):
    """Merge the LLM's selections with the full playbook rows; unknown IDs are dropped."""
    if llm.get("report_status") == "insufficient":
        return {"report_status": "insufficient", "ransomware_related": False, "playbook_coverage": "none",
                "situation_summary": "", "facts": {}, "internal_triggers": [], "phi": [], "ransom": [],
                "general": [], "also_linked": {"phi": [], "ransom": [], "general": []},
                "clarifying_questions": [], "next_steps": [], "warnings": []}
    rows = {s: _by_id(playbook[s]) for s in SECTIONS}
    selected = {}
    for section in SECTIONS:
        picked = {}
        for item in _as_list(llm.get(LLM_KEYS[section])):
            if isinstance(item, str):
                item = {"id": item}
            if isinstance(item, dict) and item.get("id") in rows[section] and item["id"] not in picked:
                picked[item["id"]] = item
        selected[section] = picked

    ransomware = bool(llm.get("ransomware_related"))
    if ransomware and "ENTRY" not in selected["internal"]:
        selected["internal"] = {"ENTRY": {"id": "ENTRY", "confidence": "medium", "evidence": "",
                                          "reason": "Ransomware incident; crisis activation is the playbook entry point."},
                                **selected["internal"]}
    order = list(rows["internal"])
    selected["internal"] = dict(sorted(selected["internal"].items(), key=lambda kv: order.index(kv[0])))

    _apply_breach_threshold(selected["phi"], llm.get("individuals_affected_count"))
    ruled_out = _ruled_out_by_count(llm.get("individuals_affected_count"))
    phi_order = list(rows["phi"])
    selected["phi"] = dict(sorted(selected["phi"].items(), key=lambda kv: phi_order.index(kv[0])))

    matched_t = set(selected["internal"])
    warnings = []
    for section in ("ransom", "general"):
        for ident in selected[section]:
            if not matched_t & set(rows[section][ident]["source_triggers"]):
                warnings.append(f"{ident} is normally tied to {', '.join(rows[section][ident]['source_triggers'])}, which was not matched.")

    result = {section: [{**rows[section][i], **{k: v for k, v in item.items() if k != "id"}}
                        for i, item in selected[section].items()] for section in SECTIONS}

    linked = {"phi": set(), "ransom": set(), "general": set()}
    for t in matched_t:
        trig = rows["internal"][t]
        for label in trig["linked_labels"]:
            linked[label_section(label)].add(label)
        for table in trig["linked_tables"]:
            linked[table].update(rows[table])
    for section in ("ransom", "general"):
        for ident, row in rows[section].items():
            if matched_t & set(row["source_triggers"]):
                linked[section].add(ident)
    also_linked = {s: [rows[s][i] for i in rows[s] if i in linked[s] and i not in selected[s]
                       and i not in ruled_out]
                   for s in linked}

    return {
        "report_status": "incident",
        "ransomware_related": ransomware,
        "playbook_coverage": llm.get("playbook_coverage", "partial"),
        "situation_summary": llm.get("situation_summary", ""),
        "facts": llm.get("extracted_facts") if isinstance(llm.get("extracted_facts"), dict) else {},
        "internal_triggers": result["internal"],
        "phi": result["phi"],
        "ransom": result["ransom"],
        "general": result["general"],
        "also_linked": also_linked,
        "clarifying_questions": [q for q in _as_list(llm.get("clarifying_questions")) if isinstance(q, str)],
        "next_steps": [s for s in _as_list(llm.get("next_steps")) if isinstance(s, dict)],
        "warnings": warnings,
    }


def label_section(label):
    return {"P": "phi", "R": "ransom", "G": "general"}[label[0]]
