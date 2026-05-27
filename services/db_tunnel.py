from __future__ import annotations

import atexit
import os
from typing import Any

_tunnel: Any | None = None


def start_database_ssh_tunnel_from_env() -> None:
    """Start an optional SSH tunnel before database storage initializes."""
    global _tunnel
    enabled = str(os.getenv("DB_SSH_TUNNEL", "")).strip().lower()
    if enabled not in {"1", "true", "yes", "on"}:
        return
    if _tunnel is not None:
        return

    try:
        from sshtunnel import SSHTunnelForwarder
    except Exception as exc:  # pragma: no cover - startup guard
        raise RuntimeError("DB_SSH_TUNNEL is enabled but sshtunnel is not installed") from exc

    ssh_host = _required_env("DB_SSH_HOST")
    ssh_user = os.getenv("DB_SSH_USER", "root").strip() or "root"
    ssh_port = int(os.getenv("DB_SSH_PORT", "22"))
    ssh_password = os.getenv("DB_SSH_PASSWORD") or None
    ssh_key = os.getenv("DB_SSH_KEY_FILE") or None
    remote_host = os.getenv("DB_SSH_REMOTE_HOST", "127.0.0.1").strip() or "127.0.0.1"
    remote_port = int(os.getenv("DB_SSH_REMOTE_PORT", "5432"))
    local_host = os.getenv("DB_SSH_LOCAL_HOST", "127.0.0.1").strip() or "127.0.0.1"
    local_port = int(os.getenv("DB_SSH_LOCAL_PORT", "15432"))

    if not ssh_password and not ssh_key:
        raise RuntimeError("DB_SSH_TUNNEL requires DB_SSH_PASSWORD or DB_SSH_KEY_FILE")

    kwargs: dict[str, Any] = {
        "ssh_address_or_host": (ssh_host, ssh_port),
        "ssh_username": ssh_user,
        "remote_bind_address": (remote_host, remote_port),
        "local_bind_address": (local_host, local_port),
        "set_keepalive": 30.0,
    }
    if ssh_password:
        kwargs["ssh_password"] = ssh_password
    if ssh_key:
        kwargs["ssh_pkey"] = ssh_key

    _tunnel = SSHTunnelForwarder(**kwargs)
    _tunnel.start()
    print(
        "[db-tunnel] SSH tunnel started: "
        f"{local_host}:{_tunnel.local_bind_port} -> {remote_host}:{remote_port} via {ssh_host}:{ssh_port}"
    )
    atexit.register(stop_database_ssh_tunnel)


def stop_database_ssh_tunnel() -> None:
    global _tunnel
    if _tunnel is None:
        return
    _tunnel.stop()
    _tunnel = None


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required when DB_SSH_TUNNEL is enabled")
    return value
