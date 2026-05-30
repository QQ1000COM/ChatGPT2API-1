from __future__ import annotations

import json
import re
import threading
from pathlib import Path
from typing import Any

from services.config import DATA_DIR
from services.persistent_store import read_json, write_json

CONVERSATIONS_FILE = DATA_DIR / "image_conversations.json"
CONVERSATIONS_DIR = DATA_DIR / "image_conversations"

_lock = threading.RLock()


def _clean(value: object) -> str:
    return str(value or "").strip()


def _owner_file(owner_id: str) -> Path:
    owner = _clean(owner_id) or "admin"
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", owner).strip("._") or "admin"
    return CONVERSATIONS_DIR / f"{safe}.json"


def _read_owner(owner_id: str) -> list[dict[str, Any]]:
    path = _owner_file(owner_id)
    if path.exists():
        data = read_json(f"image_conversations/{path.name}", path, [])
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []
    legacy = _read_all()
    items = legacy.get(_clean(owner_id) or "admin", [])
    if items:
        _write_owner(owner_id, items)
    return items


def _write_owner(owner_id: str, items: list[dict[str, Any]]) -> None:
    CONVERSATIONS_DIR.mkdir(parents=True, exist_ok=True)
    path = _owner_file(owner_id)
    write_json(f"image_conversations/{path.name}", path, items)


def _read_all() -> dict[str, list[dict[str, Any]]]:
    data = read_json(CONVERSATIONS_FILE.name, CONVERSATIONS_FILE, {})
    if not isinstance(data, dict):
        return {}
    result: dict[str, list[dict[str, Any]]] = {}
    for owner_id, items in data.items():
        if not isinstance(items, list):
            continue
        result[str(owner_id)] = [item for item in items if isinstance(item, dict)]
    return result


def _write_all(data: dict[str, list[dict[str, Any]]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    write_json(CONVERSATIONS_FILE.name, CONVERSATIONS_FILE, data)


def _compact_reference_image(image: Any) -> dict[str, Any] | None:
    if not isinstance(image, dict):
        return None
    data_url = _clean(image.get("dataUrl"))
    return {
        "name": _clean(image.get("name")) or "reference.png",
        "type": _clean(image.get("type")) or "image/png",
        "dataUrl": data_url if len(data_url) <= 512 else "",
    }


def _compact_result_image(image: Any) -> dict[str, Any] | None:
    if not isinstance(image, dict):
        return None
    item = dict(image)
    if _clean(item.get("url")):
        item.pop("b64_json", None)
    return item


def _normalize_conversation(item: dict[str, Any]) -> dict[str, Any]:
    conversation_id = _clean(item.get("id"))
    if not conversation_id:
        raise ValueError("conversation id is required")
    turns = item.get("turns")
    normalized_turns: list[dict[str, Any]] = []
    if isinstance(turns, list):
        for turn in turns:
            if not isinstance(turn, dict):
                continue
            next_turn = dict(turn)
            refs = next_turn.get("referenceImages")
            if isinstance(refs, list):
                next_turn["referenceImages"] = [
                    ref for ref in (_compact_reference_image(ref) for ref in refs) if ref is not None
                ]
            images = next_turn.get("images")
            if isinstance(images, list):
                next_turn["images"] = [
                    image for image in (_compact_result_image(image) for image in images) if image is not None
                ]
            normalized_turns.append(next_turn)
    return {
        **item,
        "id": conversation_id,
        "title": _clean(item.get("title")),
        "createdAt": _clean(item.get("createdAt")),
        "updatedAt": _clean(item.get("updatedAt") or item.get("createdAt")),
        "turns": normalized_turns,
    }


def _summarize_turn(turn: dict[str, Any]) -> dict[str, Any]:
    images = turn.get("images") if isinstance(turn.get("images"), list) else []
    refs = turn.get("referenceImages") if isinstance(turn.get("referenceImages"), list) else []
    return {
        "id": _clean(turn.get("id")),
        "batchId": _clean(turn.get("batchId")) or None,
        "batchTitle": _clean(turn.get("batchTitle")) or None,
        "batchIndex": turn.get("batchIndex"),
        "prompt": _clean(turn.get("prompt")),
        "model": _clean(turn.get("model")),
        "mode": _clean(turn.get("mode")) or "generate",
        "count": int(turn.get("count") or len(images) or 1),
        "size": _clean(turn.get("size")),
        "createdAt": _clean(turn.get("createdAt")),
        "status": _clean(turn.get("status")) or "success",
        "error": _clean(turn.get("error")) or None,
        "promptDeleted": bool(turn.get("promptDeleted")),
        "resultsDeleted": bool(turn.get("resultsDeleted")),
        "referenceImages": [
            {
                "name": _clean(ref.get("name")) if isinstance(ref, dict) else "reference.png",
                "type": _clean(ref.get("type")) if isinstance(ref, dict) else "image/png",
                "dataUrl": "",
            }
            for ref in refs
            if isinstance(ref, dict)
        ],
        "images": [
            {
                "id": _clean(image.get("id")) or f"image-{index}",
                "taskId": _clean(image.get("taskId")) or None,
                "status": _clean(image.get("status")) or ("success" if _clean(image.get("url")) else "loading"),
                "url": _clean(image.get("url")) or None,
                "revised_prompt": _clean(image.get("revised_prompt")) or None,
                "error": _clean(image.get("error")) or None,
            }
            for index, image in enumerate(images)
            if isinstance(image, dict)
        ],
    }


def summarize_conversation(item: dict[str, Any]) -> dict[str, Any]:
    turns = item.get("turns") if isinstance(item.get("turns"), list) else []
    return {
        "id": _clean(item.get("id")),
        "title": _clean(item.get("title")),
        "createdAt": _clean(item.get("createdAt")),
        "updatedAt": _clean(item.get("updatedAt") or item.get("createdAt")),
        "turns": [_summarize_turn(turn) for turn in turns if isinstance(turn, dict)],
    }


def _sort(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(items, key=lambda item: _clean(item.get("updatedAt")), reverse=True)


def list_conversations(owner_id: str) -> list[dict[str, Any]]:
    owner = _clean(owner_id) or "admin"
    with _lock:
        return _sort(_read_owner(owner))


def list_conversation_summaries(owner_id: str) -> list[dict[str, Any]]:
    return [summarize_conversation(item) for item in list_conversations(owner_id)]


def get_conversation(owner_id: str, conversation_id: str) -> dict[str, Any] | None:
    owner = _clean(owner_id) or "admin"
    target_id = _clean(conversation_id)
    with _lock:
        for item in _read_owner(owner):
            if item.get("id") == target_id:
                return item
    return None


def replace_conversations(owner_id: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    owner = _clean(owner_id) or "admin"
    normalized = [_normalize_conversation(item) for item in items if isinstance(item, dict)]
    with _lock:
        next_items = _sort(normalized)
        _write_owner(owner, next_items)
        return next_items


def upsert_conversation(owner_id: str, item: dict[str, Any]) -> dict[str, Any]:
    owner = _clean(owner_id) or "admin"
    normalized = _normalize_conversation(item)
    with _lock:
        items = [conversation for conversation in _read_owner(owner) if conversation.get("id") != normalized["id"]]
        items.append(normalized)
        _write_owner(owner, _sort(items))
        return normalized


def rename_conversation(owner_id: str, conversation_id: str, title: str) -> dict[str, Any] | None:
    owner = _clean(owner_id) or "admin"
    target_id = _clean(conversation_id)
    with _lock:
        items = []
        updated_item: dict[str, Any] | None = None
        for item in _read_owner(owner):
            if item.get("id") == target_id:
                updated_item = {**item, "title": _clean(title)}
                items.append(updated_item)
            else:
                items.append(item)
        _write_owner(owner, _sort(items))
        return updated_item


def delete_conversation(owner_id: str, conversation_id: str) -> None:
    owner = _clean(owner_id) or "admin"
    target_id = _clean(conversation_id)
    with _lock:
        _write_owner(owner, [item for item in _read_owner(owner) if item.get("id") != target_id])


def clear_conversations(owner_id: str) -> None:
    owner = _clean(owner_id) or "admin"
    with _lock:
        _write_owner(owner, [])
