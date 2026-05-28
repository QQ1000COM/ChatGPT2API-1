from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path
from typing import Any

_engine = None
_engine_url = ""
_engine_lock = threading.Lock()


def _database_url() -> str:
    backend = str(os.getenv("STORAGE_BACKEND") or "").strip().lower()
    database_url = str(os.getenv("DATABASE_URL") or "").strip()
    if backend not in {"postgres", "postgresql", "database"} or not database_url:
        return ""
    if database_url.startswith("sqlite:"):
        return ""
    return database_url


def _enabled() -> bool:
    return bool(_database_url())


def _with_connection(callback):
    database_url = _database_url()
    if not database_url:
        return None
    try:
        from sqlalchemy import create_engine, text

        global _engine, _engine_url
        with _engine_lock:
            if _engine is None or _engine_url != database_url:
                if _engine is not None:
                    _engine.dispose()
                _engine = create_engine(database_url, pool_pre_ping=True)
                _engine_url = database_url
            engine = _engine
        with engine.begin() as connection:
            connection.execute(
                text(
                    "CREATE TABLE IF NOT EXISTS app_files ("
                    "key VARCHAR(255) PRIMARY KEY, "
                    "data TEXT NOT NULL)"
                )
            )
            return callback(connection, text)
    except Exception as exc:
        print(f"[persistent-store] database operation failed: {exc}", file=sys.stderr)
        return None


def read_text(key: str, path: Path) -> str:
    def _read(connection, text):
        row = connection.execute(
            text("SELECT data FROM app_files WHERE key = :key"),
            {"key": key},
        ).fetchone()
        return str(row[0]) if row else None

    if _enabled():
        value = _with_connection(_read)
        if isinstance(value, str):
            return value
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def write_text(key: str, path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")

    def _write(connection, text):
        connection.execute(
            text(
                "INSERT INTO app_files (key, data) VALUES (:key, :data) "
                "ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data"
            ),
            {"key": key, "data": value},
        )

    if _enabled():
        _with_connection(_write)


def append_line(key: str, path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as file:
        file.write(line)

    def _append(connection, text):
        connection.execute(
            text(
                "INSERT INTO app_files (key, data) VALUES (:key, :data) "
                "ON CONFLICT (key) DO UPDATE SET data = app_files.data || EXCLUDED.data"
            ),
            {"key": key, "data": line},
        )

    if _enabled():
        _with_connection(_append)


def read_json(key: str, path: Path, default: Any) -> Any:
    content = read_text(key, path)
    if not content:
        return default
    try:
        return json.loads(content)
    except Exception:
        return default


def write_json(key: str, path: Path, value: Any) -> None:
    write_text(key, path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")
