from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from services.config import DATA_DIR
from services.persistent_store import read_json, write_json
from services.remote_image_index_service import find_remote_image_by_rel

OPS_FILE = DATA_DIR / "commerce_ops.json"
_lock = threading.RLock()


def _now() -> int:
    return int(time.time())


def _clean(value: object) -> str:
    return str(value or "").strip()


def _read() -> dict[str, Any]:
    data = read_json(OPS_FILE.name, OPS_FILE, {})
    return data if isinstance(data, dict) else {}


def _write(data: dict[str, Any]) -> None:
    write_json(OPS_FILE.name, OPS_FILE, data)


def _items(key: str) -> list[dict[str, Any]]:
    data = _read()
    value = data.get(key)
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _save_items(key: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    data = _read()
    data[key] = items
    _write(data)
    return items


def list_templates(*, include_hidden: bool = False) -> list[dict[str, Any]]:
    with _lock:
        items = _items("templates")
    normalized = []
    for item in items:
        hidden = bool(item.get("hidden"))
        if hidden and not include_hidden:
            continue
        normalized.append({
            "id": _clean(item.get("id")),
            "title": _clean(item.get("title")),
            "description": _clean(item.get("description")),
            "example_url": _clean(item.get("example_url")),
            "prompt": _clean(item.get("prompt")),
            "platform": _clean(item.get("platform")),
            "tool_url": _clean(item.get("tool_url")) or "/detail-page",
            "hidden": hidden,
            "sort": int(item.get("sort") or 0),
            "created_at": int(item.get("created_at") or 0),
            "updated_at": int(item.get("updated_at") or 0),
        })
    normalized.sort(key=lambda item: (item["sort"], -item["updated_at"]))
    return normalized


def save_template(payload: dict[str, Any]) -> dict[str, Any]:
    now = _now()
    item_id = _clean(payload.get("id")) or uuid.uuid4().hex
    item = {
        "id": item_id,
        "title": _clean(payload.get("title")) or "未命名模板",
        "description": _clean(payload.get("description")),
        "example_url": _clean(payload.get("example_url")),
        "prompt": _clean(payload.get("prompt")),
        "platform": _clean(payload.get("platform")),
        "tool_url": _clean(payload.get("tool_url")) or "/detail-page",
        "hidden": bool(payload.get("hidden")),
        "sort": int(payload.get("sort") or 0),
        "created_at": int(payload.get("created_at") or now),
        "updated_at": now,
    }
    with _lock:
        items = _items("templates")
        next_items = [old for old in items if _clean(old.get("id")) != item_id]
        next_items.append(item)
        _save_items("templates", next_items)
    return item


def delete_template(item_id: str) -> bool:
    target = _clean(item_id)
    if not target:
        return False
    with _lock:
        items = _items("templates")
        next_items = [item for item in items if _clean(item.get("id")) != target]
        _save_items("templates", next_items)
    return len(next_items) != len(items)


def list_home_cases(*, include_hidden: bool = False) -> list[dict[str, Any]]:
    with _lock:
        items = _items("home_cases")
    normalized = []
    for item in items:
        hidden = bool(item.get("hidden"))
        if hidden and not include_hidden:
            continue
        image_rel = _clean(item.get("image_rel"))
        remote = find_remote_image_by_rel(image_rel) if image_rel else None
        normalized.append({
            "id": _clean(item.get("id")),
            "title": _clean(item.get("title")),
            "image_url": _clean((remote or {}).get("url")) or _clean((remote or {}).get("thumbnail_url")) or _clean(item.get("image_url")),
            "image_rel": image_rel,
            "category": _clean(item.get("category")) or "默认",
            "hidden": hidden,
            "sort": int(item.get("sort") or 0),
            "created_at": int(item.get("created_at") or 0),
            "updated_at": int(item.get("updated_at") or 0),
        })
    normalized.sort(key=lambda item: (item["sort"], -item["updated_at"]))
    return normalized


def save_home_case(payload: dict[str, Any]) -> dict[str, Any]:
    now = _now()
    item_id = _clean(payload.get("id")) or uuid.uuid4().hex
    image_rel = _clean(payload.get("image_rel"))
    remote = find_remote_image_by_rel(image_rel) if image_rel else None
    item = {
        "id": item_id,
        "title": _clean(payload.get("title")) or "真实案例",
        "image_url": _clean((remote or {}).get("url")) or _clean((remote or {}).get("thumbnail_url")) or _clean(payload.get("image_url")),
        "image_rel": image_rel,
        "category": _clean(payload.get("category")) or "默认",
        "hidden": bool(payload.get("hidden")),
        "sort": int(payload.get("sort") or 0),
        "created_at": int(payload.get("created_at") or now),
        "updated_at": now,
    }
    with _lock:
        items = _items("home_cases")
        next_items = [old for old in items if _clean(old.get("id")) != item_id]
        next_items.append(item)
        _save_items("home_cases", next_items)
    return item


def delete_home_case(item_id: str) -> bool:
    target = _clean(item_id)
    if not target:
        return False
    with _lock:
        items = _items("home_cases")
        next_items = [item for item in items if _clean(item.get("id")) != target]
        _save_items("home_cases", next_items)
    return len(next_items) != len(items)


def list_feedback(owner_id: str = "") -> list[dict[str, Any]]:
    owner = _clean(owner_id)
    with _lock:
        items = _items("feedback")
    result = []
    for item in items:
        if owner and _clean(item.get("owner_id")) != owner:
            continue
        result.append(item)
    result.sort(key=lambda item: int(item.get("updated_at") or 0), reverse=True)
    return result


def save_feedback(owner_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    owner = _clean(owner_id) or "anonymous"
    image_rel = _clean(payload.get("image_rel"))
    if not image_rel:
        raise ValueError("image_rel is required")
    now = _now()
    item_id = f"{owner}:{image_rel}"
    item = {
        "id": item_id,
        "owner_id": owner,
        "image_rel": image_rel,
        "favorite": bool(payload.get("favorite")),
        "rating": max(0, min(5, int(payload.get("rating") or 0))),
        "note": _clean(payload.get("note")),
        "template_id": _clean(payload.get("template_id")),
        "created_at": int(payload.get("created_at") or now),
        "updated_at": now,
    }
    with _lock:
        items = _items("feedback")
        next_items = [old for old in items if _clean(old.get("id")) != item_id]
        next_items.append(item)
        _save_items("feedback", next_items)
    return item


def feedback_stats() -> dict[str, Any]:
    items = list_feedback()
    by_template: dict[str, dict[str, Any]] = {}
    for item in items:
        key = _clean(item.get("template_id")) or "未关联模板"
        bucket = by_template.setdefault(key, {"template_id": key, "count": 0, "favorite_count": 0, "rating_sum": 0})
        bucket["count"] += 1
        bucket["favorite_count"] += 1 if item.get("favorite") else 0
        bucket["rating_sum"] += int(item.get("rating") or 0)
    rows = []
    for bucket in by_template.values():
        count = max(1, int(bucket["count"]))
        rows.append({
            "template_id": bucket["template_id"],
            "count": bucket["count"],
            "favorite_count": bucket["favorite_count"],
            "avg_rating": round(float(bucket["rating_sum"]) / count, 2),
        })
    rows.sort(key=lambda item: (item["avg_rating"], item["favorite_count"], item["count"]), reverse=True)
    return {"items": rows, "total": len(items)}


def create_share(owner_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    now = _now()
    token = uuid.uuid4().hex
    image_rel = _clean(payload.get("image_rel"))
    remote = find_remote_image_by_rel(image_rel) if image_rel else None
    item = {
        "token": token,
        "owner_id": _clean(owner_id) or "anonymous",
        "image_rel": image_rel,
        "image_url": _clean((remote or {}).get("url")) or _clean((remote or {}).get("thumbnail_url")) or _clean(payload.get("image_url")),
        "title": _clean(payload.get("title")) or "图片分享",
        "prompt": _clean(payload.get("prompt")),
        "created_at": now,
    }
    with _lock:
        items = _items("shares")
        items.append(item)
        _save_items("shares", items)
    return item


def get_share(token: str) -> dict[str, Any] | None:
    target = _clean(token)
    if not target:
        return None
    with _lock:
        for item in _items("shares"):
            if _clean(item.get("token")) == target:
                result = dict(item)
                image_rel = _clean(result.get("image_rel"))
                remote = find_remote_image_by_rel(image_rel) if image_rel else None
                remote_url = _clean((remote or {}).get("url")) or _clean((remote or {}).get("thumbnail_url"))
                if remote_url:
                    result["image_url"] = remote_url
                return result
    return None


def get_onboarding(owner_id: str) -> dict[str, Any]:
    owner = _clean(owner_id) or "anonymous"
    data = _read()
    source = data.get("onboarding") if isinstance(data.get("onboarding"), dict) else {}
    item = source.get(owner) if isinstance(source.get(owner), dict) else {}
    return {"dismissed": bool(item.get("dismissed")), "owner_id": owner}


def save_onboarding(owner_id: str, dismissed: bool) -> dict[str, Any]:
    owner = _clean(owner_id) or "anonymous"
    with _lock:
        data = _read()
        source = data.get("onboarding") if isinstance(data.get("onboarding"), dict) else {}
        source[owner] = {"dismissed": bool(dismissed), "updated_at": _now()}
        data["onboarding"] = source
        _write(data)
    return get_onboarding(owner)
