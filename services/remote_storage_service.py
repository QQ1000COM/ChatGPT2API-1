from __future__ import annotations

import hashlib
import hmac
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit

from curl_cffi import requests

from services.config import config


class RemoteStorageError(RuntimeError):
    pass


def _clean(value: object) -> str:
    return str(value or "").strip()


def _sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _hmac_sha256(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def _join_url(base: str, path: str) -> str:
    return f"{base.rstrip('/')}/{quote(path.strip('/'), safe='/')}"


def _content_type_for_path(path: str) -> str:
    suffix = Path(path).suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".gif":
        return "image/gif"
    return "image/png"


class WebDAVRemoteStorage:
    def __init__(self, settings: dict[str, object]) -> None:
        webdav = settings.get("webdav") if isinstance(settings.get("webdav"), dict) else {}
        self.base_url = _clean(webdav.get("url")).rstrip("/")
        self.username = _clean(webdav.get("username"))
        self.password = _clean(webdav.get("password"))
        self.session = requests.Session(impersonate="chrome", verify=True)

    def validate(self) -> None:
        missing = []
        if not self.base_url:
            missing.append("WebDAV 地址")
        if not self.username:
            missing.append("账号")
        if not self.password:
            missing.append("密码")
        if missing:
            raise RemoteStorageError("WebDAV 配置不完整：" + "、".join(missing))

    def _request(self, method: str, path: str = "", **kwargs):
        self.validate()
        return self.session.request(
            method,
            _join_url(self.base_url, path) if path else self.base_url,
            auth=(self.username, self.password),
            timeout=kwargs.pop("timeout", 30),
            **kwargs,
        )

    def ensure_dirs(self, path: str) -> None:
        current = ""
        for part in [item for item in path.strip("/").split("/")[:-1] if item]:
            current = f"{current}/{part}".strip("/")
            response = self._request("MKCOL", current, timeout=15)
            if response.status_code not in {200, 201, 204, 405}:
                raise RemoteStorageError(f"创建 WebDAV 目录失败：HTTP {response.status_code}")

    def upload_bytes(self, path: str, payload: bytes, content_type: str) -> str:
        self.ensure_dirs(path)
        response = self._request("PUT", path, data=payload, headers={"Content-Type": content_type}, timeout=60)
        if response.status_code >= 400:
            raise RemoteStorageError(f"上传 WebDAV 失败：HTTP {response.status_code}")
        return _join_url(self.base_url, path)

    def test_connection(self) -> dict[str, object]:
        response = self._request("PROPFIND", "", headers={"Depth": "0"}, timeout=20)
        if response.status_code >= 400:
            raise RemoteStorageError(f"连接 WebDAV 失败：HTTP {response.status_code}")
        return {"ok": True, "provider": "webdav", "status": int(response.status_code)}


class S3RemoteStorage:
    def __init__(self, settings: dict[str, object]) -> None:
        s3 = settings.get("s3") if isinstance(settings.get("s3"), dict) else {}
        self.endpoint = _clean(s3.get("endpoint")).rstrip("/")
        self.region = _clean(s3.get("region")) or "auto"
        self.bucket = _clean(s3.get("bucket"))
        self.access_key_id = _clean(s3.get("access_key_id"))
        self.secret_access_key = _clean(s3.get("secret_access_key"))
        self.session = requests.Session(impersonate="chrome", verify=True)

    def validate(self) -> None:
        missing = []
        if not self.endpoint:
            missing.append("Endpoint")
        if not self.bucket:
            missing.append("Bucket")
        if not self.access_key_id:
            missing.append("Access Key ID")
        if not self.secret_access_key:
            missing.append("Secret Access Key")
        if missing:
            raise RemoteStorageError("S3 配置不完整：" + "、".join(missing))

    @property
    def host(self) -> str:
        return urlsplit(self.endpoint).netloc

    def _aws_v4_headers(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, str] | None = None,
        body: bytes = b"",
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[str, dict[str, str]]:
        now = datetime.now(UTC)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        date_stamp = now.strftime("%Y%m%d")
        encoded_query = urlencode(sorted((query or {}).items()))
        payload_hash = _sha256_hex(body)
        headers = {
            "host": self.host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        }
        if extra_headers:
            for key, value in extra_headers.items():
                headers[key.lower()] = str(value).strip()
        sorted_items = sorted((key.lower(), " ".join(str(value).strip().split())) for key, value in headers.items())
        canonical_headers = "".join(f"{key}:{value}\n" for key, value in sorted_items)
        signed_headers = ";".join(key for key, _ in sorted_items)
        canonical_request = "\n".join([
            method.upper(),
            path,
            encoded_query,
            canonical_headers,
            signed_headers,
            payload_hash,
        ])
        credential_scope = f"{date_stamp}/{self.region}/s3/aws4_request"
        string_to_sign = "\n".join([
            "AWS4-HMAC-SHA256",
            amz_date,
            credential_scope,
            _sha256_hex(canonical_request.encode("utf-8")),
        ])
        k_date = _hmac_sha256(("AWS4" + self.secret_access_key).encode("utf-8"), date_stamp)
        k_region = hmac.new(k_date, self.region.encode("utf-8"), hashlib.sha256).digest()
        k_service = hmac.new(k_region, b"s3", hashlib.sha256).digest()
        k_signing = hmac.new(k_service, b"aws4_request", hashlib.sha256).digest()
        signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        headers["authorization"] = (
            "AWS4-HMAC-SHA256 "
            f"Credential={self.access_key_id}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, "
            f"Signature={signature}"
        )
        return encoded_query, headers

    def _request(
        self,
        method: str,
        key: str = "",
        *,
        query: dict[str, str] | None = None,
        body: bytes = b"",
        extra_headers: dict[str, str] | None = None,
        timeout: float = 60,
    ):
        self.validate()
        object_path = f"/{self.bucket}"
        if key:
            object_path += f"/{quote(key.lstrip('/'), safe='/')}"
        encoded_query, headers = self._aws_v4_headers(
            method,
            object_path,
            query=query,
            body=body,
            extra_headers=extra_headers,
        )
        url = f"{self.endpoint}{object_path}"
        if encoded_query:
            url += f"?{encoded_query}"
        return self.session.request(method.upper(), url, headers=headers, data=body, timeout=timeout)

    def upload_bytes(self, path: str, payload: bytes, content_type: str) -> str:
        response = self._request("PUT", path, body=payload, extra_headers={"content-type": content_type})
        if response.status_code >= 400:
            raise RemoteStorageError(f"上传 S3 失败：HTTP {response.status_code}")
        return _join_url(f"{self.endpoint}/{self.bucket}", path)

    def test_connection(self) -> dict[str, object]:
        response = self._request("GET", query={"list-type": "2", "max-keys": "1"}, timeout=30)
        if response.status_code >= 400:
            raise RemoteStorageError(f"连接 S3 失败：HTTP {response.status_code}")
        return {"ok": True, "provider": "s3", "status": int(response.status_code)}


def _client(settings: dict[str, object]):
    provider = _clean(settings.get("provider")).lower()
    if provider == "webdav":
        return WebDAVRemoteStorage(settings)
    if provider == "s3":
        return S3RemoteStorage(settings)
    raise RemoteStorageError("请选择 WebDAV 或 S3 兼容存储")


def test_remote_storage() -> dict[str, object]:
    settings = config.get_remote_storage_settings()
    return _client(settings).test_connection()


def upload_image_bytes(relative_path: str, payload: bytes, *, content_type: str | None = None) -> str | None:
    settings = config.get_remote_storage_settings()
    if not bool(settings.get("enabled")):
        return None
    provider = _clean(settings.get("provider")).lower()
    if provider not in {"webdav", "s3"}:
        return None
    prefix = _clean(settings.get("path_prefix")).strip("/") or "images"
    object_path = f"{prefix}/{relative_path.strip('/')}"
    _client(settings).upload_bytes(object_path, payload, content_type or _content_type_for_path(relative_path))
    public_base_url = _clean(settings.get("public_base_url")).rstrip("/")
    if public_base_url:
        return _join_url(public_base_url, object_path)
    return None
