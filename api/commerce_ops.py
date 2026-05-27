from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from api.support import require_admin, require_identity, resolve_image_base_url
from services import commerce_ops_service as ops
from services import gallery_service


class LooseBody(BaseModel):
    model_config = ConfigDict(extra="allow")


def _owner_id(identity: dict[str, object]) -> str:
    return str(identity.get("id") or "").strip() or "anonymous"


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/templates")
    async def list_templates(include_hidden: bool = False, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        include = include_hidden and identity.get("role") == "admin"
        return {"items": ops.list_templates(include_hidden=include)}

    @router.post("/api/templates")
    async def save_template(body: LooseBody, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        item = ops.save_template(body.model_dump(mode="python"))
        return {"item": item, "items": ops.list_templates(include_hidden=True)}

    @router.delete("/api/templates/{item_id}")
    async def delete_template(item_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        if not ops.delete_template(item_id):
            raise HTTPException(status_code=404, detail={"error": "模板不存在"})
        return {"items": ops.list_templates(include_hidden=True)}

    @router.get("/api/home-cases")
    async def list_home_cases(include_hidden: bool = False, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        include = include_hidden and identity.get("role") == "admin"
        return {"items": ops.list_home_cases(include_hidden=include)}

    @router.post("/api/home-cases")
    async def save_home_case(body: LooseBody, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        item = ops.save_home_case(body.model_dump(mode="python"))
        return {"item": item, "items": ops.list_home_cases(include_hidden=True)}

    @router.delete("/api/home-cases/{item_id}")
    async def delete_home_case(item_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        if not ops.delete_home_case(item_id):
            raise HTTPException(status_code=404, detail={"error": "案例不存在"})
        return {"items": ops.list_home_cases(include_hidden=True)}

    @router.get("/api/public-home-cases")
    async def public_home_cases(request: Request):
        items = ops.list_home_cases(include_hidden=False)
        if items:
            return {"items": items[:12]}
        feed = gallery_service.list_feed(
            cursor=None,
            limit=9,
            image_base_url=resolve_image_base_url(request),
            include_hidden=False,
            viewer_id="",
        )
        return {"items": [
            {
                "id": item.get("id"),
                "title": item.get("prompt") or "真实案例",
                "image_url": item.get("url"),
                "image_rel": item.get("image_rel"),
                "category": item.get("model") or "画廊",
                "hidden": False,
                "sort": index,
            }
            for index, item in enumerate(feed.get("items", []))
        ]}

    @router.get("/api/me/feedback")
    async def my_feedback(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return {"items": ops.list_feedback(_owner_id(identity))}

    @router.post("/api/me/feedback")
    async def save_my_feedback(body: LooseBody, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        try:
            item = ops.save_feedback(_owner_id(identity), body.model_dump(mode="python"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return {"item": item, "items": ops.list_feedback(_owner_id(identity))}

    @router.get("/api/feedback/stats")
    async def feedback_stats(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return ops.feedback_stats()

    @router.post("/api/me/shares")
    async def create_share(body: LooseBody, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        item = ops.create_share(_owner_id(identity), body.model_dump(mode="python"))
        return {"item": item}

    @router.get("/api/shares/{token}")
    async def get_share(token: str):
        item = ops.get_share(token)
        if item is None:
            raise HTTPException(status_code=404, detail={"error": "分享不存在或已失效"})
        return {"item": item}

    @router.get("/api/me/onboarding")
    async def get_onboarding(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return {"state": ops.get_onboarding(_owner_id(identity))}

    @router.post("/api/me/onboarding")
    async def save_onboarding(body: LooseBody, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        state = ops.save_onboarding(_owner_id(identity), bool(body.model_dump(mode="python").get("dismissed")))
        return {"state": state}

    return router
