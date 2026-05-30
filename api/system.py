from __future__ import annotations

import json
import re
from urllib.parse import parse_qs, quote, urlencode

from curl_cffi import requests
from fastapi import APIRouter, File, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import RedirectResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict

from api.support import require_admin, require_identity, resolve_image_base_url
from services.auth_service import auth_service
from services.backup_service import BackupError, backup_service
from services.config import config
from services import gallery_service
from services.image_owners_service import get_owner, owner_counts
from services.image_service import count_total_images, dedupe_similar_images, delete_images, download_images_zip, get_image_download_response, get_thumbnail_response, list_images
from services.image_tags_service import delete_tag, get_all_tags, set_tags
from services.log_service import log_service
from services.proxy_service import test_proxy
from services.remote_storage_service import RemoteStorageError, test_remote_storage


API_USAGE_COUNTERS = (
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
)

OPENAI_API_PRICING = {
    "default_model": "gpt-5.1",
    "currency": "USD",
    "unit": "per_1m_tokens",
    "source": "https://openai.com/api/pricing",
    "updated_at": "2026-05-30",
    "models": {
        "gpt-5.1": {"input": 1.25, "cached_input": 0.125, "output": 10.0},
        "gpt-5.1-codex": {"input": 1.25, "cached_input": 0.125, "output": 10.0},
        "gpt-5.1-codex-mini": {"input": 0.25, "cached_input": 0.025, "output": 2.0},
        "gpt-5-mini": {"input": 0.25, "cached_input": 0.025, "output": 2.0},
        "gpt-5-nano": {"input": 0.05, "cached_input": 0.005, "output": 0.4},
    },
}


def _admin_owner_ids() -> set[str]:
    """收集所有可能落在 image_owners.json 里的 admin id：
    - "admin"：旧 auth_key（CHATGPT2API_AUTH_KEY / config.json.auth-key）的固定 id
    - 其余：通过 auth_service 创建的 admin 角色密钥
    用来把"管理员生成"和"真孤儿"两个桶区分开，别再混在一起。
    """
    ids: set[str] = {"admin"}
    for item in auth_service.list_keys(role="admin"):
        uid = str(item.get("id") or "").strip()
        if uid:
            ids.add(uid)
    return ids


def _owner_names() -> dict[str, str]:
    names = {"admin": "管理员"}
    for item in auth_service.list_keys(role="user"):
        uid = str(item.get("id") or "").strip()
        if uid:
            names[uid] = str(item.get("name") or uid)
    return names


def _request_origin(request: Request) -> str:
    scheme = str(request.headers.get("x-forwarded-proto") or request.url.scheme).split(",")[0].strip()
    host = str(request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc).split(",")[0].strip()
    return f"{scheme}://{host}".rstrip("/")


def _empty_api_usage() -> dict[str, int]:
    return {key: 0 for key in API_USAGE_COUNTERS}


def _normalize_api_usage(value: object) -> dict[str, int]:
    raw = value if isinstance(value, dict) else {}
    result = _empty_api_usage()
    for key in API_USAGE_COUNTERS:
        try:
            result[key] = max(0, int(raw.get(key) or 0))
        except (TypeError, ValueError):
            result[key] = 0
    return result


def _aggregate_api_usage(items: list[dict[str, object]]) -> dict[str, int]:
    total = _empty_api_usage()
    for item in items:
        usage = _normalize_api_usage(item.get("usage"))
        for key, value in usage.items():
            total[key] += value
    return total


def _api_usage_summary(profile: dict[str, object]) -> dict[str, object]:
    usage = _normalize_api_usage(profile.get("usage"))
    price = OPENAI_API_PRICING["models"][OPENAI_API_PRICING["default_model"]]
    input_cost = usage["input_tokens"] / 1_000_000 * float(price["input"])
    output_cost = usage["output_tokens"] / 1_000_000 * float(price["output"])
    total_calls = (
        usage["chat_calls"]
        + usage["response_calls"]
        + usage["message_calls"]
        + usage["image_calls"]
        + usage["model_calls"]
        + usage["search_calls"]
    )
    return {
        "usage": usage,
        "total_calls": total_calls,
        "estimated_cost_usd": round(input_cost + output_cost, 6),
        "pricing_model": OPENAI_API_PRICING["default_model"],
    }


def _qq_callback_url(request: Request) -> str:
    return f"{_request_origin(request)}/api/oauth/qq/callback"


def _profile_redirect(request: Request, status: str, message: str = "") -> RedirectResponse:
    params = {"qq_bind": status}
    if message:
        params["message"] = message
    return RedirectResponse(f"{_request_origin(request)}/profile?{urlencode(params)}", status_code=302)


def _login_redirect(request: Request, status: str, token: str = "", message: str = "") -> RedirectResponse:
    params = {"qq_login": status}
    if token:
        params["token"] = token
    if message:
        params["message"] = message
    return RedirectResponse(f"{_request_origin(request)}/login?{urlencode(params)}", status_code=302)


def _parse_qq_openid(payload: str) -> str:
    match = re.search(r"\{.*\}", payload or "", re.S)
    if not match:
        raise ValueError("QQ 未返回 openid")
    data = json.loads(match.group(0))
    openid = str(data.get("openid") or "").strip()
    if not openid:
        raise ValueError("QQ openid 为空")
    return openid


def _create_qq_user(openid: str) -> dict[str, object]:
    settings = config.get_qq_oauth_settings()
    quota = max(0, int(settings.get("new_user_free_quota") or 0))
    suffix = openid[-6:] if len(openid) >= 6 else openid
    for index in range(1, 20):
        name = f"QQ用户 {suffix}" if index == 1 else f"QQ用户 {suffix}-{index}"
        try:
            profile, _raw_key = auth_service.create_key(
                role="user",
                name=name,
                quota=quota,
                unlimited=False,
            )
            break
        except ValueError:
            continue
    else:
        raise ValueError("QQ 用户账号创建失败，请稍后重试")
    bound = auth_service.bind_qq(str(profile.get("id") or ""), openid)
    return bound or profile


def _apply_invite_reward(invite_code: str, new_user_id: str) -> None:
    inviter_id = str(invite_code or "").strip()
    if not inviter_id or inviter_id == str(new_user_id or "").strip() or inviter_id == "admin":
        return
    reward = int(config.get_qq_oauth_settings().get("invite_reward_quota") or 5)
    if reward <= 0:
        return
    auth_service.add_quota(inviter_id, reward)


def _exchange_qq_openid(code: str, redirect_uri: str) -> str:
    settings = config.get_qq_oauth_settings()
    app_id = str(settings.get("app_id") or "").strip()
    app_key = str(settings.get("app_key") or "").strip()
    if not app_id or not app_key:
        raise ValueError("后台未配置 QQ APP ID 或 APP Key")
    token_response = requests.get(
        "https://graph.qq.com/oauth2.0/token",
        params={
            "grant_type": "authorization_code",
            "client_id": app_id,
            "client_secret": app_key,
            "code": code,
            "redirect_uri": redirect_uri,
        },
        timeout=20,
        impersonate="chrome",
    )
    token_text = token_response.text
    token_params = parse_qs(token_text, keep_blank_values=True)
    access_token = str((token_params.get("access_token") or [""])[0]).strip()
    if not access_token:
        raise ValueError(f"QQ access_token 获取失败：{token_text[:120]}")
    openid_response = requests.get(
        "https://graph.qq.com/oauth2.0/me",
        params={"access_token": access_token},
        timeout=20,
        impersonate="chrome",
    )
    return _parse_qq_openid(openid_response.text)


class SettingsUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")


class ProxyTestRequest(BaseModel):
    url: str = ""


class ImageDeleteRequest(BaseModel):
    paths: list[str] = []
    start_date: str = ""
    end_date: str = ""
    owner: str = ""
    all_matching: bool = False

class ImageDownloadRequest(BaseModel):
    paths: list[str]

class ImageTagsRequest(BaseModel):
    path: str
    tags: list[str]

class ImageDedupeRequest(BaseModel):
    threshold: int = 4
    dry_run: bool = True

class LogDeleteRequest(BaseModel):
    ids: list[str] = []
class BackupDeleteRequest(BaseModel):
    key: str = ""


class BackupRestoreRequest(BaseModel):
    key: str = ""


class QQBindRequest(BaseModel):
    qq: str = ""


def create_router(app_version: str) -> APIRouter:
    router = APIRouter()

    @router.post("/auth/login")
    async def login(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return {
            "ok": True,
            "version": app_version,
            "role": identity.get("role"),
            "subject_id": identity.get("id"),
            "name": identity.get("name"),
        }

    @router.get("/version")
    async def get_version():
        return {"version": app_version}

    @router.get("/api/public-config")
    async def get_public_config():
        announcement = config.data.get("announcement") if isinstance(config.data.get("announcement"), dict) else {}
        return {
            "site_name": config.site_name,
            "browser_title": config.browser_title,
            "announcement_enabled": bool(announcement.get("enabled")),
            "announcement_html": str(announcement.get("html") or ""),
            "qq_oauth_enabled": bool(str(config.get_qq_oauth_settings().get("app_id") or "").strip()),
            "new_user_free_quota": int(config.get_qq_oauth_settings().get("new_user_free_quota") or 0),
            "invite_reward_quota": int(config.get_qq_oauth_settings().get("invite_reward_quota") or 5),
        }

    @router.get("/api/public-cases")
    async def get_public_cases(request: Request):
        return gallery_service.list_feed(
            cursor=None,
            limit=9,
            image_base_url=resolve_image_base_url(request),
            include_hidden=False,
            viewer_id="",
        )

    @router.get("/api/me/profile")
    async def get_my_profile(request: Request, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        identity_id = str(identity.get("id") or "").strip()
        profile = auth_service.get_by_id(identity_id) if identity_id != "admin" else None
        if profile is None:
            admin_profile = config.get_admin_profile() if identity_id == "admin" else {}
            admin_usage = _aggregate_api_usage(auth_service.list_keys()) if identity_id == "admin" else _empty_api_usage()
            profile = {
                "id": identity_id or "admin",
                "name": identity.get("name") or "管理员",
                "role": identity.get("role") or "admin",
                "quota": 0,
                "used": 0,
                "unlimited": True,
                "remaining": None,
                "qq": admin_profile.get("qq") or "",
                "qq_bound_at": admin_profile.get("qq_bound_at"),
                "usage": admin_usage,
            }
        admin_ids = _admin_owner_ids()
        owner_filter = "__admin__" if str(identity.get("role") or "") == "admin" or identity_id in admin_ids else identity_id
        images = list_images(resolve_image_base_url(request), owner=owner_filter, admin_ids=admin_ids, owner_names=_owner_names())
        image_items = images.get("items", [])
        image_count = len(image_items)
        try:
            profile_used = int(profile.get("used") or 0)
        except (TypeError, ValueError):
            profile_used = 0
        if image_count > profile_used:
            profile = dict(profile)
            profile["used"] = image_count
        return {
            "profile": profile,
            "image_count": image_count,
            "images": image_items[:60],
            "qq_callback_url": _qq_callback_url(request),
            "qq_oauth_enabled": bool(str(config.get_qq_oauth_settings().get("app_id") or "").strip()),
            "api_base_url": f"{_request_origin(request)}/v1",
            "api_usage": _api_usage_summary(profile),
            "api_pricing": OPENAI_API_PRICING,
        }

    @router.post("/api/me/qq-bind-url")
    async def create_my_qq_bind_url(request: Request, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        settings = config.get_qq_oauth_settings()
        app_id = str(settings.get("app_id") or "").strip()
        app_key = str(settings.get("app_key") or "").strip()
        if not app_id or not app_key:
            raise HTTPException(status_code=400, detail={"error": "后台未配置 QQ APP ID 或 APP Key"})
        state = config.create_qq_oauth_state(identity, purpose="bind")
        redirect_uri = _qq_callback_url(request)
        authorize_url = "https://graph.qq.com/oauth2.0/authorize?" + urlencode(
            {
                "response_type": "code",
                "client_id": app_id,
                "redirect_uri": redirect_uri,
                "state": state,
                "scope": "get_user_info",
            }
        )
        return {"authorize_url": authorize_url}

    @router.post("/api/oauth/qq/login-url")
    async def create_qq_login_url(request: Request):
        settings = config.get_qq_oauth_settings()
        app_id = str(settings.get("app_id") or "").strip()
        app_key = str(settings.get("app_key") or "").strip()
        if not app_id or not app_key:
            raise HTTPException(status_code=400, detail={"error": "后台未配置 QQ APP ID 或 APP Key"})
        invite_code = str(request.query_params.get("invite") or "").strip()
        state = config.create_qq_oauth_state(purpose="login", invite_code=invite_code)
        redirect_uri = _qq_callback_url(request)
        authorize_url = "https://graph.qq.com/oauth2.0/authorize?" + urlencode(
            {
                "response_type": "code",
                "client_id": app_id,
                "redirect_uri": redirect_uri,
                "state": state,
                "scope": "get_user_info",
            }
        )
        return {"authorize_url": authorize_url}

    @router.get("/api/oauth/qq/callback")
    async def qq_oauth_callback(request: Request, code: str = "", state: str = "", error: str = "", error_description: str = ""):
        if error:
            return _login_redirect(request, "error", message=error_description or error)
        oauth_state = config.consume_qq_oauth_state(state)
        if not oauth_state:
            return _login_redirect(request, "error", message="QQ 授权状态已过期，请重新操作")
        try:
            openid = await run_in_threadpool(_exchange_qq_openid, code, _qq_callback_url(request))
            if str(oauth_state.get("purpose") or "bind") == "login":
                admin_profile = config.get_admin_profile()
                if str(admin_profile.get("qq") or "").strip() == openid:
                    token = config.create_qq_login_session({"id": "admin", "name": "管理员", "role": "admin"})
                    return _login_redirect(request, "success", token=token)
                profile = auth_service.get_by_qq(openid)
                if profile is None:
                    profile = _create_qq_user(openid)
                    _apply_invite_reward(str(oauth_state.get("invite_code") or ""), str(profile.get("id") or ""))
                token = config.create_qq_login_session(profile)
                return _login_redirect(request, "success", token=token)
            identity_id = str(oauth_state.get("identity_id") or "").strip()
            if not identity_id or identity_id == "admin":
                config.bind_admin_qq(openid)
            else:
                profile = auth_service.bind_qq(identity_id, openid)
                if profile is None:
                    return _profile_redirect(request, "error", "绑定账号不存在")
        except Exception as exc:
            target = str(oauth_state.get("purpose") or "bind")
            if target == "login":
                return _login_redirect(request, "error", message=str(exc))
            return _profile_redirect(request, "error", str(exc))
        return _profile_redirect(request, "success")

    @router.post("/api/me/bind-qq")
    async def bind_my_qq(body: QQBindRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        identity_id = str(identity.get("id") or "").strip()
        if not identity_id or identity_id == "admin":
            admin_profile = config.bind_admin_qq(body.qq)
            return {
                "profile": {
                    "id": "admin",
                    "name": identity.get("name") or "管理员",
                    "role": identity.get("role") or "admin",
                    "quota": 0,
                    "used": 0,
                    "unlimited": True,
                    "remaining": None,
                    "qq": admin_profile.get("qq") or "",
                    "qq_bound_at": admin_profile.get("qq_bound_at"),
                }
            }
        profile = auth_service.bind_qq(identity_id, body.qq)
        if profile is None:
            raise HTTPException(status_code=404, detail={"error": "账号不存在"})
        return {"profile": profile}

    @router.get("/api/settings")
    async def get_settings(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"config": config.get()}

    @router.post("/api/settings")
    async def save_settings(body: SettingsUpdateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"config": config.update(body.model_dump(mode="python"))}

    @router.get("/api/images")
    async def get_images(
        request: Request,
        start_date: str = "",
        end_date: str = "",
        owner: str = "",
        q: str = "",
        tag: str = "",
        size: str = "",
        tool: str = "",
        status: str = "",
        authorization: str | None = Header(default=None),
    ):
        require_admin(authorization)
        return list_images(
            resolve_image_base_url(request),
            start_date=start_date.strip(),
            end_date=end_date.strip(),
            owner=owner.strip(),
            admin_ids=_admin_owner_ids(),
            query=q.strip(),
            tag=tag.strip(),
            size=size.strip(),
            tool=tool.strip(),
            status=status.strip(),
            owner_names=_owner_names(),
        )

    @router.get("/api/me/images")
    async def get_my_images(
        request: Request,
        start_date: str = "",
        end_date: str = "",
        authorization: str | None = Header(default=None),
    ):
        """登录用户视角的"我的图片"。

        鉴权用 require_identity，普通 user 密钥也能调；按 identity.id 自动过滤
        image_owners.json 里挂在自己名下的图。Admin 调时退化为 owner=__admin__,
        把所有 admin 生成的图聚合返回（语义上"我"= 管理员这个角色）。

        - Android / 未来其他客户端启动时 fetch 这个端点把云端历史合并进本地 Room
        - 不开放 owner 参数，避免用户冒名查别人的图
        """
        identity = require_identity(authorization)
        admin_ids = _admin_owner_ids()
        role = str(identity.get("role") or "").strip()
        identity_id = str(identity.get("id") or "").strip()
        if role == "admin" or identity_id in admin_ids:
            owner_filter = "__admin__"
        else:
            owner_filter = identity_id
        return list_images(
            resolve_image_base_url(request),
            start_date=start_date.strip(),
            end_date=end_date.strip(),
            owner=owner_filter,
            admin_ids=admin_ids,
            owner_names=_owner_names(),
        )

    @router.get("/api/images/owners")
    async def get_image_owners(authorization: str | None = Header(default=None)):
        """图片管理页用户筛选下拉的数据源。
        三类语义，互不混淆：
        1. 普通用户：列出所有用户密钥（即便 count=0），admin 期望"我建过的密钥都能筛"
        2. 管理员（__admin__）：所有 admin 角色（含旧 auth_key 的 "admin" id）生成的图聚合
        3. 未归属（__unowned__）：image_owners.json 里没记录的真孤儿，多半是老数据
        孤儿 user id（用户密钥已被删但归属表还留着）单列出来，标记 deleted=true。
        """
        require_admin(authorization)
        counts = owner_counts()
        admin_ids = _admin_owner_ids()
        users = auth_service.list_keys(role="user")
        items: list[dict[str, object]] = []
        seen_ids: set[str] = set()
        for user in users:
            uid = str(user.get("id") or "").strip()
            if not uid:
                continue
            seen_ids.add(uid)
            items.append({
                "id": uid,
                "name": user.get("name") or uid,
                "deleted": False,
                "count": int(counts.get(uid, 0)),
            })
        # admin 集合本身已经独立成一桶，所以 seen_ids 里要带上 admin_ids 防止重复
        seen_ids |= admin_ids
        admin_count = sum(int(c) for k, c in counts.items() if k in admin_ids)
        for owner_id, count in counts.items():
            if not owner_id or owner_id in seen_ids:
                continue
            items.append({
                "id": owner_id,
                "name": owner_id,
                "deleted": True,
                "count": int(count),
            })
        items.sort(key=lambda x: (-int(x.get("count") or 0), str(x.get("name") or "")))
        # 真孤儿 = 总图片数 − 已挂归属的所有图（含 admin / 用户 / 已删用户）
        owned_total = sum(int(v) for v in counts.values())
        unowned_count = max(0, count_total_images() - owned_total)
        # 两个固定桶；前端会把它们置顶到列表最上方。
        items.append({"id": "__admin__", "name": "管理员", "deleted": False, "count": admin_count})
        items.append({"id": "__unowned__", "name": "未归属", "deleted": False, "count": unowned_count})
        return {"items": items}

    @router.get("/image-thumbnails/{image_path:path}", include_in_schema=False)
    async def get_image_thumbnail(image_path: str):
        return get_thumbnail_response(image_path)

    @router.post("/api/images/delete")
    async def delete_images_endpoint(body: ImageDeleteRequest, authorization: str | None = Header(default=None)):
        """图片删除：
          - admin：全权，可按路径 / 按 owner / all_matching 任意筛选删
          - user：只能按路径删自己的图（image_owners.json 里 owner == identity.id）
            其余筛选参数 (start_date / end_date / owner / all_matching) 一律忽略，
            避免误把 all_matching=true 当成"清空所有"操作。
        """
        identity = require_identity(authorization)
        role = str(identity.get("role") or "").lower()
        if role == "admin":
            return delete_images(
                body.paths,
                start_date=body.start_date.strip(),
                end_date=body.end_date.strip(),
                owner=body.owner.strip(),
                all_matching=body.all_matching,
                admin_ids=_admin_owner_ids(),
            )
        # 普通用户路径：只允许按 paths 删自己拥有的图
        user_id = str(identity.get("id") or "").strip()
        if not user_id:
            raise HTTPException(status_code=403, detail={"error": "无权删除"})
        requested = [p.strip().lstrip("/") for p in (body.paths or []) if p and p.strip()]
        # owner 校验：每条 path 都必须 owner == 自己；不是的直接丢弃
        # 这样客户端误传别人的图也只是不删，不会泄露归属
        owned = [rel for rel in requested if get_owner(rel) == user_id]
        if not owned:
            return {"removed": 0}
        return delete_images(owned)

    @router.post("/api/images/dedupe")
    async def dedupe_images_endpoint(body: ImageDedupeRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return await run_in_threadpool(
            dedupe_similar_images,
            threshold=max(0, min(16, int(body.threshold or 4))),
            dry_run=bool(body.dry_run),
        )

    @router.post("/api/images/download")
    async def download_images_endpoint(body: ImageDownloadRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        role = str(identity.get("role") or "").lower()
        requested = [p.strip().lstrip("/") for p in (body.paths or []) if p and p.strip()]
        if role == "admin":
            paths = requested
        else:
            user_id = str(identity.get("id") or "").strip()
            paths = [rel for rel in requested if get_owner(rel) == user_id]
            if not paths:
                raise HTTPException(status_code=403, detail={"error": "无权下载这些图片"})
        buf = download_images_zip(paths)
        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="images.zip"'},
        )

    @router.get("/api/images/download/{image_path:path}")
    async def download_single_image_endpoint(image_path: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return get_image_download_response(image_path)

    @router.get("/api/logs")
    async def get_logs(type: str = "", start_date: str = "", end_date: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"items": log_service.list(type=type.strip(), start_date=start_date.strip(), end_date=end_date.strip())}

    @router.post("/api/logs/delete")
    async def delete_logs(body: LogDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return log_service.delete(body.ids)

    @router.post("/api/proxy/test")
    async def test_proxy_endpoint(body: ProxyTestRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        candidate = (body.url or "").strip() or config.get_proxy_settings()
        if not candidate:
            raise HTTPException(status_code=400, detail={"error": "proxy url is required"})
        return {"result": await run_in_threadpool(test_proxy, candidate)}

    @router.get("/api/storage/info")
    async def get_storage_info(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        storage = config.get_storage_backend()
        return {
            "backend": storage.get_backend_info(),
            "health": storage.health_check(),
        }

    @router.post("/api/backup/test")
    async def test_backup_connection(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"result": await run_in_threadpool(backup_service.test_connection)}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/remote-storage/test")
    async def test_remote_storage_connection(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"result": await run_in_threadpool(test_remote_storage)}
        except RemoteStorageError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/backups")
    async def get_backups(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {
                "items": await run_in_threadpool(backup_service.list_backups),
                "state": backup_service.get_status(),
                "settings": backup_service.get_settings(),
            }
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/backups/run")
    async def run_backup_endpoint(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"result": await run_in_threadpool(backup_service.run_backup)}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/backups/delete")
    async def delete_backup_endpoint(body: BackupDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            await run_in_threadpool(backup_service.delete_backup, body.key)
            return {"ok": True}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/backups/restore")
    async def restore_backup_endpoint(body: BackupRestoreRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"result": await run_in_threadpool(backup_service.restore_backup, body.key)}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/backups/import-local")
    async def import_local_backup_endpoint(file: UploadFile = File(...), authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            payload = await file.read()
            return {"result": await run_in_threadpool(backup_service.restore_backup_payload, payload, file.filename or "backup.tar.gz")}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/backups/detail")
    async def get_backup_detail(key: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            return {"item": await run_in_threadpool(backup_service.get_backup_detail, key)}
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.get("/api/backups/download")
    async def download_backup_endpoint(key: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            item = await run_in_threadpool(backup_service.download_backup, key)
        except BackupError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        filename = str(item.get("name") or "backup.bin")
        quoted = quote(filename)
        headers = {
            "Content-Disposition": f"attachment; filename*=UTF-8''{quoted}",
            "Content-Length": str(int(item.get("size") or 0)),
        }
        return Response(
            content=bytes(item.get("payload") or b""),
            media_type=str(item.get("content_type") or "application/octet-stream"),
            headers=headers,
        )


    @router.get("/api/images/tags")
    async def list_image_tags(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"tags": get_all_tags()}

    @router.post("/api/images/tags")
    async def update_image_tags(body: ImageTagsRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        rel = body.path.strip().lstrip("/")
        if not rel:
            raise HTTPException(status_code=400, detail={"error": "path is required"})
        tags = set_tags(rel, body.tags)
        return {"ok": True, "tags": tags}

    @router.delete("/api/images/tags/{tag}")
    async def delete_image_tag(tag: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        count = delete_tag(tag)
        return {"ok": True, "removed_from": count}

    return router
