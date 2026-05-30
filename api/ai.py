from __future__ import annotations

from fastapi import APIRouter, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field

from api.support import consume_user_quota, guard_api_request, refund_user_quota, require_chat_feature, require_chat_permission, require_commerce_permission, require_identity, resolve_image_base_url
from services.auth_service import auth_service
from services.config import config
from services.content_filter import check_request, request_text
from services.image_owners_service import record_owner_for_result
from services.image_prompts_service import record_prompt_for_result
from services.log_service import LoggedCall
from services.protocol import (
    anthropic_v1_messages,
    openai_v1_chat_complete,
    openai_v1_image_edit,
    openai_v1_image_generations,
    openai_v1_models,
    openai_v1_response,
    openai_search,
)
from services.protocol.conversation import count_message_image_tokens, count_message_text_tokens
from services.protocol.response_store import delete_response, get_response, list_input_items, store_response, update_response_status


class ImageGenerationRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    model: str = "gpt-image-2"
    n: int = Field(default=1, ge=1, le=4)
    size: str | None = None
    quality: str = "auto"
    response_format: str = "b64_json"
    history_disabled: bool = True
    stream: bool | None = None


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    prompt: str | None = None
    n: int | None = None
    stream: bool | None = None
    modalities: list[str] | None = None
    messages: list[dict[str, object]] | None = None


class ResponseCreateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    input: object | None = None
    tools: list[dict[str, object]] | None = None
    tool_choice: object | None = None
    stream: bool | None = None


class ResponseInputTokensRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    input: object | None = None
    instructions: object | None = None


class AnthropicMessageRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    messages: list[dict[str, object]] | None = None
    system: object | None = None
    stream: bool | None = None


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    prompt: str = Field(..., min_length=1)
    model: str | None = None
    timeout_secs: float | None = Field(default=None, ge=5, le=600)


def _rough_token_count(value: object) -> int:
    text = request_text(value)
    if not text:
        return 0
    return max(1, len(text) // 4)


def _message_has_images(messages: object) -> bool:
    if not isinstance(messages, list):
        return False
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if isinstance(part, dict) and str(part.get("type") or "").strip() in {"image_url", "input_image"}:
                return True
    return False


def _attachment_count(payload: dict[str, object]) -> int:
    try:
        return max(0, int(payload.get("attachments_count") or 0))
    except (TypeError, ValueError):
        return 0


def _response_text_tokens(result: object) -> int:
    if not isinstance(result, dict):
        return 0
    usage = result.get("usage")
    if isinstance(usage, dict):
        for key in ("output_tokens", "completion_tokens"):
            try:
                value = int(usage.get(key) or 0)
                if value > 0:
                    return value
            except (TypeError, ValueError):
                pass
    return _rough_token_count(result.get("choices") or result.get("output") or result.get("content"))


def _response_input_tokens(result: object) -> int:
    if not isinstance(result, dict):
        return 0
    usage = result.get("usage")
    if isinstance(usage, dict):
        for key in ("input_tokens", "prompt_tokens"):
            try:
                value = int(usage.get(key) or 0)
                if value > 0:
                    return value
            except (TypeError, ValueError):
                pass
    return 0


def _record_usage(identity: dict[str, object], endpoint: str, *, input_tokens: int = 0, output_tokens: int = 0, images: int = 0, attachments: int = 0) -> None:
    key_id = str(identity.get("id") or "").strip()
    if not key_id:
        return
    try:
        if key_id == "admin":
            config.add_admin_usage(
                endpoint=endpoint,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                images=images,
                attachments=attachments,
            )
            return
        auth_service.add_usage(
            key_id,
            endpoint=endpoint,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            images=images,
            attachments=attachments,
        )
    except Exception:
        pass


def _requires_code_permission(tools: object) -> bool:
    if not isinstance(tools, list):
        return False
    code_tool_names = {"read_file", "search_code", "apply_patch", "run_tests", "edit_file", "shell", "shell_command", "exec_command", "run_command", "terminal", "local_shell"}
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function")
        function_name = function.get("name") if isinstance(function, dict) else ""
        name = str(tool.get("name") or function_name or tool.get("type") or "").strip()
        if name in code_tool_names:
            return True
    return False


async def filter_or_log(call: LoggedCall, text: str) -> None:
    try:
        await run_in_threadpool(check_request, text)
    except HTTPException as exc:
        call.log("璋冪敤澶辫触", status="failed", error=str(exc.detail))
        raise


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/v1/models")
    async def list_models(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        with guard_api_request(identity, "models"):
            _record_usage(identity, "models")
            try:
                return await run_in_threadpool(openai_v1_models.list_models)
            except Exception as exc:
                raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc

    @router.post("/v1/images/generations")
    async def generate_images(
            body: ImageGenerationRequest,
            request: Request,
            authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        with guard_api_request(identity, "images", body.model):
            # /v1 閸忋儱褰涢幐?n 閺佺繝缍嬮幍锝忕礉1 濞嗏剝褰佹禍?= n 瀵姰鈧倸銇戠拹銉ф纯閹?402閿涘奔绗夋潻?call.run閵?
            n = max(1, int(body.n or 1))
            consume_user_quota(identity, n)
            payload = body.model_dump(mode="python")
            payload["base_url"] = resolve_image_base_url(request)
            # 娑撳﹥鐖堕惇鐔枫亼鐠愩儲妞傞幎濠冨⒏閻?n 闁偓閸ョ偛骞撻垾鏂衡偓鎿玱ggedCall.run / stream 閸愬懘鍎存径杈Е閸掑棙鏁导姘冲殰閸斻劌娲栫拫鍐︹偓?
            # 鏉╂瑩鍣?capture identity閿涘畺ailure_refund_amount 鐠虹喎鍙嗛崣锝嗗⒏閻ㄥ嫰鍣炬０婵呯閼锋番鈧?
            call = LoggedCall(
                identity, "/v1/images/generations", body.model, "image generation",
                request_text=body.prompt,
                on_failure=lambda amount: refund_user_quota(identity, amount),
                failure_refund_amount=n,
            )
            await filter_or_log(call, body.prompt)
            result = await call.run(openai_v1_image_generations.handle, payload)
            # 鐎佃甯?dict 鏉╂柨娲栭弮鑸靛Ω閸ュ墽澧栬ぐ鎺戠潣娑旂喎鍟撴稉鈧稉瀣剁幢StreamingResponse 娑撳秴濮╅妴?
            if isinstance(result, dict):
                record_owner_for_result(identity, result.get("data"))
                record_prompt_for_result(body.prompt, result.get("data"))
                _record_usage(identity, "images", input_tokens=_rough_token_count(body.prompt), images=len(result.get("data") or []))
            return result

    @router.post("/v1/images/edits")
    async def edit_images(
            request: Request,
            authorization: str | None = Header(default=None),
            image: list[UploadFile] | None = File(default=None),
            image_list: list[UploadFile] | None = File(default=None, alias="image[]"),
            prompt: str = Form(...),
            model: str = Form(default="gpt-image-2"),
            n: int = Form(default=1),
            size: str | None = Form(default=None),
            response_format: str = Form(default="b64_json"),
            quality: str = Form(default="auto"),
            stream: bool | None = Form(default=None),
    ):
        identity = require_identity(authorization)
        with guard_api_request(identity, "images", model):
            if n < 1 or n > 4:
                raise HTTPException(status_code=400, detail={"error": "n must be between 1 and 4"})
            # 閸氬本鐗遍幐?n 閺佺繝缍嬮幍锝忕礉閺嶏繝鐛欐潻?n 閼煎啫娲挎稊瀣倵閸愬秵澧搁敍宀勪缉閸忓秵妫ら弫鍫ｎ嚞濮瑰倷绡冪悮顐ヮ唶鐠愶负鈧?
            effective_n = max(1, int(n))
            consume_user_quota(identity, effective_n)
            call = LoggedCall(
                identity, "/v1/images/edits", model, "image edit",
                request_text=prompt,
                on_failure=lambda amount: refund_user_quota(identity, amount),
                failure_refund_amount=effective_n,
            )
            await filter_or_log(call, prompt)
            uploads = [*(image or []), *(image_list or [])]
            if not uploads:
                # 瀹稿弶澧搁惃鍕偓鈧幒澶嗏偓鏂衡偓鏂垮棘閺佷即鏁婄拠顖涙拱鐠愩劍妲?fail-fast閿涘奔绗夌拠銉唨閻劍鍩涢惂鑺ュ⒏
                refund_user_quota(identity, effective_n)
                raise HTTPException(status_code=400, detail={"error": "image file is required"})
            images: list[tuple[bytes, str, str]] = []
            for upload in uploads:
                image_data = await upload.read()
                if not image_data:
                    refund_user_quota(identity, effective_n)
                    raise HTTPException(status_code=400, detail={"error": "image file is empty"})
                images.append((image_data, upload.filename or "image.png", upload.content_type or "image/png"))
            payload = {
                "prompt": prompt,
                "images": images,
                "model": model,
                "n": n,
                "size": size,
                "response_format": response_format,
                "quality": quality,
                "stream": stream,
                "base_url": resolve_image_base_url(request),
            }
            result = await call.run(openai_v1_image_edit.handle, payload)
            if isinstance(result, dict):
                record_owner_for_result(identity, result.get("data"))
                # 閸ュ墽鏁撻崶鎾呯窗閺?is_edit=True閿涘瞼鏁惧濠傚絺鐢啯妞傛导姘Ω prompt 瀵搫鍩楅拃鐣屸敄閿?
                # 閸ョ姳璐熺粋璇茬磻閸欏倽鈧啫娴橀崥搴ょ箹濞堝吀鎱ㄩ弨瑙勫瘹娴犮倕顕崗璺虹暊閻劍鍩涘В顐ｆ￥婢跺秶鏁ゆ禒宄扳偓绗衡偓?
                record_prompt_for_result(prompt, result.get("data"), is_edit=True)
                _record_usage(identity, "images", input_tokens=_rough_token_count(prompt), images=len(result.get("data") or []), attachments=len(images))
            return result

    @router.post("/v1/chat/completions")
    async def create_chat_completion(body: ChatCompletionRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        payload = body.model_dump(mode="python")
        commerce_feature = str(payload.pop("commerce_feature", "") or "").strip()
        if commerce_feature:
            require_commerce_permission(identity, commerce_feature)
        else:
            require_chat_feature(identity, "chat")
        if _message_has_images(payload.get("messages")):
            require_chat_feature(identity, "image_understanding")
        attachments_count = _attachment_count(payload)
        if attachments_count:
            require_chat_feature(identity, "attachments")
        model = str(payload.get("model") or "auto")
        with guard_api_request(identity, "chat", model):
            request_preview = request_text(payload.get("prompt"), payload.get("messages"))
            call = LoggedCall(identity, "/v1/chat/completions", model, "閺傚洦婀伴悽鐔稿灇", request_text=request_preview)
            await filter_or_log(call, request_preview)
            result = await call.run(openai_v1_chat_complete.handle, payload)
            _record_usage(
                identity,
                "chat",
                input_tokens=_rough_token_count(payload.get("messages") or payload.get("prompt")),
                output_tokens=_response_text_tokens(result),
                attachments=attachments_count,
            )
            return result

    @router.post("/v1/responses")
    async def create_response(body: ResponseCreateRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        require_chat_feature(identity, "chat")
        payload = body.model_dump(mode="python")
        previous_response_id = str(payload.get("previous_response_id") or "").strip()
        if previous_response_id:
            try:
                payload["_previous_response"] = get_response(identity, previous_response_id)
                payload["_previous_input_items"] = list_input_items(
                    identity,
                    previous_response_id,
                    limit=100,
                    order="asc",
                ).get("data")
            except HTTPException:
                pass
        if _message_has_images(payload.get("input")):
            require_chat_feature(identity, "image_understanding")
        if _requires_code_permission(payload.get("tools")):
            require_chat_feature(identity, "code")
        model = str(payload.get("model") or "auto")
        with guard_api_request(identity, "responses", model):
            request_preview = request_text(payload.get("input"), payload.get("instructions"))
            call = LoggedCall(identity, "/v1/responses", model, "Responses", request_text=request_preview)
            await filter_or_log(call, request_preview)
            def handle_and_store(body_payload: dict[str, object]):
                response_result = openai_v1_response.handle(body_payload)
                if isinstance(response_result, dict):
                    return response_result

                def stream_with_store():
                    completed_response: dict[str, object] | None = None
                    for event in response_result:
                        if isinstance(event, dict) and event.get("type") == "response.completed" and isinstance(event.get("response"), dict):
                            completed_response = event["response"]
                        yield event
                    if completed_response:
                        store_response(identity, completed_response, body_payload.get("input"))
                        _record_usage(
                            identity,
                            "responses",
                            input_tokens=_response_input_tokens(completed_response) or _rough_token_count(body_payload.get("input")),
                            output_tokens=_response_text_tokens(completed_response),
                        )

                return stream_with_store()

            result = await call.run(handle_and_store, payload, sse="responses")
            if isinstance(result, dict):
                store_response(identity, result, payload.get("input"))
                _record_usage(
                    identity,
                    "responses",
                    input_tokens=_response_input_tokens(result) or _rough_token_count(payload.get("input")),
                    output_tokens=_response_text_tokens(result),
                )
            return result

    @router.get("/v1/responses/{response_id}")
    async def retrieve_response(response_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        with guard_api_request(identity, "responses"):
            return get_response(identity, response_id)

    @router.delete("/v1/responses/{response_id}")
    async def delete_response_endpoint(response_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        with guard_api_request(identity, "responses"):
            return delete_response(identity, response_id)

    @router.post("/v1/responses/{response_id}/cancel")
    async def cancel_response(response_id: str, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        with guard_api_request(identity, "responses"):
            return update_response_status(identity, response_id, "cancelled")

    @router.get("/v1/responses/{response_id}/input_items")
    async def get_response_input_items(
            response_id: str,
            authorization: str | None = Header(default=None),
            limit: int = Query(default=20, ge=1, le=100),
            order: str = Query(default="desc"),
            after: str = Query(default=""),
    ):
        identity = require_identity(authorization)
        with guard_api_request(identity, "responses"):
            return list_input_items(identity, response_id, limit=limit, order=order, after=after)

    @router.post("/v1/responses/input_tokens")
    async def create_response_input_tokens(body: ResponseInputTokensRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        require_chat_feature(identity, "chat")
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        with guard_api_request(identity, "responses", model):
            messages = openai_v1_response.messages_from_input(payload.get("input"), payload.get("instructions"))
            text_tokens = count_message_text_tokens(messages, model)
            image_tokens = count_message_image_tokens(messages, model)
            return {
                "object": "response.input_tokens",
                "input_tokens": text_tokens + image_tokens,
                "input_tokens_details": {
                    "text_tokens": text_tokens,
                    "image_tokens": image_tokens,
                },
            }

    @router.post("/v1/messages")
    async def create_message(
            body: AnthropicMessageRequest,
            authorization: str | None = Header(default=None),
            x_api_key: str | None = Header(default=None, alias="x-api-key"),
            anthropic_version: str | None = Header(default=None, alias="anthropic-version"),
    ):
        identity = require_identity(authorization or (f"Bearer {x_api_key}" if x_api_key else None))
        require_chat_feature(identity, "chat")
        payload = body.model_dump(mode="python")
        model = str(payload.get("model") or "auto")
        with guard_api_request(identity, "messages", model):
            request_preview = request_text(payload.get("system"), payload.get("messages"), payload.get("tools"))
            call = LoggedCall(identity, "/v1/messages", model, "Messages", request_text=request_preview)
            await filter_or_log(call, request_preview)
            result = await call.run(anthropic_v1_messages.handle, payload, sse="anthropic")
            _record_usage(
                identity,
                "messages",
                input_tokens=_rough_token_count(payload.get("messages")),
                output_tokens=_response_text_tokens(result),
            )
            return result

    @router.post("/v1/search")
    async def search(body: SearchRequest, authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        require_chat_feature(identity, "chat")
        require_chat_feature(identity, "web")
        payload = body.model_dump(mode="python")
        model = openai_search.resolve_model(payload.get("model"))
        with guard_api_request(identity, "search", model):
            call = LoggedCall(identity, "/v1/search", model, "Search", request_text=body.prompt)
            await filter_or_log(call, body.prompt)
            result = await call.run(openai_search.handle, payload)
            if isinstance(result, dict):
                _record_usage(
                    identity,
                    "search",
                    input_tokens=_rough_token_count(body.prompt),
                    output_tokens=_rough_token_count(result.get("answer") or result),
                )
            return result

    return router
