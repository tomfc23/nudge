"""Hermes ntfy plugin. Configuration is shared with the Node adapters."""

import json
import hashlib
import os
import re
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

_last = {}


def _config():
    file = os.environ.get("NTFY_CONFIG_FILE")
    if not file:
        project_key = hashlib.sha256(str(Path.cwd()).encode()).hexdigest()
        local = Path.home() / ".config/ntfy-archive/projects" / f"{project_key}.json"
        file = local if local.exists() else Path.home() / ".config/ntfy-archive/config.json"
    try:
        cfg = json.loads(Path(file).read_text())
        if cfg.get("serverUrl") and cfg.get("baseTopic"):
            return cfg
    except (OSError, ValueError):
        pass
    return None


def _send(kind, session, title, message, *, topic=None, priority=None, tags=None):
    cfg = _config()
    if not cfg:
        return False
    events = cfg.get("events") or {}
    event = events.get(kind) or {}
    if event.get("enabled") is False:
        return False
    now = time.monotonic()
    key = (kind, session)
    window = event.get("cooldownSec", 60) if kind == "error" else 5
    if kind != "custom" and now - _last.get(key, -1e9) < window:
        return False
    _last[key] = now
    defaults = {"question": (5, ["question"]), "permission": (5, ["lock"]),
                "finished": (3, ["heavy_check_mark"]), "error": (4, ["rotating_light"]),
                "custom": (3, [])}
    default_priority, default_tags = defaults[kind]
    priority = priority or event.get("priority", default_priority)
    priority = {"min": 1, "low": 2, "default": 3, "high": 4, "urgent": 5}.get(priority, priority)
    body = json.dumps({"topic": topic or cfg["baseTopic"], "title": title[:128],
                       "message": str(message)[:240], "priority": priority,
                       "tags": tags if tags is not None else event.get("tags", default_tags)}).encode()
    headers = {"Content-Type": "application/json"}
    if cfg.get("token"):
        headers["Authorization"] = "Bearer " + cfg["token"]
    try:
        with urlopen(Request(cfg["serverUrl"].rstrip("/") + "/", body, headers), timeout=3):
            return True
    except Exception as exc:
        print(f"[ntfy] publish failed: {exc}", file=sys.stderr)
        return False


def _on_turn(session_id="", assistant_response="", **kwargs):
    text = assistant_response.strip()
    qcfg = ((_config() or {}).get("events") or {}).get("question") or {}
    mode = qcfg.get("idleMode", "heuristic")
    prose = re.sub(r"```.*?```|`[^`\n]*`|https?://\S+", " ", text, flags=re.S)
    prose = re.sub(r"\s+", " ", prose).strip()
    patterns = qcfg.get("patterns") or [r"\b(?:should i|should we|shall i|would you like|do you want|want me to|do you prefer|do you mind|does that work|let me know|which one|which option|how about|any thoughts|any questions|sound good|look good to you)\b"]
    question = mode == "always" or (mode != "off" and prose.endswith("?"))
    if mode != "off" and not question:
        for pattern in patterns:
            try:
                if isinstance(pattern, str) and re.search(pattern, prose, re.I):
                    question = True
                    break
            except re.error:
                pass
    kind = "question" if question else "finished"
    title = Path.cwd().name or "Hermes"
    _send(kind, session_id, f"{kind.capitalize()}: {title}", text if question else "Hermes finished a turn")


def _on_tool(tool_name="", status="", error_message="", session_id="", **kwargs):
    if status in ("error", "timeout"):
        _send("error", session_id, f"Error: {Path.cwd().name}", f"{tool_name}: {error_message or 'tool failed'}")


def _on_approval(description="", session_key="", **kwargs):
    _send("permission", session_key, f"Permission needed: {Path.cwd().name}", description or "Hermes needs approval")


def _on_end(session_id="", failed=False, interrupted=False, turn_exit_reason="", **kwargs):
    if failed and not interrupted:
        _send("error", session_id, f"Error: {Path.cwd().name}", turn_exit_reason or "Hermes turn failed")


def _notify(params, **kwargs):
    message = params.get("message")
    if not isinstance(message, str) or not message.strip():
        return json.dumps({"success": False, "error": "message is required"})
    topic = params.get("topic")
    priority = params.get("priority")
    tags = params.get("tags")
    if topic is not None and (not isinstance(topic, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", topic)):
        return json.dumps({"success": False, "error": "invalid topic"})
    if priority is not None and priority not in ("min", "low", "default", "high", "urgent"):
        return json.dumps({"success": False, "error": "invalid priority"})
    if tags is not None and (not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags)):
        return json.dumps({"success": False, "error": "invalid tags"})
    title = params.get("title")
    if title is not None and not isinstance(title, str):
        return json.dumps({"success": False, "error": "invalid title"})
    sent = _send("custom", "custom", title or "ntfy", message,
                 topic=topic, priority=priority, tags=tags)
    return json.dumps({"success": sent})


def register(ctx):
    ctx.register_hook("post_llm_call", _on_turn)
    ctx.register_hook("post_tool_call", _on_tool)
    ctx.register_hook("pre_approval_request", _on_approval)
    ctx.register_hook("on_session_end", _on_end)
    ctx.register_tool(
        name="ntfy_notify", toolset="ntfy",
        schema={"name": "ntfy_notify", "description": "Send a custom push notification to the user's phone via ntfy.",
                "parameters": {"type": "object", "properties": {"message": {"type": "string"},
                                                        "title": {"type": "string"},
                                                        "priority": {"type": "string", "enum": ["min", "low", "default", "high", "urgent"]},
                                                        "tags": {"type": "array", "items": {"type": "string"}},
                                                        "topic": {"type": "string"}}, "required": ["message"]}},
        handler=_notify,
    )
