from __future__ import annotations

import base64
import json
import re
import time
import uuid
from typing import Any, Iterable, Iterator

from fastapi import HTTPException

from services.protocol.chat_completion_cache import cache_key, chat_completion_cache, normalize_text_messages
from services.protocol.conversation import (
    ConversationRequest,
    ImageOutput,
    count_message_text_tokens,
    count_text_tokens,
    encode_images,
    stream_image_outputs_with_pool,
    stream_text_deltas,
    text_backend,
)
from utils.helper import extract_image_from_message_content, extract_response_prompt, has_response_image_generation_tool
from utils.image_tokens import (
    count_image_content_tokens,
    count_image_output_items_tokens,
    image_usage,
    token_usage,
)

TOOL_CALL_SYSTEM_MESSAGE = """
You are an OpenAI Responses API compatible coding model behind a proxy.
You cannot execute local tools yourself; only request tool calls for the client to execute.
You may request exactly one tool call when external work is required.
If the user asks you to fix, implement, inspect, update, deploy, run tests, or otherwise handle work in the project,
you MUST request an available tool call instead of writing manual instructions.
When you need repository context, call a shell/command tool first.
If you need a tool, reply with only one JSON object:
{"type":"function_call","name":"tool_name","arguments":{...}}
If no tool is needed, reply normally with the final answer.
Never claim that you executed a tool yourself. Wait for function_call_output before using tool results.
""".strip()

CODEX_UPSTREAM_MAX_CHARS = 42000
CODEX_UPSTREAM_MAX_MESSAGE_CHARS = 14000
CODEX_UPSTREAM_KEEP_LAST_MESSAGES = 8
SHELL_TOOL_NAME_HINTS = ("shell", "exec", "command", "terminal", "powershell", "bash", "run")
ACTION_REQUEST_RE = re.compile(
    r"(帮我|处理|修复|实现|新增|添加|升级|同步|部署|推送|测试|运行|查看|检查|改成|优化|继续|"
    r"开始|执行|接着|搞定|完成|全部|直接|别问|不要问|不需要问|自动|"
    r"\bfix\b|\bimplement\b|\bupdate\b|\bdeploy\b|\bpush\b|\btest\b|\brun\b|\binspect\b|\bcheck\b)",
    re.IGNORECASE,
)
CLARIFICATION_REQUEST_RE = re.compile(
    r"(do you want|would you like|should i|which option|merge .* cherry-pick|cherry-pick .* merge|"
    r"你想|是否要|要不要|需要你|请确认|选择|合并还是|还是.*挑选)",
    re.IGNORECASE,
)
FENCED_COMMAND_RE = re.compile(
    r"```(?:powershell|pwsh|ps1|bash|sh|zsh|shell|cmd|bat|terminal)?\s*\n(.*?)```",
    re.DOTALL | re.IGNORECASE,
)


def is_text_response_request(body: dict[str, Any]) -> bool:
    return not has_response_image_generation_tool(body)


def has_non_image_tools(body: dict[str, Any]) -> bool:
    tools = body.get("tools")
    if not isinstance(tools, list):
        return False
    return any(
        isinstance(tool, dict) and str(tool.get("type") or "").strip() != "image_generation"
        for tool in tools
    )


def is_function_tool_request(body: dict[str, Any]) -> bool:
    if has_non_image_tools(body):
        return True
    input_value = body.get("input")
    if isinstance(input_value, list):
        return any(isinstance(item, dict) and str(item.get("type") or "") == "function_call_output" for item in input_value)
    return False


def response_function_tools(body: dict[str, Any]) -> list[dict[str, Any]]:
    tools = body.get("tools")
    if not isinstance(tools, list):
        return []
    return [
        tool
        for tool in tools
        if isinstance(tool, dict) and str(tool.get("type") or "").strip() != "image_generation"
    ]


def response_image_tool(body: dict[str, Any]) -> dict[str, object]:
    for tool in body.get("tools") or []:
        if isinstance(tool, dict) and tool.get("type") == "image_generation":
            return tool
    return {}


def _is_response_content_part(item: dict[str, Any]) -> bool:
    return str(item.get("type") or "").strip() in {"input_text", "input_image", "input_file", "output_text"}


def _part_text(part: dict[str, Any]) -> str:
    part_type = str(part.get("type") or "").strip()
    if part_type in {"input_text", "output_text", "text"}:
        return str(part.get("text") or part.get("input_text") or "").strip()
    if part_type == "input_file":
        filename = str(part.get("filename") or part.get("file_id") or "").strip()
        return f"[input_file: {filename}]" if filename else "[input_file]"
    if part_type == "input_image":
        return "[input_image]"
    return ""


def _decode_data_url(value: str) -> tuple[bytes, str] | None:
    url = str(value or "").strip()
    if not url.startswith("data:") or "," not in url:
        return None
    header, _, data = url.partition(",")
    mime = header.split(";", 1)[0].removeprefix("data:").strip() or "image/png"
    try:
        return base64.b64decode(data), mime
    except Exception:
        return None


def _image_part_from_response_part(part: dict[str, Any]) -> dict[str, Any] | None:
    part_type = str(part.get("type") or "").strip()
    if part_type not in {"input_image", "image_url", "image"}:
        return None
    data = part.get("data")
    if isinstance(data, (bytes, bytearray)):
        return {"type": "image", "data": bytes(data), "mime": str(part.get("mime") or "image/png")}

    image_url = part.get("image_url") or part.get("url")
    if isinstance(image_url, dict):
        image_url = image_url.get("url")
    decoded = _decode_data_url(str(image_url or ""))
    if decoded:
        image_data, mime = decoded
        return {"type": "image", "data": image_data, "mime": mime}

    b64_json = str(part.get("b64_json") or "").strip()
    if b64_json:
        try:
            return {"type": "image", "data": base64.b64decode(b64_json), "mime": str(part.get("mime") or "image/png")}
        except Exception:
            return None
    return None


def _content_for_backend(content: object) -> object:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return str(content or "").strip()
    parts: list[dict[str, Any]] = []
    text_parts: list[str] = []
    for part in content:
        if isinstance(part, str):
            text_parts.append(part)
            continue
        if not isinstance(part, dict):
            continue
        image_part = _image_part_from_response_part(part)
        if image_part:
            if text_parts:
                text = "\n".join(item for item in text_parts if item).strip()
                if text:
                    parts.append({"type": "text", "text": text})
                text_parts = []
            parts.append(image_part)
            continue
        text = _part_text(part)
        if text and text != "[input_image]":
            text_parts.append(text)
    if text_parts:
        text = "\n".join(item for item in text_parts if item).strip()
        if text:
            parts.append({"type": "text", "text": text})
    if not parts:
        return ""
    if len(parts) == 1 and parts[0].get("type") == "text":
        return str(parts[0].get("text") or "")
    return parts


def _content_text(content: object) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, str):
                text = part.strip()
            elif isinstance(part, dict):
                text = _part_text(part)
            else:
                text = ""
            if text:
                parts.append(text)
        return "\n".join(parts).strip()
    return str(content or "").strip()


def _strip_codex_boilerplate(text: str) -> str:
    value = str(text or "")
    if not value:
        return ""
    tag_patterns = [
        r"<permissions instructions>.*?</permissions instructions>",
        r"<app-context>.*?</app-context>",
        r"<skills_instructions>.*?</skills_instructions>",
        r"<plugins_instructions>.*?</plugins_instructions>",
        r"<model_switch>.*?</model_switch>",
        r"<collaboration_mode>.*?</collaboration_mode>",
        r"<environment_context>.*?</environment_context>",
    ]
    for pattern in tag_patterns:
        value = re.sub(pattern, "\n[codex client context omitted]\n", value, flags=re.DOTALL | re.IGNORECASE)
    return re.sub(r"\n{3,}", "\n\n", value).strip()


def _trim_middle(text: str, limit: int) -> str:
    value = str(text or "")
    if len(value) <= limit:
        return value
    marker = "\n[...omitted to fit upstream request limit...]\n"
    keep = max(0, limit - len(marker))
    head = keep // 3
    tail = keep - head
    return value[:head].rstrip() + marker + value[-tail:].lstrip()


def _compact_text_for_upstream(text: str, limit: int = CODEX_UPSTREAM_MAX_MESSAGE_CHARS) -> str:
    return _trim_middle(_strip_codex_boilerplate(text), limit)


def compact_messages_for_upstream(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compacted: list[dict[str, Any]] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "user").strip() or "user"
        raw_content = message.get("content")
        if isinstance(raw_content, list):
            content_parts: list[dict[str, Any]] = []
            for part in raw_content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "image":
                    content_parts.append(part)
                    continue
                if part.get("type") == "text":
                    text = _compact_text_for_upstream(str(part.get("text") or ""))
                    if text:
                        content_parts.append({"type": "text", "text": text})
            content = content_parts
        else:
            content = _compact_text_for_upstream(str(raw_content or ""))
        if content:
            compacted.append({"role": role, "content": content})

    total = 0
    for message in compacted:
        content = message.get("content")
        if isinstance(content, list):
            total += sum(len(str(part.get("text") or "")) for part in content if isinstance(part, dict) and part.get("type") == "text")
        else:
            total += len(str(content or ""))
    if total <= CODEX_UPSTREAM_MAX_CHARS:
        return compacted

    system_messages = [message for message in compacted if message.get("role") == "system"]
    recent_messages = [message for message in compacted if message.get("role") != "system"][-CODEX_UPSTREAM_KEEP_LAST_MESSAGES:]
    selected = [*system_messages[:2], *recent_messages]
    budget = CODEX_UPSTREAM_MAX_CHARS
    result: list[dict[str, Any]] = []
    for index, message in enumerate(selected):
        remaining_items = max(1, len(selected) - index)
        per_message_limit = max(1200, budget // remaining_items)
        raw_content = message.get("content")
        if isinstance(raw_content, list):
            content_parts = []
            text_len = 0
            for part in raw_content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "image":
                    content_parts.append(part)
                    continue
                if part.get("type") == "text":
                    text = _trim_middle(str(part.get("text") or ""), per_message_limit)
                    if text:
                        text_len += len(text)
                        content_parts.append({"type": "text", "text": text})
            content = content_parts
            budget -= text_len
        else:
            content = _trim_middle(str(raw_content or ""), per_message_limit)
            budget -= len(content)
        if content:
            result.append({"role": str(message.get("role") or "user"), "content": content})
    return result


def _message_from_response_item(item: dict[str, Any]) -> dict[str, Any] | None:
    item_type = str(item.get("type") or "").strip()
    if item_type == "message" or item.get("role"):
        role = str(item.get("role") or "user").strip() or "user"
        content = _content_for_backend(item.get("content"))
        return {"role": role, "content": content} if content else None
    if item_type == "function_call_output":
        return {"role": "user", "content": input_item_text(item)}
    if item_type == "function_call":
        return {"role": "assistant", "content": input_item_text(item)}
    if _is_response_content_part(item):
        content = _content_for_backend([item])
        return {"role": "user", "content": content} if content else None
    return None


def previous_messages_from_body(body: dict[str, Any]) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    input_items = body.get("_previous_input_items")
    if isinstance(input_items, list):
        for item in input_items:
            if isinstance(item, dict):
                message = _message_from_response_item(item)
                if message:
                    messages.append(message)
    previous_response = body.get("_previous_response")
    if isinstance(previous_response, dict):
        output = previous_response.get("output")
        if isinstance(output, list):
            for item in output:
                if isinstance(item, dict):
                    message = _message_from_response_item(item)
                    if message:
                        messages.append(message)
    return messages


def extract_response_image(input_value: object) -> tuple[bytes, str] | None:
    if isinstance(input_value, dict):
        images = extract_image_from_message_content(input_value.get("content"))
        return images[0] if images else None
    if not isinstance(input_value, list):
        return None
    for item in reversed(input_value):
        if isinstance(item, dict) and str(item.get("type") or "").strip() == "input_image":
            image_url = str(item.get("image_url") or "")
            if image_url.startswith("data:"):
                header, _, data = image_url.partition(",")
                mime = header.split(";")[0].removeprefix("data:")
                return base64.b64decode(data), mime or "image/png"
        if isinstance(item, dict):
            images = extract_image_from_message_content(item.get("content"))
            if images:
                return images[0]
    return None


def _input_image_parts(input_value: object) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    if isinstance(input_value, dict):
        content = input_value.get("content")
        if isinstance(content, list):
            parts.extend(item for item in content if isinstance(item, dict))
        return parts
    if not isinstance(input_value, list):
        return parts
    if all(isinstance(item, dict) and item.get("type") for item in input_value):
        return [item for item in input_value if isinstance(item, dict)]
    for item in input_value:
        if isinstance(item, dict):
            content = item.get("content")
            if isinstance(content, list):
                parts.extend(part for part in content if isinstance(part, dict))
    return parts


def messages_from_input(input_value: object, instructions: object = None) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    system_text = str(instructions or "").strip()
    if system_text:
        messages.append({"role": "system", "content": system_text})
    if isinstance(input_value, str):
        if input_value.strip():
            messages.append({"role": "user", "content": input_value.strip()})
        return messages
    if isinstance(input_value, dict):
        message = _message_from_response_item(input_value)
        if message:
            messages.append(message)
        return messages
    if isinstance(input_value, list):
        if all(isinstance(item, dict) and _is_response_content_part(item) for item in input_value):
            content = _content_for_backend(input_value)
            if content:
                messages.append({"role": "user", "content": content})
            return messages
        for item in input_value:
            if isinstance(item, dict):
                message = _message_from_response_item(item)
                if message:
                    messages.append(message)
    return messages


def input_item_text(item: dict[str, Any]) -> str:
    item_type = str(item.get("type") or "").strip()
    if item_type == "function_call_output":
        call_id = str(item.get("call_id") or "").strip()
        output = item.get("output")
        if not isinstance(output, str):
            output = json.dumps(output, ensure_ascii=False)
        return f"Tool output for call_id {call_id}:\n{output}"
    if item_type == "function_call":
        return f"Previous tool call {item.get('name')}: {item.get('arguments')}"
    if item_type == "input_image":
        return "[input_image attached]"
    if item_type and item_type not in {"message", "input_text", "output_text"}:
        return json.dumps(item, ensure_ascii=False)
    return extract_response_prompt([item]) or _content_text(item.get("content"))


def _tool_name(tool: dict[str, Any]) -> str:
    function = tool.get("function") if isinstance(tool.get("function"), dict) else {}
    name = str(tool.get("name") or function.get("name") or "").strip()
    if name:
        return name
    tool_type = str(tool.get("type") or "").strip()
    return tool_type if tool_type and tool_type != "function" else ""


def _tool_identity(tool: dict[str, Any]) -> str:
    function = tool.get("function") if isinstance(tool.get("function"), dict) else {}
    values = [
        tool.get("type"),
        tool.get("name"),
        function.get("name"),
        tool.get("description"),
        function.get("description"),
    ]
    return " ".join(str(value or "") for value in values).strip().lower()


def _tool_parameters(tool: dict[str, Any]) -> dict[str, Any]:
    function = tool.get("function") if isinstance(tool.get("function"), dict) else {}
    parameters = tool.get("parameters") if isinstance(tool.get("parameters"), dict) else function.get("parameters")
    return parameters if isinstance(parameters, dict) else {}


def _find_shell_tool(tools: list[dict[str, Any]]) -> dict[str, Any] | None:
    named_tools = [(tool, _tool_name(tool).lower(), _tool_identity(tool)) for tool in tools if isinstance(tool, dict)]
    for tool, name, identity in named_tools:
        if name in {"shell", "shell_command", "exec_command", "run_command", "terminal", "local_shell"}:
            return tool
        if str(tool.get("type") or "").strip() in {"local_shell", "shell"}:
            return tool
        if "local_shell" in identity:
            return tool
    for tool, name, identity in named_tools:
        if any(hint in name or hint in identity for hint in SHELL_TOOL_NAME_HINTS):
            return tool
    return None


def _extract_fenced_command(text: str) -> str:
    for match in FENCED_COMMAND_RE.finditer(str(text or "")):
        lines: list[str] = []
        for raw_line in match.group(1).splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("$ "):
                line = line[2:].strip()
            if line.lower() in {"powershell", "bash", "sh", "cmd"}:
                continue
            lines.append(line)
        command = "\n".join(lines).strip()
        if command:
            return command
    return ""


def _tool_argument_for_command(tool: dict[str, Any], command: str) -> dict[str, Any]:
    parameters = _tool_parameters(tool)
    properties = parameters.get("properties") if isinstance(parameters.get("properties"), dict) else {}
    prop_names = {str(key) for key in properties.keys()}
    if "command" in prop_names or not prop_names:
        return {"command": command}
    if "cmd" in prop_names:
        return {"cmd": command}
    if "script" in prop_names:
        return {"script": command}
    if "input" in prop_names:
        return {"input": command}
    if "args" in prop_names:
        return {"args": [command]}
    first = next(iter(prop_names), "command")
    return {first: command}


def _latest_user_text(messages: list[dict[str, Any]] | None) -> str:
    if not messages:
        return ""
    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        if str(message.get("role") or "").strip() != "user":
            continue
        content = message.get("content")
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, dict):
                    parts.append(str(part.get("text") or ""))
                elif isinstance(part, str):
                    parts.append(part)
            return "\n".join(part for part in parts if part).strip()
        return str(content or "").strip()
    return ""


def _user_texts(messages: list[dict[str, Any]] | None) -> list[str]:
    if not messages:
        return []
    texts: list[str] = []
    for message in messages:
        if not isinstance(message, dict):
            continue
        if str(message.get("role") or "").strip() != "user":
            continue
        content = message.get("content")
        if isinstance(content, list):
            parts = []
            for part in content:
                if isinstance(part, dict):
                    parts.append(str(part.get("text") or ""))
                elif isinstance(part, str):
                    parts.append(part)
            text = "\n".join(part for part in parts if part).strip()
        else:
            text = str(content or "").strip()
        if text:
            texts.append(text)
    return texts


def _has_tool_output(messages: list[dict[str, Any]] | None) -> bool:
    if not messages:
        return False
    return any(
        isinstance(message, dict)
        and "Tool output for call_id" in str(message.get("content") or "")
        for message in messages
    )


def _is_kickoff_text(text: str) -> bool:
    value = str(text or "").strip()
    if not value:
        return False
    kickoff_words = ("开始", "开始吧", "继续", "继续执行", "接着", "直接执行", "直接开始", "别问", "不要问", "不需要问")
    return any(value == word or value.startswith(f"{word}，") or value.startswith(f"{word},") or value.startswith(f"{word} ") for word in kickoff_words)


def _fallback_tool_call_from_text(text: str, tools: list[dict[str, Any]], messages: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    shell_tool = _find_shell_tool(tools)
    if not shell_tool:
        return None
    command = _extract_fenced_command(text)
    if command:
        return {
            "type": "function_call",
            "name": _tool_name(shell_tool),
            "arguments": _tool_argument_for_command(shell_tool, command),
        }
    latest_user = _latest_user_text(messages)
    user_text = "\n".join(_user_texts(messages))
    asks_for_confirmation = CLARIFICATION_REQUEST_RE.search(text) is not None
    should_start = bool(latest_user and ACTION_REQUEST_RE.search(latest_user))
    should_recover_from_question = bool(asks_for_confirmation and ACTION_REQUEST_RE.search(user_text))
    if should_start and (not _has_tool_output(messages) or latest_user.strip() in {"开始", "继续", "继续执行", "接着", "直接执行"}):
        return {
            "type": "function_call",
            "name": _tool_name(shell_tool),
            "arguments": _tool_argument_for_command(shell_tool, _initial_codex_command(user_text or latest_user)),
        }
    if should_recover_from_question:
        return {
            "type": "function_call",
            "name": _tool_name(shell_tool),
            "arguments": _tool_argument_for_command(shell_tool, _initial_codex_command(user_text)),
        }
    return None


def _initial_codex_command(task_text: str) -> str:
    text = str(task_text or "").lower()
    if any(keyword in text for keyword in ["upstream", "release", "github", "上游", "同步", "升级", "版本"]):
        return "git status --short; git branch --show-current; git remote -v; git log --oneline --decorate --max-count=8"
    if any(keyword in text for keyword in ["push", "推送", "提交", "commit"]):
        return "git status --short; git branch --show-current; git log --oneline --decorate --max-count=5"
    return "git status --short; git branch --show-current; rg --files | Select-Object -First 80"


def _forced_initial_tool_call(tools: list[dict[str, Any]], messages: list[dict[str, Any]]) -> dict[str, Any] | None:
    shell_tool = _find_shell_tool(tools)
    if not shell_tool:
        return None
    latest_user = _latest_user_text(messages)
    if not latest_user:
        return None
    user_text = "\n".join(_user_texts(messages))
    if not _is_kickoff_text(latest_user):
        return None
    if _has_tool_output(messages) and not _is_kickoff_text(latest_user):
        return None
    return {
        "type": "function_call",
        "name": _tool_name(shell_tool),
        "arguments": _tool_argument_for_command(shell_tool, _initial_codex_command(user_text or latest_user)),
    }


def tool_messages_from_body(body: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    model = str(body.get("model") or "auto").strip() or "auto"
    instructions = str(body.get("instructions") or "").strip()
    tools = response_function_tools(body)
    tool_choice = body.get("tool_choice")
    tool_prompt = TOOL_CALL_SYSTEM_MESSAGE
    if tools:
        tool_prompt += "\n\nAvailable tools JSON:\n" + json.dumps(tools, ensure_ascii=False)
    if tool_choice:
        tool_prompt += "\n\nRequested tool_choice JSON:\n" + json.dumps(tool_choice, ensure_ascii=False)
    messages: list[dict[str, Any]] = [{"role": "system", "content": tool_prompt}]
    if instructions:
        messages.append({"role": "system", "content": instructions})
    messages.extend(previous_messages_from_body(body))

    input_value = body.get("input")
    if isinstance(input_value, str):
        messages.append({"role": "user", "content": input_value})
    elif isinstance(input_value, dict):
        message = _message_from_response_item(input_value)
        if message:
            messages.append(message)
    elif isinstance(input_value, list):
        if all(isinstance(item, dict) and _is_response_content_part(item) for item in input_value):
            content = _content_for_backend(input_value)
            if content:
                messages.append({"role": "user", "content": content})
        else:
            for item in input_value:
                if not isinstance(item, dict):
                    continue
                message = _message_from_response_item(item)
                if message:
                    messages.append(message)
    return model, compact_messages_for_upstream(normalize_text_messages(messages))


def text_output_item(text: str, item_id: str | None = None, status: str = "completed") -> dict[str, Any]:
    return {
        "id": item_id or f"msg_{uuid.uuid4().hex}",
        "type": "message",
        "status": status,
        "role": "assistant",
        "content": [{"type": "output_text", "text": text, "annotations": []}],
    }


def function_call_item(name: str, arguments: object, item_id: str | None = None, call_id: str | None = None) -> dict[str, Any]:
    args = arguments if isinstance(arguments, str) else json.dumps(arguments if isinstance(arguments, dict) else {}, ensure_ascii=False)
    return {
        "id": item_id or f"fc_{uuid.uuid4().hex}",
        "type": "function_call",
        "status": "completed",
        "call_id": call_id or f"call_{uuid.uuid4().hex}",
        "name": name,
        "arguments": args,
    }


def extract_json_object(text: str) -> dict[str, Any] | None:
    value = str(text or "").strip()
    if not value:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", value, flags=re.DOTALL)
    candidates = [fenced.group(1)] if fenced else []
    if value.startswith("{") and value.endswith("}"):
        candidates.append(value)
    first = value.find("{")
    last = value.rfind("}")
    if first >= 0 and last > first:
        candidates.append(value[first : last + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def parse_tool_or_message(text: str, tools: list[dict[str, Any]], messages: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    parsed = extract_json_object(text)
    if not parsed:
        fallback = _fallback_tool_call_from_text(text, tools, messages)
        return fallback or {"type": "message", "content": text}
    parsed_type = str(parsed.get("type") or parsed.get("kind") or "").strip()
    name = str(parsed.get("name") or parsed.get("tool") or parsed.get("function") or "").strip()
    tool_names = {
        str(tool.get("name") or (tool.get("function") or {}).get("name") or "").strip()
        for tool in tools
        if isinstance(tool, dict)
    }
    if parsed_type == "function_call" or (name and (not tool_names or name in tool_names)):
        arguments = parsed.get("arguments")
        if arguments is None:
            arguments = parsed.get("args")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except Exception:
                arguments = {"input": arguments}
        if not isinstance(arguments, dict):
            arguments = {}
        return {"type": "function_call", "name": name, "arguments": arguments}
    if parsed_type == "message" and isinstance(parsed.get("content"), str):
        return {"type": "message", "content": parsed["content"]}
    fallback = _fallback_tool_call_from_text(text, tools, messages)
    return fallback or {"type": "message", "content": text}


def image_output_items(prompt: str, data: list[dict[str, Any]], item_id: str | None = None) -> list[dict[str, Any]]:
    output = []
    for item in data:
        b64_json = str(item.get("b64_json") or "").strip()
        if b64_json:
            output.append({
                "id": item_id or f"ig_{len(output) + 1}",
                "type": "image_generation_call",
                "status": "completed",
                "result": b64_json,
                "revised_prompt": str(item.get("revised_prompt") or prompt).strip() or prompt,
            })
    return output


def response_output_text(output: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if isinstance(part, dict) and str(part.get("type") or "") == "output_text":
                text = str(part.get("text") or "")
                if text:
                    parts.append(text)
    return "".join(parts)


def response_created(response_id: str, model: str, created: int) -> dict[str, Any]:
    return {
        "type": "response.created",
        "response": {
            "id": response_id,
            "object": "response",
            "created_at": created,
            "status": "in_progress",
            "error": None,
            "incomplete_details": None,
            "model": model,
            "output": [],
            "output_text": "",
            "parallel_tool_calls": False,
            "metadata": {},
            "tool_choice": "auto",
            "tools": [],
        },
    }


def response_completed(
    response_id: str,
    model: str,
    created: int,
    output: list[dict[str, Any]],
    usage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    response = {
        "type": "response.completed",
        "response": {
            "id": response_id,
            "object": "response",
            "created_at": created,
            "status": "completed",
            "error": None,
            "incomplete_details": None,
            "model": model,
            "output": output,
            "output_text": response_output_text(output),
            "parallel_tool_calls": False,
            "metadata": {},
            "tool_choice": "auto",
            "tools": [],
        },
    }
    if usage:
        response["response"]["usage"] = usage
    return response


def text_response_parts(body: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    if is_function_tool_request(body):
        return tool_messages_from_body(body)
    model = str(body.get("model") or "auto").strip() or "auto"
    current_messages = messages_from_input(body.get("input"), body.get("instructions"))
    previous_messages = previous_messages_from_body(body)
    if current_messages and current_messages[0].get("role") == "system":
        messages = [current_messages[0], *previous_messages, *current_messages[1:]]
    else:
        messages = [*previous_messages, *current_messages]
    messages = compact_messages_for_upstream(normalize_text_messages(messages))
    return model, messages


def stream_text_response(backend, body: dict[str, Any], messages: list[dict[str, Any]] | None = None) -> Iterator[dict[str, Any]]:
    model = str(body.get("model") or "auto").strip() or "auto"
    messages = messages if messages is not None else messages_from_input(body.get("input"), body.get("instructions"))
    response_id = f"resp_{uuid.uuid4().hex}"
    item_id = f"msg_{uuid.uuid4().hex}"
    created = int(time.time())
    full_text = ""
    yield response_created(response_id, model, created)
    yield {"type": "response.output_item.added", "output_index": 0, "item": {**text_output_item("", item_id, "in_progress"), "content": []}}
    yield {
        "type": "response.content_part.added",
        "item_id": item_id,
        "output_index": 0,
        "content_index": 0,
        "part": {"type": "output_text", "text": "", "annotations": []},
    }
    request = ConversationRequest(model=model, messages=messages)
    for delta in stream_text_deltas(backend, request):
        full_text += delta
        yield {"type": "response.output_text.delta", "item_id": item_id, "output_index": 0, "content_index": 0, "delta": delta}
    yield {"type": "response.output_text.done", "item_id": item_id, "output_index": 0, "content_index": 0, "text": full_text}
    yield {
        "type": "response.content_part.done",
        "item_id": item_id,
        "output_index": 0,
        "content_index": 0,
        "part": {"type": "output_text", "text": full_text, "annotations": []},
    }
    item = text_output_item(full_text, item_id, "completed")
    yield {"type": "response.output_item.done", "output_index": 0, "item": item}
    usage = token_usage(
        input_text_tokens=count_message_text_tokens(messages, model),
        output_text_tokens=count_text_tokens(full_text, model),
    )
    yield response_completed(response_id, model, created, [item], usage)


def stream_tool_response(backend, body: dict[str, Any], messages: list[dict[str, Any]] | None = None) -> Iterator[dict[str, Any]]:
    model = str(body.get("model") or "auto").strip() or "auto"
    tools = response_function_tools(body)
    messages = messages if messages is not None else tool_messages_from_body(body)[1]
    response_id = f"resp_{uuid.uuid4().hex}"
    created = int(time.time())
    full_text = ""
    yield response_created(response_id, model, created)
    request = ConversationRequest(model=model, messages=messages)
    for delta in stream_text_deltas(backend, request):
        full_text += delta
    parsed = parse_tool_or_message(full_text, tools, messages)
    if parsed["type"] == "function_call":
        item = function_call_item(str(parsed.get("name") or ""), parsed.get("arguments") or {})
        yield {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "arguments": ""}}
        yield {
            "type": "response.function_call_arguments.delta",
            "item_id": item["id"],
            "output_index": 0,
            "delta": item["arguments"],
        }
        yield {
            "type": "response.function_call_arguments.done",
            "item_id": item["id"],
            "output_index": 0,
            "arguments": item["arguments"],
        }
        yield {"type": "response.output_item.done", "output_index": 0, "item": item}
        usage = token_usage(
            input_text_tokens=count_message_text_tokens(messages, model),
            output_text_tokens=count_text_tokens(item["arguments"], model),
        )
        yield response_completed(response_id, model, created, [item], usage)
        return

    text = str(parsed.get("content") or full_text)
    item = text_output_item(text)
    yield {"type": "response.output_item.added", "output_index": 0, "item": {**text_output_item("", item["id"], "in_progress"), "content": []}}
    yield {
        "type": "response.content_part.added",
        "item_id": item["id"],
        "output_index": 0,
        "content_index": 0,
        "part": {"type": "output_text", "text": "", "annotations": []},
    }
    yield {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": text}
    yield {"type": "response.output_text.done", "item_id": item["id"], "output_index": 0, "content_index": 0, "text": text}
    yield {
        "type": "response.content_part.done",
        "item_id": item["id"],
        "output_index": 0,
        "content_index": 0,
        "part": {"type": "output_text", "text": text, "annotations": []},
    }
    yield {"type": "response.output_item.done", "output_index": 0, "item": item}
    usage = token_usage(
        input_text_tokens=count_message_text_tokens(messages, model),
        output_text_tokens=count_text_tokens(text, model),
    )
    yield response_completed(response_id, model, created, [item], usage)


def stream_image_response(
    image_outputs: Iterable[ImageOutput],
    prompt: str,
    model: str,
    input_image_tokens: int = 0,
    size: object = None,
    quality: str = "auto",
) -> Iterator[dict[str, Any]]:
    response_id = f"resp_{uuid.uuid4().hex}"
    created = int(time.time())
    yield response_created(response_id, model, created)
    for output in image_outputs:
        if output.kind == "message":
            text = output.text
            item = text_output_item(text)
            usage = token_usage(
                input_text_tokens=count_text_tokens(prompt, model),
                input_image_tokens=input_image_tokens,
                output_text_tokens=count_text_tokens(text, model),
            )
            yield {"type": "response.output_item.added", "output_index": 0, "item": {**text_output_item("", item["id"], "in_progress"), "content": []}}
            yield {
                "type": "response.content_part.added",
                "item_id": item["id"],
                "output_index": 0,
                "content_index": 0,
                "part": {"type": "output_text", "text": "", "annotations": []},
            }
            yield {"type": "response.output_text.delta", "item_id": item["id"], "output_index": 0, "content_index": 0, "delta": text}
            yield {"type": "response.output_text.done", "item_id": item["id"], "output_index": 0, "content_index": 0, "text": text}
            yield {
                "type": "response.content_part.done",
                "item_id": item["id"],
                "output_index": 0,
                "content_index": 0,
                "part": {"type": "output_text", "text": text, "annotations": []},
            }
            yield {"type": "response.output_item.done", "output_index": 0, "item": item}
            yield response_completed(response_id, model, created, [item], usage)
            return
        if output.kind != "result":
            continue
        items = image_output_items(prompt, output.data)
        if items:
            item = items[0]
            usage = image_usage(
                input_text_tokens=count_text_tokens(prompt, model),
                input_image_tokens=input_image_tokens,
                output_tokens=count_image_output_items_tokens(output.data, size, quality),
            )
            yield {"type": "response.output_item.done", "output_index": 0, "item": item}
            yield response_completed(response_id, model, created, [item], usage)
            return
    raise RuntimeError("image generation failed")


def collect_response(events: Iterable[dict[str, Any]]) -> dict[str, Any]:
    completed = {}
    for event in events:
        if event.get("type") == "response.completed":
            completed = event.get("response") if isinstance(event.get("response"), dict) else {}
    if not completed:
        raise RuntimeError("response generation failed")
    return completed


def response_events(body: dict[str, Any]) -> Iterator[dict[str, Any]]:
    if is_function_tool_request(body):
        model, messages = tool_messages_from_body(body)
        key = cache_key(body, messages, stream=bool(body.get("stream")))
        tools = response_function_tools(body)
        forced_tool_call = _forced_initial_tool_call(tools, messages)
        if forced_tool_call is not None:
            if body.get("stream"):
                response_id = f"resp_{uuid.uuid4().hex}"
                created = int(time.time())
                item = function_call_item(str(forced_tool_call.get("name") or ""), forced_tool_call.get("arguments") or {})
                yield response_created(response_id, model, created)
                yield {"type": "response.output_item.added", "output_index": 0, "item": {**item, "status": "in_progress", "arguments": ""}}
                yield {"type": "response.function_call_arguments.delta", "item_id": item["id"], "output_index": 0, "delta": item["arguments"]}
                yield {"type": "response.function_call_arguments.done", "item_id": item["id"], "output_index": 0, "arguments": item["arguments"]}
                yield {"type": "response.output_item.done", "output_index": 0, "item": item}
                usage = token_usage(
                    input_text_tokens=count_message_text_tokens(messages, model),
                    output_text_tokens=count_text_tokens(item["arguments"], model),
                )
                yield response_completed(response_id, model, created, [item], usage)
                return
            item = function_call_item(str(forced_tool_call.get("name") or ""), forced_tool_call.get("arguments") or {})
            usage = token_usage(
                input_text_tokens=count_message_text_tokens(messages, model),
                output_text_tokens=count_text_tokens(item["arguments"], model),
            )
            yield response_completed(
                f"resp_{uuid.uuid4().hex}",
                model,
                int(time.time()),
                [item],
                usage,
            )
            return
        yield from chat_completion_cache.get_or_compute_stream(
            key,
            lambda: stream_tool_response(text_backend(), body, messages),
        )
        return

    if is_text_response_request(body):
        model, messages = text_response_parts(body)
        key = cache_key(body, messages, stream=bool(body.get("stream")))
        yield from chat_completion_cache.get_or_compute_stream(
            key,
            lambda: stream_text_response(text_backend(), body, messages),
        )
        return

    prompt = extract_response_prompt(body.get("input"))
    if not prompt:
        raise HTTPException(status_code=400, detail={"error": "input text is required"})
    model = str(body.get("model") or "gpt-image-2").strip() or "gpt-image-2"
    image_info = extract_response_image(body.get("input"))
    if image_info:
        image_data, mime_type = image_info
        images = encode_images([(image_data, "image.png", mime_type)])
    else:
        images = None
    input_image_tokens = count_image_content_tokens(_input_image_parts(body.get("input")), model)
    tool = response_image_tool(body)
    image_outputs = stream_image_outputs_with_pool(ConversationRequest(
        prompt=prompt,
        model=model,
        size=tool.get("size"),
        quality=str(tool.get("quality") or "auto"),
        response_format="b64_json",
        images=images,
    ))
    yield from stream_image_response(image_outputs, prompt, model, input_image_tokens, tool.get("size"), str(tool.get("quality") or "auto"))


def handle(body: dict[str, Any]) -> dict[str, Any] | Iterator[dict[str, Any]]:
    events = response_events(body)
    if body.get("stream"):
        return events
    return collect_response(events)
