import os

from botocore.exceptions import ClientError

from prompt import TOOL_NAME, wrap_user_text

SECTIONS = ("internal", "phi", "ransom", "general")
LLM_KEYS = {"internal": "internal_triggers", "phi": "phi_labels", "ransom": "ransom_labels", "general": "general_labels"}
MAX_TOKENS = int(os.environ.get("MAX_OUTPUT_TOKENS", "2500"))


class AnalysisError(Exception):
    pass


def call_llm(client, model_id, prefix, tool_spec, text, use_cache=True, examples=""):
    kwargs = {
        "modelId": model_id,
        "system": [{"text": prefix}] + ([{"cachePoint": {"type": "default"}}] if use_cache else []),
        "messages": [{"role": "user", "content": [{"text": examples + wrap_user_text(text)}]}],
        "inferenceConfig": {"maxTokens": MAX_TOKENS, "temperature": 0},
        "toolConfig": {"tools": [{"toolSpec": tool_spec}], "toolChoice": {"tool": {"name": TOOL_NAME}}},
    }
    try:
        resp = client.converse(**kwargs)
    except ClientError as exc:
        # Some models reject cache points; retry once without.
        if use_cache and exc.response["Error"]["Code"] == "ValidationException" and "cache" in str(exc).lower():
            return call_llm(client, model_id, prefix, tool_spec, text, use_cache=False, examples=examples)
        raise
    for block in resp["output"]["message"]["content"]:
        if "toolUse" in block:
            return block["toolUse"]["input"], resp.get("usage", {})
    raise AnalysisError("model returned no structured output")


def _as_list(value):
    return value if isinstance(value, list) else []


def _by_id(rows):
    return {r["id"]: r for r in rows}


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
    also_linked = {s: [rows[s][i] for i in rows[s] if i in linked[s] and i not in selected[s]]
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
