from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timezone
from threading import Lock
from typing import Literal

from services.config import config
from services.storage.base import StorageBackend

AuthRole = Literal["admin", "user"]
COMMERCE_FEATURES = {
    "detail",
    "main",
    "buyer",
    "white",
    "replace",
    "resize",
    "sku",
    "ab",
    "competitor",
}
API_ENDPOINTS = {
    "chat",
    "responses",
    "images",
    "models",
    "messages",
    "image_tasks",
    "search",
}
CHAT_FEATURES = {
    "chat",
    "attachments",
    "web",
    "code",
    "image_understanding",
}
USAGE_COUNTERS = {
    "chat_calls",
    "response_calls",
    "message_calls",
    "image_calls",
    "model_calls",
    "search_calls",
    "input_tokens",
    "output_tokens",
    "images",
    "attachments",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_key(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class AuthService:
    def __init__(self, storage: StorageBackend):
        self.storage = storage
        self._lock = Lock()
        self._items = self._load()
        self._last_used_flush_at: dict[str, datetime] = {}
        self._active_requests: dict[str, int] = {}

    @staticmethod
    def _clean(value: object) -> str:
        return str(value or "").strip()

    @staticmethod
    def _default_name(role: object) -> str:
        return "管理员密钥" if str(role or "").strip().lower() == "admin" else "普通用户"

    @staticmethod
    def _coerce_int(value: object, default: int = 0) -> int:
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _normalize_commerce_permissions(value: object, role: str) -> list[str]:
        if role == "admin":
            return sorted(COMMERCE_FEATURES)
        if not isinstance(value, list):
            return []
        result: list[str] = []
        for item in value:
            feature = str(item or "").strip()
            if feature in COMMERCE_FEATURES and feature not in result:
                result.append(feature)
        return result

    @staticmethod
    def _normalize_string_list(value: object, *, allowed: set[str] | None = None, lower: bool = False) -> list[str]:
        if not isinstance(value, list):
            return []
        result: list[str] = []
        for item in value:
            text = str(item or "").strip()
            if lower:
                text = text.lower()
            if not text:
                continue
            if allowed is not None and text not in allowed and text != "*":
                continue
            if text not in result:
                result.append(text)
        return result

    @staticmethod
    def _normalize_api_permissions(value: object, role: str) -> list[str]:
        if role == "admin":
            return sorted(API_ENDPOINTS)
        normalized = AuthService._normalize_string_list(value, allowed=API_ENDPOINTS, lower=True)
        return normalized or sorted(API_ENDPOINTS)

    @staticmethod
    def _normalize_chat_permissions(value: object, role: str, chat_enabled: bool) -> list[str]:
        if role == "admin":
            return sorted(CHAT_FEATURES)
        normalized = AuthService._normalize_string_list(value, allowed=CHAT_FEATURES, lower=True)
        if normalized:
            return normalized
        return ["chat"] if chat_enabled else []

    @staticmethod
    def _normalize_usage(value: object) -> dict[str, int]:
        raw = value if isinstance(value, dict) else {}
        usage: dict[str, int] = {}
        for key in USAGE_COUNTERS:
            usage[key] = AuthService._coerce_int(raw.get(key), 0)
        return usage

    def _normalize_item(self, raw: object) -> dict[str, object] | None:
        if not isinstance(raw, dict):
            return None
        role = self._clean(raw.get("role")).lower()
        if role not in {"admin", "user"}:
            return None
        key_hash = self._clean(raw.get("key_hash"))
        if not key_hash:
            return None
        item_id = self._clean(raw.get("id")) or uuid.uuid4().hex[:12]
        name = self._clean(raw.get("name")) or self._default_name(role)
        created_at = self._clean(raw.get("created_at")) or _now_iso()
        last_used_at = self._clean(raw.get("last_used_at")) or None
        chat_enabled = bool(raw.get("chat_enabled", False)) if role == "user" else True
        commerce_permissions = self._normalize_commerce_permissions(raw.get("commerce_permissions"), role)
        allowed_models = self._normalize_string_list(raw.get("allowed_models"))
        api_permissions = self._normalize_api_permissions(raw.get("api_permissions"), role)
        chat_permissions = self._normalize_chat_permissions(raw.get("chat_permissions"), role, chat_enabled)
        return {
            "id": item_id,
            "name": name,
            "role": role,
            "key_hash": key_hash,
            "enabled": bool(raw.get("enabled", True)),
            "chat_enabled": chat_enabled,
            "commerce_permissions": commerce_permissions,
            "allowed_models": allowed_models,
            "api_permissions": api_permissions,
            "max_concurrency": self._coerce_int(raw.get("max_concurrency"), 0),
            "webhook_url": self._clean(raw.get("webhook_url")),
            "chat_permissions": chat_permissions,
            "usage": self._normalize_usage(raw.get("usage")),
            "created_at": created_at,
            "last_used_at": last_used_at,
            # 一次性额度模型：quota=本次分配上限，used=累计已扣，
            # unlimited=True 时不阻断也不计算 remaining。
            "quota": self._coerce_int(raw.get("quota"), 0),
            "used": self._coerce_int(raw.get("used"), 0),
            "unlimited": bool(raw.get("unlimited", False)),
            "qq": self._clean(raw.get("qq")),
            "qq_bound_at": self._clean(raw.get("qq_bound_at")) or None,
        }

    def _load(self) -> list[dict[str, object]]:
        try:
            items = self.storage.load_auth_keys()
        except Exception:
            return []
        if not isinstance(items, list):
            return []
        return [normalized for item in items if (normalized := self._normalize_item(item)) is not None]

    def _save(self) -> None:
        self.storage.save_auth_keys(self._items)

    def _reload_locked(self) -> None:
        self._items = self._load()

    @staticmethod
    def _public_item(item: dict[str, object]) -> dict[str, object]:
        quota = AuthService._coerce_int(item.get("quota"), 0)
        used = AuthService._coerce_int(item.get("used"), 0)
        unlimited = bool(item.get("unlimited", False))
        # 普通用户在前端读自己的剩余时直接拿这条，admin 同样会看到（admin 自己 unlimited=True、quota=0）。
        remaining = None if unlimited else max(0, quota - used)
        return {
            "id": item.get("id"),
            "name": item.get("name"),
            "role": item.get("role"),
            "enabled": bool(item.get("enabled", True)),
            "chat_enabled": bool(item.get("chat_enabled", False)) if item.get("role") == "user" else True,
            "commerce_permissions": AuthService._normalize_commerce_permissions(item.get("commerce_permissions"), str(item.get("role") or "user")),
            "allowed_models": AuthService._normalize_string_list(item.get("allowed_models")),
            "api_permissions": AuthService._normalize_api_permissions(item.get("api_permissions"), str(item.get("role") or "user")),
            "max_concurrency": AuthService._coerce_int(item.get("max_concurrency"), 0),
            "webhook_url": str(item.get("webhook_url") or ""),
            "chat_permissions": AuthService._normalize_chat_permissions(
                item.get("chat_permissions"),
                str(item.get("role") or "user"),
                bool(item.get("chat_enabled", False)) if item.get("role") == "user" else True,
            ),
            "usage": AuthService._normalize_usage(item.get("usage")),
            "created_at": item.get("created_at"),
            "last_used_at": item.get("last_used_at"),
            "quota": quota,
            "used": used,
            "unlimited": unlimited,
            "remaining": remaining,
            "qq": item.get("qq") or "",
            "qq_bound_at": item.get("qq_bound_at"),
        }

    def list_keys(self, role: AuthRole | None = None) -> list[dict[str, object]]:
        with self._lock:
            self._reload_locked()
            items = [item for item in self._items if role is None or item.get("role") == role]
            return [self._public_item(item) for item in items]

    def _has_key_hash_locked(self, key_hash: str, *, exclude_id: str = "") -> bool:
        for item in self._items:
            item_id = self._clean(item.get("id"))
            if exclude_id and item_id == exclude_id:
                continue
            stored_hash = self._clean(item.get("key_hash"))
            if stored_hash and hmac.compare_digest(stored_hash, key_hash):
                return True
        return False

    def _build_key_hash_locked(self, raw_key: str, *, exclude_id: str = "") -> str:
        candidate = self._clean(raw_key)
        if not candidate:
            raise ValueError("请输入新的专用密钥")
        admin_key = self._clean(config.auth_key)
        if admin_key and hmac.compare_digest(candidate, admin_key):
            raise ValueError("这个密钥和管理员密钥冲突了，请换一个新的密钥")
        key_hash = _hash_key(candidate)
        if self._has_key_hash_locked(key_hash, exclude_id=exclude_id):
            raise ValueError("这个专用密钥已经存在，请换一个新的密钥")
        return key_hash

    def _has_name_locked(self, name: str, *, role: AuthRole | None = None, exclude_id: str = "") -> bool:
        candidate = self._clean(name)
        if not candidate:
            return False
        for item in self._items:
            item_id = self._clean(item.get("id"))
            if exclude_id and item_id == exclude_id:
                continue
            if role is not None and item.get("role") != role:
                continue
            if self._clean(item.get("name")) == candidate:
                return True
        return False

    def _build_default_name_locked(self, role: AuthRole, *, exclude_id: str = "") -> str:
        base_name = self._default_name(role)
        if not self._has_name_locked(base_name, role=role, exclude_id=exclude_id):
            return base_name
        suffix = 2
        while True:
            candidate = f"{base_name} {suffix}"
            if not self._has_name_locked(candidate, role=role, exclude_id=exclude_id):
                return candidate
            suffix += 1

    def _build_name_locked(self, name: str, *, role: AuthRole, exclude_id: str = "") -> str:
        candidate = self._clean(name)
        if not candidate:
            return self._build_default_name_locked(role, exclude_id=exclude_id)
        if self._has_name_locked(candidate, role=role, exclude_id=exclude_id):
            raise ValueError("这个名称已经在使用中了，换一个更容易区分的名称吧")
        return candidate

    def create_key(
        self,
        *,
        role: AuthRole,
        name: str = "",
        quota: int = 0,
        unlimited: bool = False,
        chat_enabled: bool = False,
        commerce_permissions: list[str] | None = None,
        allowed_models: list[str] | None = None,
        api_permissions: list[str] | None = None,
        max_concurrency: int = 0,
        webhook_url: str = "",
        chat_permissions: list[str] | None = None,
    ) -> tuple[dict[str, object], str]:
        with self._lock:
            self._reload_locked()
            normalized_name = self._build_name_locked(name, role=role)
            while True:
                raw_key = f"sk-{secrets.token_urlsafe(24)}"
                try:
                    key_hash = self._build_key_hash_locked(raw_key)
                    break
                except ValueError:
                    continue
            item = {
                "id": uuid.uuid4().hex[:12],
                "name": normalized_name,
                "role": role,
                "key_hash": key_hash,
                "enabled": True,
                "chat_enabled": bool(chat_enabled) if role == "user" else True,
                "commerce_permissions": self._normalize_commerce_permissions(commerce_permissions or [], role),
                "allowed_models": self._normalize_string_list(allowed_models or []),
                "api_permissions": self._normalize_api_permissions(api_permissions or [], role),
                "max_concurrency": self._coerce_int(max_concurrency, 0),
                "webhook_url": self._clean(webhook_url),
                "chat_permissions": self._normalize_chat_permissions(chat_permissions or [], role, bool(chat_enabled) if role == "user" else True),
                "usage": self._normalize_usage({}),
                "created_at": _now_iso(),
                "last_used_at": None,
                # admin 默认无限；user 默认按传入 quota，0 即不可用，需要再分配。
                "quota": self._coerce_int(quota, 0),
                "used": 0,
                "unlimited": bool(unlimited) if role == "user" else True,
            }
            self._items.append(item)
            self._save()
            return self._public_item(item), raw_key

    def update_key(
        self,
        key_id: str,
        updates: dict[str, object],
        *,
        role: AuthRole | None = None,
    ) -> dict[str, object] | None:
        normalized_id = self._clean(key_id)
        if not normalized_id:
            return None
        with self._lock:
            self._reload_locked()
            for index, item in enumerate(self._items):
                if item.get("id") != normalized_id:
                    continue
                if role is not None and item.get("role") != role:
                    return None
                next_item = dict(item)
                next_role = "admin" if str(next_item.get("role") or "").strip().lower() == "admin" else "user"
                if "name" in updates and updates.get("name") is not None:
                    next_item["name"] = self._build_name_locked(
                        str(updates.get("name") or ""),
                        role=next_role,
                        exclude_id=normalized_id,
                    )
                if "enabled" in updates and updates.get("enabled") is not None:
                    next_item["enabled"] = bool(updates.get("enabled"))
                if "chat_enabled" in updates and updates.get("chat_enabled") is not None:
                    next_item["chat_enabled"] = bool(updates.get("chat_enabled")) if next_role == "user" else True
                if "commerce_permissions" in updates and updates.get("commerce_permissions") is not None:
                    next_item["commerce_permissions"] = self._normalize_commerce_permissions(updates.get("commerce_permissions"), next_role)
                if "allowed_models" in updates and updates.get("allowed_models") is not None:
                    next_item["allowed_models"] = self._normalize_string_list(updates.get("allowed_models"))
                if "api_permissions" in updates and updates.get("api_permissions") is not None:
                    next_item["api_permissions"] = self._normalize_api_permissions(updates.get("api_permissions"), next_role)
                if "max_concurrency" in updates and updates.get("max_concurrency") is not None:
                    next_item["max_concurrency"] = self._coerce_int(updates.get("max_concurrency"), 0)
                if "webhook_url" in updates and updates.get("webhook_url") is not None:
                    next_item["webhook_url"] = self._clean(updates.get("webhook_url"))
                if "chat_permissions" in updates and updates.get("chat_permissions") is not None:
                    next_item["chat_permissions"] = self._normalize_chat_permissions(
                        updates.get("chat_permissions"),
                        next_role,
                        bool(next_item.get("chat_enabled", False)) if next_role == "user" else True,
                    )
                if "key" in updates and updates.get("key") is not None:
                    next_item["key_hash"] = self._build_key_hash_locked(str(updates.get("key") or ""), exclude_id=normalized_id)
                if next_role == "user":
                    if "quota" in updates and updates.get("quota") is not None:
                        next_item["quota"] = self._coerce_int(updates.get("quota"), 0)
                    if "unlimited" in updates and updates.get("unlimited") is not None:
                        next_item["unlimited"] = bool(updates.get("unlimited"))
                    # 管理员手动重置已用计数：传 reset_used=True 就把 used 归零
                    if updates.get("reset_used"):
                        next_item["used"] = 0
                else:
                    # admin 永远 unlimited，quota/used 字段保持稳定不被外部改坏
                    next_item["unlimited"] = True
                    next_item["quota"] = 0
                    next_item["used"] = 0
                    next_item["chat_enabled"] = True
                    next_item["commerce_permissions"] = sorted(COMMERCE_FEATURES)
                    next_item["api_permissions"] = sorted(API_ENDPOINTS)
                    next_item["chat_permissions"] = sorted(CHAT_FEATURES)
                    next_item["max_concurrency"] = 0
                self._items[index] = next_item
                self._save()
                return self._public_item(next_item)
        return None

    def get_by_id(self, key_id: str) -> dict[str, object] | None:
        normalized_id = self._clean(key_id)
        if not normalized_id:
            return None
        with self._lock:
            for item in self._items:
                if item.get("id") == normalized_id:
                    return self._public_item(item)
        return None

    def bind_qq(self, key_id: str, qq: str) -> dict[str, object] | None:
        normalized_id = self._clean(key_id)
        normalized_qq = self._clean(qq)
        if not normalized_id:
            return None
        with self._lock:
            self._reload_locked()
            for index, item in enumerate(self._items):
                if item.get("id") != normalized_id:
                    continue
                next_item = dict(item)
                next_item["qq"] = normalized_qq
                next_item["qq_bound_at"] = _now_iso() if normalized_qq else None
                self._items[index] = next_item
                self._save()
                return self._public_item(next_item)
        return None

    def get_by_qq(self, qq: str) -> dict[str, object] | None:
        normalized_qq = self._clean(qq)
        if not normalized_qq:
            return None
        with self._lock:
            self._reload_locked()
            for item in self._items:
                if self._clean(item.get("qq")) == normalized_qq:
                    return self._public_item(item)
        return None

    def add_quota(self, key_id: str, amount: int) -> dict[str, object] | None:
        normalized_id = self._clean(key_id)
        delta = self._coerce_int(amount, 0)
        if not normalized_id or delta <= 0:
            return None
        with self._lock:
            self._reload_locked()
            for index, item in enumerate(self._items):
                if item.get("id") != normalized_id:
                    continue
                next_item = dict(item)
                if str(next_item.get("role") or "").strip().lower() == "admin" or bool(next_item.get("unlimited", False)):
                    return self._public_item(next_item)
                next_item["quota"] = self._coerce_int(next_item.get("quota"), 0) + delta
                self._items[index] = next_item
                self._save()
                return self._public_item(next_item)
        return None

    def add_usage(
        self,
        key_id: str,
        *,
        endpoint: str = "",
        input_tokens: int = 0,
        output_tokens: int = 0,
        images: int = 0,
        attachments: int = 0,
    ) -> dict[str, object] | None:
        normalized_id = self._clean(key_id)
        if not normalized_id or normalized_id == "admin":
            return None
        with self._lock:
            for index, item in enumerate(self._items):
                if item.get("id") != normalized_id:
                    continue
                next_item = dict(item)
                usage = self._normalize_usage(next_item.get("usage"))
                endpoint_key = {
                    "chat": "chat_calls",
                    "responses": "response_calls",
                    "messages": "message_calls",
                    "images": "image_calls",
                    "models": "model_calls",
                    "image_tasks": "image_calls",
                    "search": "search_calls",
                }.get(str(endpoint or "").strip(), "")
                if endpoint_key:
                    usage[endpoint_key] = usage.get(endpoint_key, 0) + 1
                usage["input_tokens"] = usage.get("input_tokens", 0) + max(0, int(input_tokens or 0))
                usage["output_tokens"] = usage.get("output_tokens", 0) + max(0, int(output_tokens or 0))
                usage["images"] = usage.get("images", 0) + max(0, int(images or 0))
                usage["attachments"] = usage.get("attachments", 0) + max(0, int(attachments or 0))
                next_item["usage"] = usage
                self._items[index] = next_item
                self._save()
                return self._public_item(next_item)
        return None

    def enter_request(self, key_id: str) -> tuple[bool, str]:
        normalized_id = self._clean(key_id)
        if not normalized_id or normalized_id == "admin":
            return True, ""
        with self._lock:
            record = None
            for item in self._items:
                if item.get("id") == normalized_id:
                    record = item
                    break
            if record is None:
                return False, "key not found"
            limit = self._coerce_int(record.get("max_concurrency"), 0)
            if limit <= 0:
                self._active_requests[normalized_id] = self._active_requests.get(normalized_id, 0) + 1
                return True, ""
            current = self._active_requests.get(normalized_id, 0)
            if current >= limit:
                return False, "too many concurrent requests"
            self._active_requests[normalized_id] = current + 1
            return True, ""

    def leave_request(self, key_id: str) -> None:
        normalized_id = self._clean(key_id)
        if not normalized_id or normalized_id == "admin":
            return
        with self._lock:
            current = self._active_requests.get(normalized_id, 0)
            if current <= 1:
                self._active_requests.pop(normalized_id, None)
            else:
                self._active_requests[normalized_id] = current - 1

    def consume_quota(self, key_id: str, amount: int) -> dict[str, object]:
        """扣减用户密钥额度。返回 {ok, remaining, unlimited, reason}。
        admin / unlimited 直接放行；普通用户额度不足时 ok=False 且不写入。"""
        normalized_id = self._clean(key_id)
        delta = max(0, int(amount or 0))
        if not normalized_id or delta == 0:
            return {"ok": True, "remaining": None, "unlimited": True, "reason": ""}
        with self._lock:
            for index, item in enumerate(self._items):
                if item.get("id") != normalized_id:
                    continue
                role = str(item.get("role") or "").strip().lower()
                if role == "admin" or bool(item.get("unlimited", False)):
                    return {"ok": True, "remaining": None, "unlimited": True, "reason": ""}
                quota = self._coerce_int(item.get("quota"), 0)
                used = self._coerce_int(item.get("used"), 0)
                remaining = max(0, quota - used)
                if remaining < delta:
                    return {
                        "ok": False,
                        "remaining": remaining,
                        "unlimited": False,
                        "reason": "额度不足，请联系管理员追加额度后再试",
                    }
                next_item = dict(item)
                next_item["used"] = used + delta
                self._items[index] = next_item
                try:
                    self._save()
                except Exception:
                    # 持久化失败时回滚内存，避免数字飘
                    self._items[index] = item
                    raise
                return {
                    "ok": True,
                    "remaining": max(0, quota - next_item["used"]),
                    "unlimited": False,
                    "reason": "",
                }
        return {"ok": False, "remaining": 0, "unlimited": False, "reason": "密钥不存在"}

    def refund_quota(self, key_id: str, amount: int) -> dict[str, object]:
        """退还用户密钥额度。语义跟 [consume_quota] 对称：
        admin / unlimited 直接 noop；其它用户 used 减去 amount 但不会跌破 0。

        用途：图片生成上游真实失败（content_policy / 5xx / 上游超时）时，
        把入口预扣的额度退回去，让用户体感是"真生成了才扣"。
        持久化失败回滚内存，跟 consume_quota 同样的失败处理。
        """
        normalized_id = self._clean(key_id)
        delta = max(0, int(amount or 0))
        if not normalized_id or delta == 0:
            return {"ok": True, "remaining": None, "unlimited": True, "reason": ""}
        with self._lock:
            for index, item in enumerate(self._items):
                if item.get("id") != normalized_id:
                    continue
                role = str(item.get("role") or "").strip().lower()
                if role == "admin" or bool(item.get("unlimited", False)):
                    return {"ok": True, "remaining": None, "unlimited": True, "reason": ""}
                quota = self._coerce_int(item.get("quota"), 0)
                used = self._coerce_int(item.get("used"), 0)
                if used <= 0:
                    # 没扣过就别退——避免某些 race 让 used 变负数
                    return {"ok": True, "remaining": max(0, quota - used), "unlimited": False, "reason": ""}
                next_item = dict(item)
                # 不会跌破 0：上游返多次失败回调时退超量也只到 0 为止
                next_item["used"] = max(0, used - delta)
                self._items[index] = next_item
                try:
                    self._save()
                except Exception:
                    # 持久化失败时回滚内存，避免数字飘
                    self._items[index] = item
                    raise
                return {
                    "ok": True,
                    "remaining": max(0, quota - next_item["used"]),
                    "unlimited": False,
                    "reason": "",
                }
        return {"ok": False, "remaining": 0, "unlimited": False, "reason": "密钥不存在"}

    def delete_key(self, key_id: str, *, role: AuthRole | None = None) -> bool:
        normalized_id = self._clean(key_id)
        if not normalized_id:
            return False
        with self._lock:
            self._reload_locked()
            before = len(self._items)
            self._items = [
                item
                for item in self._items
                if not (item.get("id") == normalized_id and (role is None or item.get("role") == role))
            ]
            if len(self._items) == before:
                return False
            self._save()
            return True

    def authenticate(self, raw_key: str) -> dict[str, object] | None:
        candidate = self._clean(raw_key)
        if not candidate:
            return None
        candidate_hash = _hash_key(candidate)
        with self._lock:
            for index, item in enumerate(self._items):
                if not bool(item.get("enabled", True)):
                    continue
                stored_hash = self._clean(item.get("key_hash"))
                if not stored_hash or not hmac.compare_digest(stored_hash, candidate_hash):
                    continue
                next_item = dict(item)
                now = datetime.now(timezone.utc)
                next_item["last_used_at"] = now.isoformat()
                self._items[index] = next_item
                item_id = self._clean(next_item.get("id"))
                last_flush_at = self._last_used_flush_at.get(item_id)
                if last_flush_at is None or (now - last_flush_at).total_seconds() >= 60:
                    try:
                        self._save()
                        self._last_used_flush_at[item_id] = now
                    except Exception:
                        pass
                return self._public_item(next_item)
        return None


auth_service = AuthService(config.get_storage_backend())
