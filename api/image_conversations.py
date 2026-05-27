from __future__ import annotations

from fastapi import APIRouter, Header
from pydantic import BaseModel, ConfigDict

from api.support import require_identity
from services import image_conversation_service as conversation_service


class ConversationPayload(BaseModel):
    model_config = ConfigDict(extra="allow")


class ConversationListPayload(BaseModel):
    items: list[dict] = []


class RenamePayload(BaseModel):
    title: str = ""


def _owner_id(identity: dict[str, object]) -> str:
    role = str(identity.get("role") or "").strip().lower()
    item_id = str(identity.get("id") or "").strip()
    if role == "admin" or item_id == "admin":
        return "admin"
    return item_id


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/image-conversations")
    async def list_image_conversations(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        return {"items": conversation_service.list_conversations(_owner_id(identity))}

    @router.put("/api/image-conversations")
    async def replace_image_conversations(body: ConversationListPayload, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        items = conversation_service.replace_conversations(_owner_id(identity), body.items)
        return {"items": items}

    @router.post("/api/image-conversations")
    async def save_image_conversation(body: ConversationPayload, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        item = conversation_service.upsert_conversation(_owner_id(identity), body.model_dump(mode="python"))
        return {"item": item}

    @router.post("/api/image-conversations/{conversation_id}/rename")
    async def rename_image_conversation(conversation_id: str, body: RenamePayload, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        item = conversation_service.rename_conversation(_owner_id(identity), conversation_id, body.title)
        return {"item": item}

    @router.delete("/api/image-conversations/{conversation_id}")
    async def delete_image_conversation(conversation_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        conversation_service.delete_conversation(_owner_id(identity), conversation_id)
        return {"ok": True}

    @router.delete("/api/image-conversations")
    async def clear_image_conversations(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        conversation_service.clear_conversations(_owner_id(identity))
        return {"ok": True}

    return router
