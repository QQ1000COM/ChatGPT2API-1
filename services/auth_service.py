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
        return {
            "id": item_id,
            "name": name,
            "role": role,
            "key_hash": key_hash,
            "enabled": bool(raw.get("enabled", True)),
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
