from __future__ import annotations

import json
import hashlib
import re
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from services.config import DATA_DIR, config
from services.content_filter import request_text
from services.image_owners_service import record_owner_for_result
from services.image_prompts_service import record_prompt_for_result
from services.log_service import LOG_TYPE_CALL, log_service
from services.persistent_store import read_text, write_text
from services.protocol import openai_v1_image_edit, openai_v1_image_generations
from services.remote_image_index_service import find_remote_image_by_url

TASK_STATUS_QUEUED = "queued"
TASK_STATUS_RUNNING = "running"
TASK_STATUS_SUCCESS = "success"
TASK_STATUS_ERROR = "error"
TASK_STATUS_CANCELED = "canceled"
TERMINAL_STATUSES = {TASK_STATUS_SUCCESS, TASK_STATUS_ERROR, TASK_STATUS_CANCELED}
UNFINISHED_STATUSES = {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING}
VALID_STATUSES = {
    TASK_STATUS_QUEUED,
    TASK_STATUS_RUNNING,
    TASK_STATUS_SUCCESS,
    TASK_STATUS_ERROR,
    TASK_STATUS_CANCELED,
}


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _timestamp(value: object) -> float:
    if not isinstance(value, str) or not value.strip():
        return 0.0
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value[:26], fmt).timestamp()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _stale_unfinished_seconds() -> int:
    try:
        return max(180, int(config.image_poll_timeout_secs) * 3)
    except Exception:
        return 360


def _clean(value: object, default: str = "") -> str:
    return str(value or default).strip()


def _owner_id(identity: dict[str, object]) -> str:
    return _clean(identity.get("id")) or "anonymous"


def _task_key(owner_id: str, task_id: str) -> str:
    return f"{owner_id}:{task_id}"


def _collect_image_urls(data: list[Any]) -> list[str]:
    urls: list[str] = []
    for item in data:
        if isinstance(item, dict):
            url = item.get("url")
            if isinstance(url, str) and url:
                urls.append(url)
    return urls


def _cache_key(mode: str, payload: dict[str, Any]) -> str:
    digest = hashlib.sha256()
    digest.update(str(mode or "").encode("utf-8"))
    for key in ("prompt", "model", "size", "quality", "response_format"):
        digest.update(b"\0")
        digest.update(str(payload.get(key) or "").encode("utf-8"))
    images = payload.get("images")
    if isinstance(images, list):
        for image in images:
            digest.update(b"\0image:")
            if isinstance(image, tuple) and image:
                digest.update(hashlib.sha256(image[0] if isinstance(image[0], bytes) else bytes()).hexdigest().encode("ascii"))
                digest.update(str(image[1] if len(image) > 1 else "").encode("utf-8"))
                digest.update(str(image[2] if len(image) > 2 else "").encode("utf-8"))
    return digest.hexdigest()


def _public_task(task: dict[str, Any]) -> dict[str, Any]:
    item = {
        "id": task.get("id"),
        "status": task.get("status"),
        "mode": task.get("mode"),
        "model": task.get("model"),
        "size": task.get("size"),
        "created_at": task.get("created_at"),
        "updated_at": task.get("updated_at"),
    }
    if task.get("data") is not None:
        item["data"] = _public_task_data(task.get("data"))
    if task.get("error"):
        item["error"] = task.get("error")
    if task.get("prompt"):
        item["prompt"] = task.get("prompt")
    if task.get("retry_count") is not None:
        item["retry_count"] = int(task.get("retry_count") or 0)
    if task.get("cached") is not None:
        item["cached"] = bool(task.get("cached"))
    return item


def _public_task_data(data: Any) -> Any:
    if not isinstance(data, list):
        return data
    result: list[Any] = []
    for entry in data:
        if not isinstance(entry, dict):
            result.append(entry)
            continue
        next_entry = dict(entry)
        if not next_entry.get("local_url"):
            url = str(next_entry.get("url") or "").strip()
            if "/images/" in url:
                next_entry["local_url"] = url[url.find("/images/"):]
            else:
                remote = find_remote_image_by_url(url)
                rel = str((remote or {}).get("rel") or (remote or {}).get("path") or "").strip().lstrip("/")
                if rel:
                    next_entry["local_url"] = f"/images/{rel}"
        result.append(next_entry)
    return result


def _result_rel(entry: Any) -> str:
    if not isinstance(entry, dict):
        return ""
    local_url = str(entry.get("local_url") or "").strip()
    if "/images/" in local_url:
        return local_url[local_url.find("/images/") + len("/images/") :].strip().lstrip("/")
    url = str(entry.get("url") or "").strip()
    if "/images/" in url:
        return url[url.find("/images/") + len("/images/") :].strip().lstrip("/")
    remote = find_remote_image_by_url(url)
    return str((remote or {}).get("rel") or (remote or {}).get("path") or "").strip().lstrip("/")


def _fallback_task_group(task_id: str) -> tuple[str, int] | None:
    match = re.match(r"^(?P<group>.+)-(?P<index>\d+)$", task_id or "")
    if not match:
        return None
    return match.group("group"), int(match.group("index"))


def _infer_tool_name(prompt: str, mode: str) -> str:
    text = prompt or ""
    checks = [
        ("批量替换主体", ("替换主体", "主体替换")),
        ("AI详情页", ("详情页", "长图")),
        ("买家秀", ("买家秀", "晒单", "种草")),
        ("爆款主图", ("爆款主图", "主图")),
        ("白底图", ("白底图",)),
    ]
    for label, keywords in checks:
        if any(keyword in text for keyword in keywords):
            return label
    return "图生图" if mode == "edit" else "AI生图"


def _infer_product_name(prompt: str) -> str:
    text = prompt or ""
    patterns = [
        r"(?:商品名|商品名称|产品名|产品名称)\s*[:：]\s*([^\r\n，,。；;]+)",
        r"(?:为|给)\s*([^\r\n，,。；;]{2,36})\s*(?:生成|制作|设计)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            value = match.group(1).strip()
            if value:
                return value[:36]
    for line in text.splitlines():
        value = line.strip(" ：:，,。；;")
        if 2 <= len(value) <= 36 and not any(key in value for key in ("生成", "必须", "不要", "上传", "参考图")):
            return value
    return "未命名商品"


class ImageTaskService:
    def __init__(
        self,
        path: Path,
        *,
        generation_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_generations.handle,
        edit_handler: Callable[[dict[str, Any]], dict[str, Any]] = openai_v1_image_edit.handle,
        retention_days_getter: Callable[[], int] | None = None,
    ):
        self.path = path
        self.generation_handler = generation_handler
        self.edit_handler = edit_handler
        self.retention_days_getter = retention_days_getter or (lambda: config.image_retention_days)
        self.store_key = path.name
        self.cache_path = path.with_name(f"{path.stem}_cache.json")
        self.cache_store_key = self.cache_path.name
        self._lock = threading.RLock()
        self._tasks: dict[str, dict[str, Any]] = {}
        self._cache: dict[str, dict[str, Any]] = {}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._tasks = self._load_locked()
            self._cache = self._load_cache_locked()
            changed = self._recover_unfinished_locked()
            changed = self._cleanup_locked() or changed
            if changed:
                self._save_locked()

    def submit_generation(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        base_url: str,
        group_id: str | None = None,
        group_title: str | None = None,
        group_index: int | None = None,
    ) -> dict[str, Any]:
        payload = {
            "prompt": prompt,
            "model": model,
            "n": 1,
            "size": size,
            "response_format": "url",
            "base_url": base_url,
            "group_id": group_id,
            "group_title": group_title,
            "group_index": group_index,
        }
        return self._submit(identity, client_task_id=client_task_id, mode="generate", payload=payload)

    def submit_edit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        base_url: str,
        images: list[tuple[bytes, str, str]],
        group_id: str | None = None,
        group_title: str | None = None,
        group_index: int | None = None,
    ) -> dict[str, Any]:
        payload = {
            "prompt": prompt,
            "images": images,
            "model": model,
            "n": 1,
            "size": size,
            "response_format": "url",
            "base_url": base_url,
            "group_id": group_id,
            "group_title": group_title,
            "group_index": group_index,
        }
        return self._submit(identity, client_task_id=client_task_id, mode="edit", payload=payload)

    def list_tasks(self, identity: dict[str, object], task_ids: list[str]) -> dict[str, Any]:
        owner = _owner_id(identity)
        requested_ids = [_clean(task_id) for task_id in task_ids if _clean(task_id)]
        with self._lock:
            changed = self._mark_stale_unfinished_locked()
            if self._cleanup_locked():
                changed = True
            if changed:
                self._save_locked()
            items = []
            missing_ids = []
            for task_id in requested_ids:
                task = self._tasks.get(_task_key(owner, task_id))
                if task is None:
                    missing_ids.append(task_id)
                else:
                    items.append(_public_task(task))
            if not requested_ids:
                items = [
                    _public_task(task)
                    for task in self._tasks.values()
                    if task.get("owner_id") == owner
                ]
                items.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
                missing_ids = []
            return {"items": items, "missing_ids": missing_ids}

    def cancel_tasks(self, identity: dict[str, object], task_ids: list[str]) -> dict[str, Any]:
        """标记任务为已取消。

        - queued: 直接置为 canceled，工作线程启动时会发现并跳过实际请求
        - running: 置为 canceled，工作线程会在请求结束后丢弃结果而不写入
        - 终态(success/error/canceled): 不动

        每条真正被取消（queued / running 翻 canceled）的任务都退还 1 张入口预扣额度。
        终态条目不退——success 已经出图了不能扣回去，error/canceled 已经退过了。
        """
        owner = _owner_id(identity)
        requested_ids = [_clean(task_id) for task_id in task_ids if _clean(task_id)]
        canceled: list[str] = []
        skipped: list[str] = []
        missing_ids: list[str] = []
        with self._lock:
            for task_id in requested_ids:
                task = self._tasks.get(_task_key(owner, task_id))
                if task is None:
                    missing_ids.append(task_id)
                    continue
                status = task.get("status")
                if status in TERMINAL_STATUSES:
                    skipped.append(task_id)
                    continue
                task["status"] = TASK_STATUS_CANCELED
                task["error"] = "已取消"
                task["updated_at"] = _now_iso()
                canceled.append(task_id)
            if canceled:
                self._save_locked()
        # 退款放到锁外做：DataStore / DB 写盘期间不持有 self._lock，
        # 避免与 _run_task 失败分支同时拿锁形成竞态。
        for _ in canceled:
            self._refund_one(identity)
        for task_id in canceled:
            with self._lock:
                task = dict(self._tasks.get(_task_key(owner, task_id)) or {})
            self._send_webhook(identity, "image_task.canceled", task)
        return {"canceled": canceled, "skipped": skipped, "missing_ids": missing_ids}

    def rerun_task(self, identity: dict[str, object], task_id: str, *, base_url: str) -> dict[str, Any]:
        owner = _owner_id(identity)
        source_id = _clean(task_id)
        if not source_id:
            raise ValueError("task_id is required")
        with self._lock:
            source = self._tasks.get(_task_key(owner, source_id))
            if source is None:
                raise ValueError("任务不存在")
            if source.get("mode") != "generate":
                raise ValueError("当前仅支持文生图任务重新生成")
            prompt = _clean(source.get("prompt"))
            if not prompt:
                raise ValueError("这个任务没有可复用提示词")
            model = _clean(source.get("model"), "gpt-image-2")
            size = _clean(source.get("size"))
        return self.submit_generation(
            identity,
            client_task_id=f"{source_id}-rerun-{int(time.time())}",
            prompt=prompt,
            model=model,
            size=size or None,
            base_url=base_url,
        )

    def _refund_one(self, identity: dict[str, object]) -> None:
        """退还 1 张入口预扣额度。
        admin / unlimited / 匿名身份内部 noop；普通用户的 used 减 1 不会跌破 0。
        所有异常吞掉——退款失败不该影响主流程的错误响应。
        """
        role = str(identity.get("role") or "").strip().lower()
        item_id = str(identity.get("id") or "").strip()
        if role == "admin" or not item_id or item_id == "admin":
            return
        try:
            # 延迟 import 避免 services 间循环引用
            from services.auth_service import auth_service
            auth_service.refund_quota(item_id, 1)
        except Exception:
            pass

    def _submit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        mode: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        task_id = _clean(client_task_id)
        if not task_id:
            raise ValueError("client_task_id is required")
        owner = _owner_id(identity)
        key = _task_key(owner, task_id)
        now = _now_iso()
        should_start = False
        request_cache_key = _cache_key(mode, payload)
        with self._lock:
            cleaned = self._cleanup_locked()
            task = self._tasks.get(key)
            if task is not None:
                if cleaned:
                    self._save_locked()
                return _public_task(task)
            cached = self._cache.get(request_cache_key)
            cached_data = cached.get("data") if isinstance(cached, dict) else None
            if isinstance(cached_data, list) and cached_data:
                task = {
                    "id": task_id,
                    "owner_id": owner,
                    "status": TASK_STATUS_SUCCESS,
                    "mode": mode,
                    "model": _clean(payload.get("model"), "gpt-image-2"),
                    "size": _clean(payload.get("size")),
                    "prompt": _clean(payload.get("prompt")),
                    "retry_count": 0,
                    "cached": True,
                    "data": cached_data,
                    "created_at": now,
                    "updated_at": now,
                }
                if _clean(payload.get("group_id")):
                    task["group_id"] = _clean(payload.get("group_id"))
                if _clean(payload.get("group_title")):
                    task["group_title"] = _clean(payload.get("group_title"))
                if payload.get("group_index") is not None:
                    task["group_index"] = int(payload.get("group_index") or 0)
                self._tasks[key] = task
                self._save_locked()
                record_owner_for_result(identity, cached_data)
                record_prompt_for_result(payload.get("prompt"), cached_data, is_edit=(mode == "edit"))
                self._send_webhook(identity, "image_task.success", task)
                return _public_task(task)
            task = {
                "id": task_id,
                "owner_id": owner,
                "status": TASK_STATUS_QUEUED,
                "mode": mode,
                "model": _clean(payload.get("model"), "gpt-image-2"),
                "size": _clean(payload.get("size")),
                "prompt": _clean(payload.get("prompt")),
                "retry_count": 0,
                "cache_key": request_cache_key,
                "created_at": now,
                "updated_at": now,
            }
            if _clean(payload.get("group_id")):
                task["group_id"] = _clean(payload.get("group_id"))
            if _clean(payload.get("group_title")):
                task["group_title"] = _clean(payload.get("group_title"))
            if payload.get("group_index") is not None:
                task["group_index"] = int(payload.get("group_index") or 0)
            self._tasks[key] = task
            self._save_locked()
            should_start = True

        if should_start:
            thread = threading.Thread(
                target=self._run_task,
                args=(key, mode, payload, dict(identity), _clean(payload.get("model"), "gpt-image-2")),
                name=f"image-task-{task_id[:16]}",
                daemon=True,
            )
            thread.start()
        return _public_task(task)

    def _run_task(
        self,
        key: str,
        mode: str,
        payload: dict[str, Any],
        identity: dict[str, object],
        model: str,
    ) -> None:
        # 启动前检查：若任务已被取消，直接结束
        with self._lock:
            task = self._tasks.get(key)
            if task is None or task.get("status") == TASK_STATUS_CANCELED:
                return

        started = time.time()
        self._update_task(key, status=TASK_STATUS_RUNNING, error="")
        max_attempts = 3
        attempt = 0
        while attempt < max_attempts:
            attempt += 1
            try:
                handler = self.edit_handler if mode == "edit" else self.generation_handler
                result = handler(payload)
                break
            except Exception as exc:
                with self._lock:
                    task = self._tasks.get(key)
                    if task is not None:
                        task["retry_count"] = attempt - 1
                        task["updated_at"] = _now_iso()
                        self._save_locked()
                if attempt < max_attempts:
                    time.sleep(1.5)
                    continue
                raise exc
        try:
            # 请求结束后再检查：若期间被取消，丢弃结果不写回
            with self._lock:
                task = self._tasks.get(key)
                if task is None or task.get("status") == TASK_STATUS_CANCELED:
                    return
            if not isinstance(result, dict):
                raise RuntimeError("image task returned streaming result unexpectedly")
            data = result.get("data")
            if not isinstance(data, list) or not data:
                message = _clean(result.get("message")) or "image task returned no image data"
                raise RuntimeError(message)
            self._update_task(key, status=TASK_STATUS_SUCCESS, data=data, error="")
            self._store_cache_for_task(key, data)
            # 任务真正成功后再写归属表，避免给失败的临时落盘也挂上 owner。
            # admin / 匿名身份不写，由 record_owner_for_result 内部判断。
            record_owner_for_result(identity, data)
            # prompt 文本同步写一份，给"我的作品"页 / 画廊发布功能复用。
            # mode=="edit" 时标记为图生图，画廊发布时会自动把 prompt 落空——
            # 图生图的 prompt 是相对参考图的指令，离开参考图对外人没复用价值。
            record_prompt_for_result(
                payload.get("prompt"), data, is_edit=(mode == "edit")
            )
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用完成",
                request_preview=request_text(payload.get("prompt")),
                urls=_collect_image_urls(data),
            )
            with self._lock:
                finished_task = dict(self._tasks.get(key) or {})
            self._send_webhook(identity, "image_task.success", finished_task)
        except Exception as exc:
            # 请求异常时也要让"已取消"优先，不要把取消覆盖成 error
            with self._lock:
                task = self._tasks.get(key)
                if task is not None and task.get("status") == TASK_STATUS_CANCELED:
                    return
            error_message = str(exc) or "image task failed"
            self._update_task(key, status=TASK_STATUS_ERROR, error=error_message, data=[])
            with self._lock:
                failed_task = dict(self._tasks.get(key) or {})
            self._send_webhook(identity, "image_task.error", failed_task)
            # 上游真失败：退还入口预扣的 1 张额度。
            # admin / unlimited 在 _refund_one 内部 noop；普通用户的 used 减 1 不会跌破 0。
            self._refund_one(identity)
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用失败",
                request_preview=request_text(payload.get("prompt")),
                status="failed",
                error=error_message,
            )

    def _log_call(
        self,
        identity: dict[str, object],
        mode: str,
        model: str,
        started: float,
        suffix: str,
        *,
        request_preview: str = "",
        status: str = "success",
        error: str = "",
        urls: list[str] | None = None,
    ) -> None:
        endpoint = "/v1/images/edits" if mode == "edit" else "/v1/images/generations"
        summary_prefix = "图生图" if mode == "edit" else "文生图"
        detail = {
            "key_id": identity.get("id"),
            "key_name": identity.get("name"),
            "role": identity.get("role"),
            "endpoint": endpoint,
            "model": model,
            "started_at": datetime.fromtimestamp(started).strftime("%Y-%m-%d %H:%M:%S"),
            "ended_at": _now_iso(),
            "duration_ms": int((time.time() - started) * 1000),
            "status": status,
        }
        if request_preview:
            detail["request_text"] = request_preview
        if error:
            detail["error"] = error
        if urls:
            detail["urls"] = list(dict.fromkeys(urls))
        try:
            log_service.add(LOG_TYPE_CALL, f"{summary_prefix}{suffix}", detail)
        except Exception:
            pass

    def _load_cache_locked(self) -> dict[str, dict[str, Any]]:
        content = read_text(self.cache_store_key, self.cache_path)
        if not content:
            return {}
        try:
            raw = json.loads(content)
        except Exception:
            return {}
        cache = raw.get("items") if isinstance(raw, dict) else raw
        if not isinstance(cache, dict):
            return {}
        result: dict[str, dict[str, Any]] = {}
        for key, value in cache.items():
            if isinstance(key, str) and isinstance(value, dict) and isinstance(value.get("data"), list):
                result[key] = {
                    "created_at": _clean(value.get("created_at"), _now_iso()),
                    "data": value.get("data"),
                }
        return result

    def _save_cache_locked(self) -> None:
        items = dict(sorted(self._cache.items(), key=lambda item: str(item[1].get("created_at") or ""), reverse=True)[:500])
        self._cache = items
        write_text(self.cache_store_key, self.cache_path, json.dumps({"items": items}, ensure_ascii=False, indent=2) + "\n")

    def _store_cache_for_task(self, key: str, data: list[Any]) -> None:
        if not data:
            return
        with self._lock:
            task = self._tasks.get(key)
            cache_key = _clean((task or {}).get("cache_key"))
            if not cache_key:
                return
            self._cache[cache_key] = {"created_at": _now_iso(), "data": data}
            self._save_cache_locked()

    def _send_webhook(self, identity: dict[str, object], event: str, task: dict[str, Any]) -> None:
        key_id = _clean(identity.get("id"))
        if not key_id or key_id == "admin":
            return
        try:
            from services.auth_service import auth_service
            record = auth_service.get_by_id(key_id)
            url = _clean((record or {}).get("webhook_url"))
        except Exception:
            url = ""
        if not url:
            return

        payload = {
            "event": event,
            "task": _public_task(task),
            "user": {
                "id": identity.get("id"),
                "name": identity.get("name"),
                "role": identity.get("role"),
            },
        }

        def worker() -> None:
            try:
                data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                request = urllib.request.Request(
                    url,
                    data=data,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=5):
                    pass
            except (urllib.error.URLError, TimeoutError, OSError, ValueError):
                pass

        threading.Thread(target=worker, name=f"image-task-webhook-{_clean(task.get('id'))[:16]}", daemon=True).start()

    def _update_task(self, key: str, **updates: Any) -> None:
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                return
            task.update(updates)
            task["updated_at"] = _now_iso()
            self._save_locked()

    def _load_locked(self) -> dict[str, dict[str, Any]]:
        content = read_text(self.store_key, self.path)
        if not content:
            return {}
        try:
            raw = json.loads(content)
        except Exception:
            return {}
        raw_items = raw.get("tasks") if isinstance(raw, dict) else raw
        if not isinstance(raw_items, list):
            return {}
        tasks: dict[str, dict[str, Any]] = {}
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            task_id = _clean(item.get("id"))
            owner = _clean(item.get("owner_id"))
            if not task_id or not owner:
                continue
            status = _clean(item.get("status"))
            if status not in VALID_STATUSES:
                status = TASK_STATUS_ERROR
            task = {
                "id": task_id,
                "owner_id": owner,
                "status": status,
                "mode": "edit" if item.get("mode") == "edit" else "generate",
                "model": _clean(item.get("model"), "gpt-image-2"),
                "size": _clean(item.get("size")),
                "prompt": _clean(item.get("prompt")),
                "retry_count": int(item.get("retry_count") or 0),
                "created_at": _clean(item.get("created_at"), _now_iso()),
                "updated_at": _clean(item.get("updated_at"), _clean(item.get("created_at"), _now_iso())),
            }
            if _clean(item.get("cache_key")):
                task["cache_key"] = _clean(item.get("cache_key"))
            if item.get("cached") is not None:
                task["cached"] = bool(item.get("cached"))
            if _clean(item.get("group_id")):
                task["group_id"] = _clean(item.get("group_id"))
            if _clean(item.get("group_title")):
                task["group_title"] = _clean(item.get("group_title"))
            if item.get("group_index") is not None:
                task["group_index"] = int(item.get("group_index") or 0)
            data = item.get("data")
            if isinstance(data, list):
                task["data"] = data
            error = _clean(item.get("error"))
            if error:
                task["error"] = error
            tasks[_task_key(owner, task_id)] = task
        return tasks

    def _save_locked(self) -> None:
        items = sorted(self._tasks.values(), key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        write_text(self.store_key, self.path, json.dumps({"tasks": items}, ensure_ascii=False, indent=2) + "\n")

    def image_group_index(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            tasks = [dict(task) for task in self._tasks.values()]
        index: dict[str, dict[str, Any]] = {}
        task_groups: dict[str, list[dict[str, Any]]] = {}
        for task in tasks:
            if task.get("status") != TASK_STATUS_SUCCESS:
                continue
            data = _public_task_data(task.get("data"))
            if not isinstance(data, list):
                continue
            rels: list[str] = []
            seen: set[str] = set()
            for entry in data:
                rel = _result_rel(entry)
                if not rel or rel in seen:
                    continue
                seen.add(rel)
                rels.append(rel)
            if not rels:
                continue
            prompt = _clean(task.get("prompt"))
            tool_name = _infer_tool_name(prompt, _clean(task.get("mode")))
            product_name = _infer_product_name(prompt)
            fallback = _fallback_task_group(_clean(task.get("id")))
            group_id = _clean(task.get("group_id")) or (fallback[0] if fallback else "")
            group_index = int(task.get("group_index") if task.get("group_index") is not None else (fallback[1] if fallback else 0))
            title = f"{tool_name} {product_name}".strip()
            if len(rels) == 1 and group_id:
                task_groups.setdefault(group_id, []).append(
                    {
                        "rel": rels[0],
                        "group_index": group_index,
                        "group_title": title,
                        "tool_name": tool_name,
                        "product_name": product_name,
                        "created_at": _clean(task.get("created_at")),
                    }
                )
                continue
            group_id = group_id or _clean(task.get("id")) or "|".join(rels)
            for idx, rel in enumerate(rels):
                index[rel] = {
                    "group_id": group_id,
                    "group_title": title,
                    "group_count": len(rels),
                    "group_index": idx,
                    "group_rels": rels,
                    "tool_name": tool_name,
                    "product_name": product_name,
                    "task_status": _clean(task.get("status")),
                    "task_size": _clean(task.get("size")),
                    "task_model": _clean(task.get("model")),
                }
        for group_id, grouped_items in task_groups.items():
            if len(grouped_items) <= 1:
                continue
            grouped_items.sort(key=lambda item: (int(item.get("group_index") or 0), str(item.get("created_at") or ""), str(item.get("rel") or "")))
            rels = [str(item["rel"]) for item in grouped_items if item.get("rel")]
            if len(rels) <= 1:
                continue
            first = grouped_items[0]
            for idx, item in enumerate(grouped_items):
                rel = str(item.get("rel") or "")
                if not rel:
                    continue
                index[rel] = {
                    "group_id": group_id,
                    "group_title": str(first.get("group_title") or "Image batch"),
                    "group_count": len(rels),
                    "group_index": idx,
                    "group_rels": rels,
                    "tool_name": str(first.get("tool_name") or ""),
                    "product_name": str(first.get("product_name") or ""),
                    "task_status": TASK_STATUS_SUCCESS,
                }
        return index

    def _recover_unfinished_locked(self) -> bool:
        changed = False
        for task in self._tasks.values():
            if task.get("status") in UNFINISHED_STATUSES:
                task["status"] = TASK_STATUS_ERROR
                task["error"] = "服务已重启，未完成的图片任务已中断"
                task["updated_at"] = _now_iso()
                changed = True
        return changed

    def _mark_stale_unfinished_locked(self) -> bool:
        changed = False
        cutoff = time.time() - _stale_unfinished_seconds()
        for task in self._tasks.values():
            if task.get("status") not in UNFINISHED_STATUSES:
                continue
            updated_at = _timestamp(task.get("updated_at") or task.get("created_at"))
            if updated_at <= 0 or updated_at >= cutoff:
                continue
            task["status"] = TASK_STATUS_ERROR
            task["error"] = "图片任务超时未完成，已自动标记失败，请联系管理员检查账号、额度或上游服务状态"
            task["updated_at"] = _now_iso()
            changed = True
        return changed

    def _cleanup_locked(self) -> bool:
        try:
            retention_days = max(1, int(self.retention_days_getter()))
        except Exception:
            retention_days = 30
        cutoff = time.time() - retention_days * 86400
        removed_keys = [
            key
            for key, task in self._tasks.items()
            if task.get("status") in TERMINAL_STATUSES and _timestamp(task.get("updated_at")) < cutoff
        ]
        for key in removed_keys:
            self._tasks.pop(key, None)
        return bool(removed_keys)


image_task_service = ImageTaskService(DATA_DIR / "image_tasks.json")


def get_image_task_group_index() -> dict[str, dict[str, Any]]:
    return image_task_service.image_group_index()
