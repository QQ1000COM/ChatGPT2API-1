from __future__ import annotations

from fastapi import APIRouter, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from api.support import consume_user_quota, guard_api_request, refund_user_quota, require_commerce_permission, require_identity, resolve_image_base_url
from services.auth_service import auth_service
from services.content_filter import check_request
from services.image_task_service import image_task_service
from services.log_service import LoggedCall


class ImageGenerationTaskRequest(BaseModel):
    client_task_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-2"
    size: str | None = None
    group_id: str | None = None
    group_title: str | None = None
    group_index: int | None = None


class ImageTaskCancelRequest(BaseModel):
    ids: list[str] = Field(default_factory=list)


def _parse_task_ids(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _record_image_task_usage(identity: dict[str, object], *, attachments: int = 0) -> None:
    key_id = str(identity.get("id") or "").strip()
    if not key_id or key_id == "admin":
        return
    try:
        auth_service.add_usage(key_id, endpoint="image_tasks", images=1, attachments=attachments)
    except Exception:
        pass


async def filter_or_log(call: LoggedCall, text: str) -> None:
    try:
        await run_in_threadpool(check_request, text)
    except HTTPException as exc:
        call.log("璋冪敤澶辫触", status="failed", error=str(exc.detail))
        raise


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/image-tasks")
    async def list_image_tasks(
        ids: str = Query(default=""),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return await run_in_threadpool(image_task_service.list_tasks, identity, _parse_task_ids(ids))

    @router.post("/api/image-tasks/cancel")
    async def cancel_image_tasks(
        body: ImageTaskCancelRequest,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        ids = [task_id.strip() for task_id in body.ids if task_id and task_id.strip()]
        return await run_in_threadpool(image_task_service.cancel_tasks, identity, ids)

    @router.post("/api/image-tasks/{task_id}/rerun")
    async def rerun_image_task(
        task_id: str,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        with guard_api_request(identity, "image_tasks"):
            pass
        consume_user_quota(identity, 1)
        try:
            return await run_in_threadpool(image_task_service.rerun_task, identity, task_id, base_url=resolve_image_base_url(request))
        except ValueError as exc:
            refund_user_quota(identity, 1)
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        except HTTPException:
            refund_user_quota(identity, 1)
            raise

    @router.post("/api/image-tasks/generations")
    async def create_generation_task(
        body: ImageGenerationTaskRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        with guard_api_request(identity, "image_tasks", body.model):
            pass
        # 鍓嶇姣忓紶鍥剧嫭绔嬫彁浜や竴娆′换鍔★紝鎸?1 鎵ｏ紱棰濆害涓嶈冻鐩存帴 402锛?
        # 涓嶈绛?submit_generation 璺戝畬鎵嶅彂鐜版病棰濆害銆?
        consume_user_quota(identity, 1)
        # 鍚庣画浠绘剰 fail-fast 璺緞閮借鎶婅繖 1 寮犻€€鎺夛紝閬垮厤鍙傛暟閿欒涔熺櫧鎵?
        try:
            await filter_or_log(LoggedCall(identity, "/api/image-tasks/generations", body.model, "image generation task", request_text=body.prompt), body.prompt)
            result = await run_in_threadpool(
                image_task_service.submit_generation,
                identity,
                client_task_id=body.client_task_id,
                prompt=body.prompt,
                model=body.model,
                size=body.size,
                base_url=resolve_image_base_url(request),
                group_id=body.group_id,
                group_title=body.group_title,
                group_index=body.group_index,
            )
            _record_image_task_usage(identity)
            return result
        except ValueError as exc:
            refund_user_quota(identity, 1)
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        except HTTPException:
            # filter_or_log / submit_generation 鎶涘嚭鐨?HTTPException锛?
            # 鍐呭瀹℃煡 / 涓婃父鍙锋睜蹇?/ 鍙傛暟閿欓兘灞炰簬"杩樻病鐪熷彂璇锋眰灏卞け璐?锛屽簲閫€娆俱€?
            # _run_task 寮傛璺緞鐨勫け璐ョ敱 image_task_service._refund_one 鑷繁閫€锛屼笉鍦ㄨ繖鏉￠摼璺噷銆?
            refund_user_quota(identity, 1)
            raise

    @router.post("/api/image-tasks/edits")
    async def create_edit_task(
        request: Request,
        authorization: str | None = Header(default=None),
        image: list[UploadFile] | None = File(default=None),
        image_list: list[UploadFile] | None = File(default=None, alias="image[]"),
        client_task_id: str = Form(...),
        prompt: str = Form(...),
        model: str = Form(default="gpt-image-2"),
        size: str | None = Form(default=None),
        commerce_feature: str | None = Form(default=None),
        group_id: str | None = Form(default=None),
        group_title: str | None = Form(default=None),
        group_index: int | None = Form(default=None),
    ):
        identity = require_identity(authorization)
        with guard_api_request(identity, "image_tasks", model):
            pass
        require_commerce_permission(identity, commerce_feature or "")
        consume_user_quota(identity, 1)
        try:
            await filter_or_log(LoggedCall(identity, "/api/image-tasks/edits", model, "image edit task", request_text=prompt), prompt)
            uploads = [*(image or []), *(image_list or [])]
            if not uploads:
                raise HTTPException(status_code=400, detail={"error": "image file is required"})
            images: list[tuple[bytes, str, str]] = []
            for upload in uploads:
                image_data = await upload.read()
                if not image_data:
                    raise HTTPException(status_code=400, detail={"error": "image file is empty"})
                images.append((image_data, upload.filename or "image.png", upload.content_type or "image/png"))
            result = await run_in_threadpool(
                image_task_service.submit_edit,
                identity,
                client_task_id=client_task_id,
                prompt=prompt,
                model=model,
                size=size,
                base_url=resolve_image_base_url(request),
                images=images,
                group_id=group_id,
                group_title=group_title,
                group_index=group_index,
            )
            _record_image_task_usage(identity, attachments=len(images))
            return result
        except ValueError as exc:
            refund_user_quota(identity, 1)
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        except HTTPException:
            refund_user_quota(identity, 1)
            raise

    return router
