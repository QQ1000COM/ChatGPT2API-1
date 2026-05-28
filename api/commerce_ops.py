from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict

from api.support import require_admin, require_identity
from services import commerce_ops_service as ops


class LooseBody(BaseModel):
    model_config = ConfigDict(extra="allow")


def _owner_id(identity: dict[str, object]) -> str:
    return str(identity.get("id") or "").strip() or "anonymous"


def create_router() -> APIRouter:
    router = APIRouter()

    @router.api_route("/api/templates", methods=["GET", "POST", "DELETE"])
    @router.api_route("/api/templates/{item_id}", methods=["GET", "POST", "DELETE"])
    @router.api_route("/api/home-cases", methods=["GET", "POST", "DELETE"])
    @router.api_route("/api/home-cases/{item_id}", methods=["GET", "POST", "DELETE"])
    @router.api_route("/api/public-home-cases", methods=["GET"])
    async def removed_commerce_catalogs():
        raise HTTPException(status_code=404, detail={"error": "该功能已删除"})

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
