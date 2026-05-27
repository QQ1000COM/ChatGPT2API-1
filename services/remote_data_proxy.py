from __future__ import annotations

import os
from typing import Iterable

from fastapi import Request
from fastapi.responses import Response, StreamingResponse

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}

DEFAULT_PREFIXES = (
    "/api/",
    "/v1/",
    "/auth/",
    "/images/",
    "/image-thumbnails/",
)


def remote_data_proxy_enabled() -> bool:
    return str(os.getenv("REMOTE_DATA_PROXY_ENABLED", "")).strip().lower() in {"1", "true", "yes", "on"}


def remote_data_proxy_base_url() -> str:
    return str(os.getenv("REMOTE_DATA_PROXY_BASE_URL") or "").strip().rstrip("/")


def should_proxy_path(path: str, prefixes: Iterable[str] = DEFAULT_PREFIXES) -> bool:
    return any(path.startswith(prefix) for prefix in prefixes)


async def proxy_remote_data_request(request: Request, base_url: str) -> Response:
    import httpx

    target_url = f"{base_url}{request.url.path}"
    if request.url.query:
        target_url = f"{target_url}?{request.url.query}"

    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in HOP_BY_HOP_HEADERS and key.lower() != "host"
    }
    body = await request.body()
    timeout = httpx.Timeout(connect=30.0, read=600.0, write=600.0, pool=30.0)

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        upstream = await client.request(
            request.method,
            target_url,
            content=body,
            headers=headers,
        )

    response_headers = {
        key: value
        for key, value in upstream.headers.items()
        if key.lower() not in HOP_BY_HOP_HEADERS
    }
    response_headers["x-data-origin"] = "vps"

    return StreamingResponse(
        iter([upstream.content]),
        status_code=upstream.status_code,
        headers=response_headers,
        media_type=upstream.headers.get("content-type"),
    )
