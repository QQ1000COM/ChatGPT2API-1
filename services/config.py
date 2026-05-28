from __future__ import annotations

from dataclasses import dataclass
import json
import os
import secrets
import sys
from pathlib import Path
import time
from datetime import datetime, timezone

from services.storage.base import StorageBackend

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
CONFIG_FILE = BASE_DIR / "config.json"
VERSION_FILE = BASE_DIR / "VERSION"
BACKUP_STATE_FILE = DATA_DIR / "backup_state.json"

DEFAULT_BACKUP_INCLUDE = {
    "config": True,
    "register": True,
    "cpa": True,
    "sub2api": True,
    "logs": True,
    "image_tasks": True,
    "image_conversations": True,
    "accounts_snapshot": True,
    "auth_keys_snapshot": True,
    "images": False,
}

DEFAULT_REMOTE_STORAGE = {
    "enabled": False,
    "provider": "local",
    "path_prefix": "images",
    "public_base_url": "",
    "delete_local_after_upload": False,
    "webdav": {
        "url": "",
        "username": "",
        "password": "",
    },
    "s3": {
        "endpoint": "",
        "region": "auto",
        "bucket": "",
        "access_key_id": "",
        "secret_access_key": "",
    },
}


def _normalize_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    if value is None:
        return default
    return bool(value)


def _normalize_positive_int(value: object, default: int, minimum: int = 0) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        normalized = default
    return max(minimum, normalized)


def _normalize_backup_include(value: object) -> dict[str, bool]:
    source = value if isinstance(value, dict) else {}
    normalized = dict(DEFAULT_BACKUP_INCLUDE)
    for key in normalized:
        normalized[key] = _normalize_bool(source.get(key), normalized[key])
    return normalized


def _normalize_backup_settings(value: object) -> dict[str, object]:
    source = value if isinstance(value, dict) else {}
    webdav = source.get("webdav") if isinstance(source.get("webdav"), dict) else {}
    provider = str(source.get("provider") or "cloudflare_r2").strip().lower()
    if provider not in {"cloudflare_r2", "webdav"}:
        provider = "cloudflare_r2"
    return {
        "enabled": _normalize_bool(source.get("enabled"), False),
        "provider": provider,
        "account_id": str(source.get("account_id") or "").strip(),
        "access_key_id": str(source.get("access_key_id") or "").strip(),
        "secret_access_key": str(source.get("secret_access_key") or "").strip(),
        "bucket": str(source.get("bucket") or "").strip(),
        "prefix": str(source.get("prefix") or "backups").strip().strip("/") or "backups",
        "interval_minutes": _normalize_positive_int(source.get("interval_minutes"), 360, 1),
        "rotation_keep": _normalize_positive_int(source.get("rotation_keep"), 10, 0),
        "encrypt": _normalize_bool(source.get("encrypt"), False),
        "passphrase": str(source.get("passphrase") or "").strip(),
        "include": _normalize_backup_include(source.get("include")),
        "webdav": {
            "url": str(webdav.get("url") or "").strip().rstrip("/"),
            "username": str(webdav.get("username") or "").strip(),
            "password": str(webdav.get("password") or "").strip(),
        },
    }


def _preserve_masked_backup_secret(incoming: object, current: object) -> object:
    if not isinstance(incoming, dict):
        return incoming
    current_settings = _normalize_backup_settings(current)
    next_settings = dict(incoming)
    webdav = dict(next_settings.get("webdav") if isinstance(next_settings.get("webdav"), dict) else {})
    current_webdav = current_settings.get("webdav") if isinstance(current_settings.get("webdav"), dict) else {}
    if str(next_settings.get("secret_access_key") or "").strip() == "********":
        next_settings["secret_access_key"] = str(current_settings.get("secret_access_key") or "")
    if str(next_settings.get("passphrase") or "").strip() == "********":
        next_settings["passphrase"] = str(current_settings.get("passphrase") or "")
    if str(webdav.get("password") or "").strip() == "********":
        webdav["password"] = str(current_webdav.get("password") or "")
    next_settings["webdav"] = webdav
    return next_settings


def _normalize_backup_state(value: object) -> dict[str, object]:
    source = value if isinstance(value, dict) else {}
    return {
        "last_started_at": str(source.get("last_started_at") or "").strip() or None,
        "last_finished_at": str(source.get("last_finished_at") or "").strip() or None,
        "last_status": str(source.get("last_status") or "idle").strip() or "idle",
        "last_error": str(source.get("last_error") or "").strip() or None,
        "last_object_key": str(source.get("last_object_key") or "").strip() or None,
    }


def _normalize_remote_storage_settings(value: object) -> dict[str, object]:
    source = value if isinstance(value, dict) else {}
    webdav = source.get("webdav") if isinstance(source.get("webdav"), dict) else {}
    s3 = source.get("s3") if isinstance(source.get("s3"), dict) else {}
    provider = str(source.get("provider") or "local").strip().lower()
    if provider not in {"local", "webdav", "s3"}:
        provider = "local"
    return {
        "enabled": _normalize_bool(source.get("enabled"), False),
        "provider": provider,
        "path_prefix": str(source.get("path_prefix") or "images").strip().strip("/") or "images",
        "public_base_url": str(source.get("public_base_url") or "").strip().rstrip("/"),
        "delete_local_after_upload": _normalize_bool(source.get("delete_local_after_upload"), False),
        "webdav": {
            "url": str(webdav.get("url") or "").strip().rstrip("/"),
            "username": str(webdav.get("username") or "").strip(),
            "password": str(webdav.get("password") or "").strip(),
        },
        "s3": {
            "endpoint": str(s3.get("endpoint") or "").strip().rstrip("/"),
            "region": str(s3.get("region") or "auto").strip() or "auto",
            "bucket": str(s3.get("bucket") or "").strip(),
            "access_key_id": str(s3.get("access_key_id") or "").strip(),
            "secret_access_key": str(s3.get("secret_access_key") or "").strip(),
        },
    }


def _preserve_masked_remote_storage_secret(incoming: object, current: object) -> object:
    if not isinstance(incoming, dict):
        return incoming
    current_settings = _normalize_remote_storage_settings(current)
    next_settings = dict(incoming)
    webdav = dict(next_settings.get("webdav") if isinstance(next_settings.get("webdav"), dict) else {})
    s3 = dict(next_settings.get("s3") if isinstance(next_settings.get("s3"), dict) else {})
    current_webdav = current_settings.get("webdav") if isinstance(current_settings.get("webdav"), dict) else {}
    current_s3 = current_settings.get("s3") if isinstance(current_settings.get("s3"), dict) else {}
    if str(webdav.get("password") or "").strip() == "********":
        webdav["password"] = str(current_webdav.get("password") or "")
    if str(s3.get("secret_access_key") or "").strip() == "********":
        s3["secret_access_key"] = str(current_s3.get("secret_access_key") or "")
    next_settings["webdav"] = webdav
    next_settings["s3"] = s3
    return next_settings


@dataclass(frozen=True)
class LoadedSettings:
    auth_key: str
    refresh_account_interval_minute: int


def _normalize_auth_key(value: object) -> str:
    return str(value or "").strip()


def _is_invalid_auth_key(value: object) -> bool:
    return _normalize_auth_key(value) == ""


def _read_json_object(path: Path, *, name: str) -> dict[str, object]:
    if not path.exists():
        return {}
    if path.is_dir():
        print(
            f"Warning: {name} at '{path}' is a directory, ignoring it and falling back to other configuration sources.",
            file=sys.stderr,
        )
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _database_url_for_config() -> str:
    backend = str(os.getenv("STORAGE_BACKEND") or "").strip().lower()
    database_url = str(os.getenv("DATABASE_URL") or "").strip()
    if backend not in {"postgres", "postgresql", "database"} or not database_url:
        return ""
    if database_url.startswith("sqlite:"):
        return ""
    return database_url


def _load_config_from_database() -> dict[str, object]:
    database_url = _database_url_for_config()
    if not database_url:
        return {}
    try:
        from sqlalchemy import create_engine, text

        engine = create_engine(database_url, pool_pre_ping=True)
        with engine.begin() as connection:
            connection.execute(
                text(
                    "CREATE TABLE IF NOT EXISTS app_settings ("
                    "key VARCHAR(128) PRIMARY KEY, "
                    "data TEXT NOT NULL)"
                )
            )
            row = connection.execute(
                text("SELECT data FROM app_settings WHERE key = :key"),
                {"key": "config"},
            ).fetchone()
        engine.dispose()
        if not row:
            return {}
        data = json.loads(str(row[0] or "{}"))
        return data if isinstance(data, dict) else {}
    except Exception as exc:
        print(f"[config] database config load failed, falling back to file: {exc}", file=sys.stderr)
        return {}


def _save_config_to_database(data: dict[str, object]) -> None:
    database_url = _database_url_for_config()
    if not database_url:
        return
    try:
        from sqlalchemy import create_engine, text

        engine = create_engine(database_url, pool_pre_ping=True)
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        with engine.begin() as connection:
            connection.execute(
                text(
                    "CREATE TABLE IF NOT EXISTS app_settings ("
                    "key VARCHAR(128) PRIMARY KEY, "
                    "data TEXT NOT NULL)"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO app_settings (key, data) VALUES (:key, :data) "
                    "ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data"
                ),
                {"key": "config", "data": payload},
            )
        engine.dispose()
    except Exception as exc:
        print(f"[config] database config save failed: {exc}", file=sys.stderr)


def _load_settings() -> LoadedSettings:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    raw_config = {**_read_json_object(CONFIG_FILE, name="config.json"), **_load_config_from_database()}
    auth_key = _normalize_auth_key(os.getenv("CHATGPT2API_AUTH_KEY") or raw_config.get("auth-key"))
    if _is_invalid_auth_key(auth_key):
        raise ValueError(
            "❌ auth-key 未设置！\n"
            "请在环境变量 CHATGPT2API_AUTH_KEY 中设置，或者在 config.json 中填写 auth-key。"
        )

    try:
        refresh_interval = int(raw_config.get("refresh_account_interval_minute", 5))
    except (TypeError, ValueError):
        refresh_interval = 5

    return LoadedSettings(
        auth_key=auth_key,
        refresh_account_interval_minute=refresh_interval,
    )


class ConfigStore:
    def __init__(self, path: Path):
        self.path = path
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.data = self._load()
        self._storage_backend: StorageBackend | None = None
        if _is_invalid_auth_key(self.auth_key):
            raise ValueError(
                "❌ auth-key 未设置！\n"
                "请按以下任意一种方式解决：\n"
                "1. 在 Render 的 Environment 变量中添加：\n"
                "   CHATGPT2API_AUTH_KEY = your_real_auth_key\n"
                "2. 或者在 config.json 中填写：\n"
                '   "auth-key": "your_real_auth_key"'
            )

    def _load(self) -> dict[str, object]:
        file_data = _read_json_object(self.path, name="config.json")
        database_data = _load_config_from_database()
        if database_data:
            return {**file_data, **database_data}
        if file_data:
            _save_config_to_database(file_data)
        return file_data

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        _save_config_to_database(self.data)

    @property
    def auth_key(self) -> str:
        return _normalize_auth_key(os.getenv("CHATGPT2API_AUTH_KEY") or self.data.get("auth-key"))

    @property
    def accounts_file(self) -> Path:
        return DATA_DIR / "accounts.json"

    @property
    def refresh_account_interval_minute(self) -> int:
        try:
            return int(self.data.get("refresh_account_interval_minute", 5))
        except (TypeError, ValueError):
            return 5

    @property
    def image_retention_days(self) -> int:
        try:
            return max(1, int(self.data.get("image_retention_days", 30)))
        except (TypeError, ValueError):
            return 30

    @property
    def cleanup_protect_gallery(self) -> bool:
        """清理图片时是否跳过画廊已发布条目。
        默认 True：发布到画廊视为用户主动表示"这张图有保留价值"，
        默删会让画廊瓦片瞬间变成裂图。
        管理员可以在设置里关掉，回到"按 mtime 一刀切"的旧行为。"""
        return bool(self.data.get("cleanup_protect_gallery", True))

    @property
    def cleanup_protect_user_images(self) -> bool:
        """清理图片时是否跳过 image_owners 里有归属的图（用户「我的作品」）。
        默认 True：用户在「我的作品」里看到一张图突然消失体感比较糟。
        匿名 / admin 生成且没归属的图不受这个开关保护，仍然按 mtime 清。
        管理员可以关掉以释放存储。"""
        return bool(self.data.get("cleanup_protect_user_images", True))

    @property
    def image_poll_timeout_secs(self) -> int:
        try:
            return max(1, int(self.data.get("image_poll_timeout_secs", 120)))
        except (TypeError, ValueError):
            return 120

    @property
    def image_account_concurrency(self) -> int:
        try:
            return max(1, int(self.data.get("image_account_concurrency", 3)))
        except (TypeError, ValueError):
            return 3

    @property
    def auto_remove_invalid_accounts(self) -> bool:
        value = self.data.get("auto_remove_invalid_accounts", False)
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    @property
    def auto_remove_rate_limited_accounts(self) -> bool:
        value = self.data.get("auto_remove_rate_limited_accounts", False)
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    @property
    def log_levels(self) -> list[str]:
        levels = self.data.get("log_levels")
        if not isinstance(levels, list):
            return []
        allowed = {"debug", "info", "warning", "error"}
        return [level for item in levels if (level := str(item or "").strip().lower()) in allowed]

    @property
    def sensitive_words(self) -> list[str]:
        words = self.data.get("sensitive_words")
        return [word for item in words if (word := str(item or "").strip())] if isinstance(words, list) else []

    @property
    def ai_review(self) -> dict[str, object]:
        value = self.data.get("ai_review")
        return value if isinstance(value, dict) else {}

    @property
    def global_system_prompt(self) -> str:
        return str(self.data.get("global_system_prompt") or "").strip()

    @property
    def images_dir(self) -> Path:
        path = DATA_DIR / "images"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def image_thumbnails_dir(self) -> Path:
        path = DATA_DIR / "image_thumbnails"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def cleanup_old_images(self) -> int:
        cutoff = time.time() - self.image_retention_days * 86400
        # 收集白名单 rel：开关命中才查，避免无开关时也走两次磁盘 IO
        protected: set[str] = set()
        if self.cleanup_protect_gallery:
            try:
                # 延迟 import 避免 services 间循环引用（gallery_service → config）
                from services.gallery_service import _load_all as _load_gallery_all
                for it in _load_gallery_all():
                    rel = (it.get("image_rel") or "").strip().lstrip("/")
                    if rel:
                        protected.add(rel)
            except Exception:
                # 加载失败时按"宁可保守"原则——这一轮不删任何文件，等下次清理
                # 总好过把已发布画廊条目的 PNG 删掉造成 404
                return 0
        if self.cleanup_protect_user_images:
            try:
                from services.image_owners_service import load_owners
                owners = load_owners()
                for rel, owner in owners.items():
                    rel_clean = (rel or "").strip().lstrip("/")
                    owner_clean = (owner or "").strip().lower()
                    # admin / 匿名归属（空字符串）不算"用户作品"，仍按 mtime 清
                    if rel_clean and owner_clean and owner_clean != "admin" and owner_clean != "__admin__":
                        protected.add(rel_clean)
            except Exception:
                return 0

        removed = 0
        images_root = self.images_dir
        for path in images_root.rglob("*"):
            if not path.is_file():
                continue
            if path.stat().st_mtime >= cutoff:
                continue
            if protected:
                # rel = 相对 images_dir 的 posix 路径，跟 image_rel 落库格式一致
                try:
                    rel = path.relative_to(images_root).as_posix()
                except ValueError:
                    rel = ""
                if rel and rel in protected:
                    continue
            path.unlink()
            removed += 1
        for path in sorted((p for p in self.images_dir.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
            try:
                path.rmdir()
            except OSError:
                pass
        return removed

    @property
    def base_url(self) -> str:
        return str(
            os.getenv("CHATGPT2API_BASE_URL")
            or self.data.get("base_url")
            or ""
        ).strip().rstrip("/")

    @property
    def site_name(self) -> str:
        return str(self.data.get("site_name") or "ChatGPT2API").strip() or "ChatGPT2API"

    @property
    def browser_title(self) -> str:
        return str(self.data.get("browser_title") or self.site_name).strip() or self.site_name

    def get_qq_oauth_settings(self, *, mask_secret: bool = False) -> dict[str, object]:
        source = self.data.get("qq_oauth") if isinstance(self.data.get("qq_oauth"), dict) else {}
        app_key = str(source.get("app_key") or "").strip()
        return {
            "app_id": str(source.get("app_id") or "").strip(),
            "app_key": "********" if mask_secret and app_key else app_key,
            "new_user_free_quota": _normalize_positive_int(source.get("new_user_free_quota"), 0),
            "invite_reward_quota": _normalize_positive_int(source.get("invite_reward_quota"), 5),
        }

    def get_admin_profile(self) -> dict[str, object]:
        source = self.data.get("admin_profile") if isinstance(self.data.get("admin_profile"), dict) else {}
        return {
            "qq": str(source.get("qq") or "").strip(),
            "qq_bound_at": str(source.get("qq_bound_at") or "").strip() or None,
        }

    def bind_admin_qq(self, qq: str) -> dict[str, object]:
        normalized_qq = str(qq or "").strip()
        next_data = dict(self.data)
        next_data["admin_profile"] = {
            "qq": normalized_qq,
            "qq_bound_at": datetime.now(timezone.utc).isoformat() if normalized_qq else None,
        }
        self.data = next_data
        self._save()
        return self.get_admin_profile()

    def create_qq_oauth_state(self, identity: dict[str, object] | None = None, *, purpose: str = "bind", invite_code: str = "") -> str:
        now = int(time.time())
        source = self.data.get("qq_oauth_states") if isinstance(self.data.get("qq_oauth_states"), dict) else {}
        states = {
            str(key): value
            for key, value in source.items()
            if isinstance(value, dict) and now - int(value.get("created_at") or 0) <= 900
        }
        source_identity = identity or {}
        state = secrets.token_urlsafe(24)
        states[state] = {
            "purpose": str(purpose or "bind").strip() or "bind",
            "identity_id": str(source_identity.get("id") or "").strip(),
            "name": str(source_identity.get("name") or "").strip(),
            "role": str(source_identity.get("role") or "").strip(),
            "invite_code": str(invite_code or "").strip(),
            "created_at": now,
        }
        next_data = dict(self.data)
        next_data["qq_oauth_states"] = states
        self.data = next_data
        self._save()
        return state

    def consume_qq_oauth_state(self, state: str) -> dict[str, object] | None:
        normalized_state = str(state or "").strip()
        now = int(time.time())
        source = self.data.get("qq_oauth_states") if isinstance(self.data.get("qq_oauth_states"), dict) else {}
        states = {
            str(key): value
            for key, value in source.items()
            if isinstance(value, dict) and now - int(value.get("created_at") or 0) <= 900
        }
        item = states.pop(normalized_state, None)
        next_data = dict(self.data)
        next_data["qq_oauth_states"] = states
        self.data = next_data
        self._save()
        return item if isinstance(item, dict) else None

    def create_qq_login_session(self, identity: dict[str, object]) -> str:
        now = int(time.time())
        source = self.data.get("qq_login_sessions") if isinstance(self.data.get("qq_login_sessions"), dict) else {}
        sessions = {
            str(key): value
            for key, value in source.items()
            if isinstance(value, dict) and now - int(value.get("created_at") or 0) <= 60 * 60 * 24 * 30
        }
        token = "qq-" + secrets.token_urlsafe(32)
        sessions[token] = {
            "id": str(identity.get("id") or "").strip(),
            "name": str(identity.get("name") or "").strip(),
            "role": str(identity.get("role") or "").strip(),
            "created_at": now,
        }
        next_data = dict(self.data)
        next_data["qq_login_sessions"] = sessions
        self.data = next_data
        self._save()
        return token

    def get_qq_login_identity(self, token: str) -> dict[str, object] | None:
        normalized_token = str(token or "").strip()
        now = int(time.time())
        source = self.data.get("qq_login_sessions") if isinstance(self.data.get("qq_login_sessions"), dict) else {}
        sessions = {
            str(key): value
            for key, value in source.items()
            if isinstance(value, dict) and now - int(value.get("created_at") or 0) <= 60 * 60 * 24 * 30
        }
        if len(sessions) != len(source):
            next_data = dict(self.data)
            next_data["qq_login_sessions"] = sessions
            self.data = next_data
            self._save()
        item = sessions.get(normalized_token)
        if not isinstance(item, dict):
            return None
        role = str(item.get("role") or "").strip()
        if role not in {"admin", "user"}:
            return None
        return {
            "id": str(item.get("id") or "").strip(),
            "name": str(item.get("name") or "").strip() or ("管理员" if role == "admin" else "普通用户"),
            "role": role,
        }

    @property
    def app_version(self) -> str:
        try:
            value = VERSION_FILE.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return "0.0.0"
        return value or "0.0.0"

    def get(self) -> dict[str, object]:
        data = dict(self.data)
        data["refresh_account_interval_minute"] = self.refresh_account_interval_minute
        data["image_retention_days"] = self.image_retention_days
        data["cleanup_protect_gallery"] = self.cleanup_protect_gallery
        data["cleanup_protect_user_images"] = self.cleanup_protect_user_images
        data["image_poll_timeout_secs"] = self.image_poll_timeout_secs
        data["image_account_concurrency"] = self.image_account_concurrency
        data["auto_remove_invalid_accounts"] = self.auto_remove_invalid_accounts
        data["auto_remove_rate_limited_accounts"] = self.auto_remove_rate_limited_accounts
        data["log_levels"] = self.log_levels
        data["sensitive_words"] = self.sensitive_words
        data["ai_review"] = self.ai_review
        data["global_system_prompt"] = self.global_system_prompt
        data["site_name"] = self.site_name
        data["browser_title"] = self.browser_title
        data["qq_oauth"] = self.get_qq_oauth_settings(mask_secret=True)
        data["admin_profile"] = self.get_admin_profile()
        data["backup"] = self.get_backup_settings()
        data["remote_storage"] = self.get_remote_storage_settings(mask_secret=True)
        data.pop("auth-key", None)
        return data

    def get_proxy_settings(self) -> str:
        return str(self.data.get("proxy") or "").strip()

    def update(self, data: dict[str, object]) -> dict[str, object]:
        next_data = dict(self.data)
        next_data.update(dict(data or {}))
        if "backup" in next_data:
            incoming_backup = _preserve_masked_backup_secret(next_data.get("backup"), self.data.get("backup"))
            next_data["backup"] = _normalize_backup_settings(incoming_backup)
        if "remote_storage" in next_data:
            incoming_remote_storage = _preserve_masked_remote_storage_secret(
                next_data.get("remote_storage"),
                self.data.get("remote_storage"),
            )
            next_data["remote_storage"] = _normalize_remote_storage_settings(incoming_remote_storage)
        if "qq_oauth" in next_data:
            incoming_qq = dict(next_data.get("qq_oauth") if isinstance(next_data.get("qq_oauth"), dict) else {})
            current_qq = self.get_qq_oauth_settings()
            if str(incoming_qq.get("app_key") or "").strip() == "********":
                incoming_qq["app_key"] = str(current_qq.get("app_key") or "")
            next_data["qq_oauth"] = {
                "app_id": str(incoming_qq.get("app_id") or "").strip(),
                "app_key": str(incoming_qq.get("app_key") or "").strip(),
                "new_user_free_quota": _normalize_positive_int(incoming_qq.get("new_user_free_quota"), 0),
                "invite_reward_quota": _normalize_positive_int(incoming_qq.get("invite_reward_quota"), 5),
            }
        if "qq_oauth_states" in next_data:
            next_data["qq_oauth_states"] = self.data.get("qq_oauth_states") if isinstance(self.data.get("qq_oauth_states"), dict) else {}
        if "qq_login_sessions" in next_data:
            next_data["qq_login_sessions"] = self.data.get("qq_login_sessions") if isinstance(self.data.get("qq_login_sessions"), dict) else {}
        next_data.pop("backup_state", None)
        self.data = next_data
        self._save()
        return self.get()

    def get_backup_settings(self) -> dict[str, object]:
        return _normalize_backup_settings(self.data.get("backup"))

    def get_remote_storage_settings(self, *, mask_secret: bool = False) -> dict[str, object]:
        settings = _normalize_remote_storage_settings(self.data.get("remote_storage"))
        if mask_secret:
            webdav = dict(settings.get("webdav") or {})
            s3 = dict(settings.get("s3") or {})
            webdav["password"] = "********" if str(webdav.get("password") or "").strip() else ""
            s3["secret_access_key"] = "********" if str(s3.get("secret_access_key") or "").strip() else ""
            settings["webdav"] = webdav
            settings["s3"] = s3
        return settings

    def get_storage_backend(self) -> StorageBackend:
        """获取存储后端实例（单例）"""
        if self._storage_backend is None:
            from services.storage.factory import create_storage_backend
            self._storage_backend = create_storage_backend(DATA_DIR)
        return self._storage_backend


def load_backup_state() -> dict[str, object]:
    return _normalize_backup_state(_read_json_object(BACKUP_STATE_FILE, name="backup_state.json"))


def save_backup_state(state: dict[str, object]) -> dict[str, object]:
    normalized = _normalize_backup_state(state)
    BACKUP_STATE_FILE.write_text(json.dumps(normalized, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return normalized


config = ConfigStore(CONFIG_FILE)
