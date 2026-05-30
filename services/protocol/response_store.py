from __future__ import annotations

import copy
import time
from typing import Any

from fastapi import HTTPException

MAX_STORED_RESPONSES = 500
RESPONSE_TTL_SECONDS = 24 * 60 * 60
CONTENT_PART_TYPES = {"input_text", "input_image", "input_file"}

_responses: dict[str, dict[str, Any]] = {}


def _owner_id(identity: dict[str, object]) -> str:
    return str(identity.get("id") or "anonymous").strip() or "anonymous"


def _key(owner_id: str, response_id: str) -> str:
    return f"{owner_id}:{response_id}"


def _now() -> float:
    return time.time()


def _prune() -> None:
    now = _now()
    expired = [key for key, item in _responses.items() if float(item.get("expires_at") or 0) <= now]
    for key in expired:
        _responses.pop(key, None)
    while len(_responses) > MAX_STORED_RESPONSES:
        oldest = min(_responses, key=lambda key: float(_responses[key].get("created_at") or 0))
        _responses.pop(oldest, None)


def _content_to_input_parts(content: object) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "input_text", "text": content}]
    if isinstance(content, list):
        parts: list[dict[str, Any]] = []
        for part in content:
            if isinstance(part, str):
                parts.append({"type": "input_text", "text": part})
            elif isinstance(part, dict):
                part_type = str(part.get("type") or "")
                if part_type == "text":
                    parts.append({"type": "input_text", "text": str(part.get("text") or "")})
                elif part_type in {"input_text", "input_image", "input_file"}:
                    parts.append(copy.deepcopy(part))
        return parts
    return [{"type": "input_text", "text": str(content or "")}]


def input_to_items(input_value: object) -> list[dict[str, Any]]:
    if isinstance(input_value, str):
        return [{
            "id": "msg_input_0",
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": input_value}],
        }]
    if isinstance(input_value, dict):
        item_type = str(input_value.get("type") or "message")
        if item_type in {"function_call", "function_call_output"}:
            copied = copy.deepcopy(input_value)
            copied["id"] = str(copied.get("id") or f"{item_type}_input_0")
            return [copied]
        return [{
            "id": str(input_value.get("id") or "msg_input_0"),
            "type": item_type,
            "role": str(input_value.get("role") or "user"),
            "content": _content_to_input_parts(input_value.get("content")),
        }]
    if isinstance(input_value, list):
        if all(isinstance(item, dict) and str(item.get("type") or "") in CONTENT_PART_TYPES for item in input_value):
            return [{
                "id": "msg_input_0",
                "type": "message",
                "role": "user",
                "content": _content_to_input_parts(input_value),
            }]
        items: list[dict[str, Any]] = []
        for index, item in enumerate(input_value):
            if not isinstance(item, dict):
                continue
            item_type = str(item.get("type") or "message")
            if item_type in {"function_call", "function_call_output"}:
                copied = copy.deepcopy(item)
                copied["id"] = str(copied.get("id") or f"{item_type}_input_{index}")
                items.append(copied)
                continue
            items.append({
                "id": str(item.get("id") or f"msg_input_{index}"),
                "type": item_type,
                "role": str(item.get("role") or "user"),
                "content": _content_to_input_parts(item.get("content")),
            })
        return items
    return []


def store_response(
    identity: dict[str, object],
    response: dict[str, Any],
    input_value: object,
    previous_context_items: list[dict[str, Any]] | None = None,
) -> None:
    response_id = str(response.get("id") or "").strip()
    if not response_id:
        return
    _prune()
    owner_id = _owner_id(identity)
    input_items = input_to_items(input_value)
    if not isinstance(previous_context_items, list):
        previous_context_items = []
    output_items = response.get("output")
    if not isinstance(output_items, list):
        output_items = []
    context_items = [
        *copy.deepcopy(previous_context_items),
        *copy.deepcopy(input_items),
        *copy.deepcopy(output_items),
    ]
    _responses[_key(owner_id, response_id)] = {
        "created_at": _now(),
        "expires_at": _now() + RESPONSE_TTL_SECONDS,
        "response": copy.deepcopy(response),
        "input_items": input_items,
        "context_items": context_items,
    }


def get_response(identity: dict[str, object], response_id: str) -> dict[str, Any]:
    _prune()
    item = _responses.get(_key(_owner_id(identity), response_id))
    if not item:
        raise HTTPException(status_code=404, detail={"error": "response not found"})
    return copy.deepcopy(item["response"])


def get_context_items(identity: dict[str, object], response_id: str) -> list[dict[str, Any]]:
    _prune()
    item = _responses.get(_key(_owner_id(identity), response_id))
    if not item:
        raise HTTPException(status_code=404, detail={"error": "response not found"})
    context_items = item.get("context_items")
    if isinstance(context_items, list):
        return copy.deepcopy(context_items)
    data = []
    input_items = item.get("input_items")
    if isinstance(input_items, list):
        data.extend(copy.deepcopy(input_items))
    response = item.get("response")
    if isinstance(response, dict) and isinstance(response.get("output"), list):
        data.extend(copy.deepcopy(response["output"]))
    return data


def delete_response(identity: dict[str, object], response_id: str) -> dict[str, Any]:
    _prune()
    existed = _responses.pop(_key(_owner_id(identity), response_id), None) is not None
    return {"id": response_id, "object": "response.deleted", "deleted": existed}


def update_response_status(identity: dict[str, object], response_id: str, status: str) -> dict[str, Any]:
    _prune()
    item = _responses.get(_key(_owner_id(identity), response_id))
    if not item:
        raise HTTPException(status_code=404, detail={"error": "response not found"})
    response = copy.deepcopy(item["response"])
    response["status"] = status
    item["response"] = copy.deepcopy(response)
    return response


def list_input_items(
    identity: dict[str, object],
    response_id: str,
    *,
    limit: int = 20,
    order: str = "desc",
    after: str = "",
) -> dict[str, Any]:
    _prune()
    item = _responses.get(_key(_owner_id(identity), response_id))
    if not item:
        raise HTTPException(status_code=404, detail={"error": "response not found"})
    data = copy.deepcopy(item.get("input_items") or [])
    if order == "asc":
        ordered = data
    else:
        ordered = list(reversed(data))
    if after:
        after_index = next((index for index, row in enumerate(ordered) if str(row.get("id") or "") == after), -1)
        if after_index >= 0:
            ordered = ordered[after_index + 1 :]
    limit = max(1, min(100, int(limit or 20)))
    page = ordered[:limit]
    return {
        "object": "list",
        "data": page,
        "first_id": str(page[0].get("id") or "") if page else None,
        "last_id": str(page[-1].get("id") or "") if page else None,
        "has_more": len(ordered) > limit,
    }
