from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from services.config import DATA_DIR
from services.persistent_store import read_json, write_json

CONVERSATIONS_FILE = DATA_DIR / "image_conversations.json"

_lock = threading.RLock()


def _clean(value: object) -> str:
    return str(value or "").strip()


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


def _normalize_conversation(item: dict[str, Any]) -> dict[str, Any]:
    conversation_id = _clean(item.get("id"))
    if not conversation_id:
        raise ValueError("conversation id is required")
    turns = item.get("turns")
    return {
        **item,
        "id": conversation_id,
        "title": _clean(item.get("title")),
        "createdAt": _clean(item.get("createdAt")),
        "updatedAt": _clean(item.get("updatedAt") or item.get("createdAt")),
        "turns": turns if isinstance(turns, list) else [],
    }


def _sort(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(items, key=lambda item: _clean(item.get("updatedAt")), reverse=True)


def list_conversations(owner_id: str) -> list[dict[str, Any]]:
    owner = _clean(owner_id) or "admin"
    with _lock:
        return _sort(_read_all().get(owner, []))


def replace_conversations(owner_id: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    owner = _clean(owner_id) or "admin"
    normalized = [_normalize_conversation(item) for item in items if isinstance(item, dict)]
    with _lock:
        data = _read_all()
        data[owner] = _sort(normalized)
        _write_all(data)
        return data[owner]


def upsert_conversation(owner_id: str, item: dict[str, Any]) -> dict[str, Any]:
    owner = _clean(owner_id) or "admin"
    normalized = _normalize_conversation(item)
    with _lock:
        data = _read_all()
        items = [conversation for conversation in data.get(owner, []) if conversation.get("id") != normalized["id"]]
        items.append(normalized)
        data[owner] = _sort(items)
        _write_all(data)
        return normalized


def rename_conversation(owner_id: str, conversation_id: str, title: str) -> dict[str, Any] | None:
    owner = _clean(owner_id) or "admin"
    target_id = _clean(conversation_id)
    with _lock:
        data = _read_all()
        items = []
        updated_item: dict[str, Any] | None = None
        for item in data.get(owner, []):
            if item.get("id") == target_id:
                updated_item = {**item, "title": _clean(title)}
                items.append(updated_item)
            else:
                items.append(item)
        data[owner] = _sort(items)
        _write_all(data)
        return updated_item


def delete_conversation(owner_id: str, conversation_id: str) -> None:
    owner = _clean(owner_id) or "admin"
    target_id = _clean(conversation_id)
    with _lock:
        data = _read_all()
        data[owner] = [item for item in data.get(owner, []) if item.get("id") != target_id]
        _write_all(data)


def clear_conversations(owner_id: str) -> None:
    owner = _clean(owner_id) or "admin"
    with _lock:
        data = _read_all()
        data[owner] = []
        _write_all(data)
