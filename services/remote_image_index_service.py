from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from services.config import DATA_DIR
from services.persistent_store import read_json, write_json

REMOTE_IMAGE_INDEX_FILE = DATA_DIR / "remote_images.json"
_lock = threading.RLock()


def _read() -> dict[str, dict[str, Any]]:
    data = read_json(REMOTE_IMAGE_INDEX_FILE.name, REMOTE_IMAGE_INDEX_FILE, {})
    return data if isinstance(data, dict) else {}


def _write(data: dict[str, dict[str, Any]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    write_json(REMOTE_IMAGE_INDEX_FILE.name, REMOTE_IMAGE_INDEX_FILE, data)


def upsert_remote_image(rel: str, item: dict[str, Any]) -> None:
    key = str(rel or "").strip().lstrip("/")
    if not key:
        return
    with _lock:
        data = _read()
        data[key] = {**item, "rel": key, "path": key}
        _write(data)


def remove_remote_images(rels: list[str]) -> None:
    keys = {str(rel or "").strip().lstrip("/") for rel in rels if str(rel or "").strip()}
    if not keys:
        return
    with _lock:
        data = _read()
        for key in keys:
            data.pop(key, None)
        _write(data)


def list_remote_images() -> list[dict[str, Any]]:
    with _lock:
        return list(_read().values())


def find_remote_image_by_url(url: str) -> dict[str, Any] | None:
    target = str(url or "").strip()
    if not target:
        return None
    with _lock:
        for item in _read().values():
            if target in {str(item.get("url") or "").strip(), str(item.get("thumbnail_url") or "").strip()}:
                return item
    return None


def find_remote_image_by_rel(rel: str) -> dict[str, Any] | None:
    key = str(rel or "").strip().lstrip("/")
    if not key:
        return None
    with _lock:
        item = _read().get(key)
        return dict(item) if isinstance(item, dict) else None
