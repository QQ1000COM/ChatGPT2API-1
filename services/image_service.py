from __future__ import annotations

import io
import re
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse
from PIL import Image, ImageOps

from services.config import config
from services.image_owners_service import load_owners, remove_owners
from services.image_prompts_service import load_prompts, remove_prompts
from services.image_tags_service import load_tags, remove_tags
from services.image_task_service import get_image_task_group_index
from services.remote_image_index_service import list_remote_images, remove_remote_images

THUMBNAIL_SIZE = (320, 320)


def _cleanup_empty_dirs(root: Path) -> None:
    for path in sorted((p for p in root.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
        try:
            path.rmdir()
        except OSError:
            pass


def _safe_relative_path(path: str) -> str:
    value = str(path or "").strip().replace("\\", "/").lstrip("/")
    if not value:
        raise HTTPException(status_code=404, detail="image not found")
    parts = Path(value).parts
    if any(part in {"", ".", ".."} for part in parts):
        raise HTTPException(status_code=404, detail="image not found")
    return Path(*parts).as_posix()


def _safe_zip_segment(value: str, default: str = "folder") -> str:
    name = re.sub(r'[\\/:*?"<>|\r\n]+', "_", str(value or "").strip())
    name = re.sub(r"\s+", " ", name).strip(" .")
    return (name or default)[:80]


def _safe_image_path(relative_path: str) -> Path:
    rel = _safe_relative_path(relative_path)
    root = config.images_dir.resolve()
    path = (root / rel).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="image not found") from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="image not found")
    return path


def _thumbnail_path(relative_path: str) -> Path:
    rel = _safe_relative_path(relative_path)
    return config.image_thumbnails_dir / f"{rel}.png"


def thumbnail_url(base_url: str, relative_path: str) -> str:
    return f"{base_url.rstrip('/')}/image-thumbnails/{_safe_relative_path(relative_path)}"


def _image_dimensions(path: Path) -> tuple[int, int] | None:
    try:
        with Image.open(path) as image:
            return image.size
    except Exception:
        return None


def _infer_sku(prompt: str) -> str:
    match = re.search(r"(?:SKU|规格|颜色)\s*[/／]?\s*(?:规格|颜色)?\s*[:：]\s*([^\r\n，,。；;]+)", prompt or "", re.I)
    return (match.group(1).strip()[:40] if match else "")


def _auto_tags(item: dict[str, object], owner_name: str = "") -> list[str]:
    rel = str(item.get("path") or item.get("rel") or "")
    prompt = str(item.get("prompt") or "")
    date = str(item.get("date") or "")[:10]
    width = int(item.get("width") or 0)
    height = int(item.get("height") or 0)
    result = [
        f"日期:{date}" if date else "",
        f"用户:{owner_name}" if owner_name else "",
        f"工具:{item.get('tool_name')}" if item.get("tool_name") else "",
        f"商品:{item.get('product_name')}" if item.get("product_name") else "",
        f"SKU:{_infer_sku(prompt)}" if _infer_sku(prompt) else "",
        f"尺寸:{width}x{height}" if width and height else "",
        f"来源:{rel.split('/', 1)[0]}" if rel else "",
    ]
    return [tag for tag in result if tag]


def ensure_thumbnail(relative_path: str) -> Path:
    source = _safe_image_path(relative_path)
    target = _thumbnail_path(relative_path)
    source_mtime = source.stat().st_mtime
    if target.exists() and target.stat().st_mtime >= source_mtime:
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(source) as image:
            image = ImageOps.exif_transpose(image)
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            image.thumbnail(THUMBNAIL_SIZE, Image.Resampling.LANCZOS)
            image.save(target, format="PNG", optimize=True)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail="failed to create thumbnail") from exc
    return target


def get_thumbnail_response(relative_path: str) -> FileResponse:
    return FileResponse(ensure_thumbnail(relative_path))


def get_image_download_response(relative_path: str) -> FileResponse:
    path = _safe_image_path(relative_path)
    return FileResponse(path, filename=path.name)


def cleanup_image_thumbnails() -> int:
    thumbnails_root = config.image_thumbnails_dir
    images_root = config.images_dir
    removed = 0
    for path in thumbnails_root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(thumbnails_root).as_posix()
        if not rel.endswith(".png") or not (images_root / rel[:-4]).exists():
            path.unlink()
            removed += 1
    _cleanup_empty_dirs(thumbnails_root)
    return removed


def count_total_images() -> int:
    """图片管理页"未归属"数量统计用：纯粹数 images_dir 下文件数。
    比 _image_items 轻量，避开了打开文件取尺寸的 IO。"""
    root = config.images_dir
    local_rels = {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()} if root.exists() else set()
    remote_rels = {
        str(remote.get("rel") or remote.get("path") or "").strip().lstrip("/")
        for remote in list_remote_images()
    }
    remote_rels.discard("")
    return len(local_rels | remote_rels)


def _image_items(start_date: str = "", end_date: str = "", owner: str = "", admin_ids: set[str] | None = None) -> list[dict[str, object]]:
    items = []
    root = config.images_dir
    owner_filter = (owner or "").strip()
    owners_map = load_owners() if owner_filter else {}
    admin_set = admin_ids or set()
    remote_map = {
        str(remote.get("rel") or remote.get("path") or "").strip().lstrip("/"): remote
        for remote in list_remote_images()
    }
    remote_map.pop("", None)
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        parts = rel.split("/")
        day = "-".join(parts[:3]) if len(parts) >= 4 else datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d")
        if start_date and day < start_date:
            continue
        if end_date and day > end_date:
            continue
        if owner_filter:
            owner_id = owners_map.get(rel, "")
            # 前端约定的两个特殊桶：
            #   __admin__   = 管理员生成（owner_id 落在 admin 集合里）
            #   __unowned__ = 真孤儿（image_owners.json 里没记录，多半是老数据 / 写归属表失败）
            if owner_filter == "__unowned__":
                if owner_id:
                    continue
            elif owner_filter == "__admin__":
                if owner_id not in admin_set:
                    continue
            elif owner_id != owner_filter:
                continue
        remote = remote_map.get(rel) if rel else None
        dimensions = (
            (int(remote.get("width")), int(remote.get("height")))
            if remote and remote.get("width") and remote.get("height")
            else None
        )
        items.append({
            "rel": rel,
            "path": rel,
            "name": path.name,
            "date": day,
            "size": path.stat().st_size,
            "created_at": datetime.fromtimestamp(path.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
            **({"url": str(remote.get("url") or "")} if remote and remote.get("url") else {}),
            **({"thumbnail_url": str(remote.get("thumbnail_url") or remote.get("url") or "")} if remote and (remote.get("thumbnail_url") or remote.get("url")) else {}),
            **({"width": dimensions[0], "height": dimensions[1]} if dimensions else {}),
        })
    items.sort(key=lambda item: str(item["created_at"]), reverse=True)
    local_rels = {str(item.get("path") or "") for item in items}
    for remote in remote_map.values():
        rel = str(remote.get("rel") or remote.get("path") or "").strip().lstrip("/")
        if not rel or rel in local_rels:
            continue
        if owner_filter:
            owner_id = owners_map.get(rel, "")
            if owner_filter == "__unowned__":
                if owner_id:
                    continue
            elif owner_filter == "__admin__":
                if owner_id not in admin_set:
                    continue
            elif owner_id != owner_filter:
                continue
        day = str(remote.get("date") or "")
        if start_date and day and day < start_date:
            continue
        if end_date and day and day > end_date:
            continue
        items.append({
            "rel": rel,
            "path": rel,
            "name": str(remote.get("name") or Path(rel).name),
            "date": day or str(remote.get("created_at") or "")[:10],
            "size": int(remote.get("size") or 0),
            "created_at": str(remote.get("created_at") or ""),
            "url": str(remote.get("url") or ""),
            "thumbnail_url": str(remote.get("thumbnail_url") or remote.get("url") or ""),
            **({"width": int(remote.get("width")), "height": int(remote.get("height"))} if remote.get("width") and remote.get("height") else {}),
        })
    items.sort(key=lambda item: str(item["created_at"]), reverse=True)
    return items


def list_images(
    base_url: str,
    start_date: str = "",
    end_date: str = "",
    owner: str = "",
    admin_ids: set[str] | None = None,
    query: str = "",
    tag: str = "",
    size: str = "",
    tool: str = "",
    status: str = "",
    owner_names: dict[str, str] | None = None,
) -> dict[str, object]:
    all_tags = load_tags()
    owners_map = load_owners()
    prompts_map = load_prompts()
    group_map = get_image_task_group_index()
    admin_set = admin_ids or set()
    owner_name_map = owner_names or {}
    normalized_query = query.strip().lower()
    tag_filter = tag.strip()
    size_filter = size.strip().lower()
    tool_filter = tool.strip().lower()
    status_filter = status.strip().lower()
    items = []
    for item in _image_items(start_date, end_date, owner, admin_set):
        rel = str(item["path"])
        owner_id = owners_map.get(rel, "")
        group_info = group_map.get(rel, {})
        prompt = prompts_map.get(rel, "")
        owner_name = "管理员" if owner_id in admin_set or owner_id == "admin" else owner_name_map.get(owner_id, owner_id)
        enriched = {
            **item,
            "url": str(item.get("url") or "") or f"{base_url.rstrip('/')}/images/{rel}",
            "thumbnail_url": str(item.get("thumbnail_url") or "") or thumbnail_url(base_url, rel),
            "owner_id": owner_id,
            # 标记给前端：admin 桶里的图都用同一种 badge 文案"管理员"，不暴露具体 admin id
            "is_admin_owner": bool(owner_id) and owner_id in admin_set,
            # 生成时记下来的 prompt 原文。老数据没记录就空字符串。
            # web "我的作品"页据此一键复用 / 发布画廊；为空时让前端弹窗手填。
            "prompt": prompt,
            **group_info,
        }
        manual_tags = all_tags.get(rel, [])
        enriched["tags"] = list(dict.fromkeys([*manual_tags, *_auto_tags(enriched, owner_name)]))
        haystack = " ".join(
            str(value or "")
            for value in [
                enriched.get("name"),
                enriched.get("rel"),
                enriched.get("prompt"),
                enriched.get("owner_id"),
                owner_name,
                enriched.get("tool_name"),
                enriched.get("product_name"),
                " ".join(enriched.get("tags") or []),
            ]
        ).lower()
        dimensions = f"{enriched.get('width') or ''}x{enriched.get('height') or ''}".lower()
        if normalized_query and normalized_query not in haystack:
            continue
        if tag_filter and tag_filter not in (enriched.get("tags") or []):
            continue
        if size_filter and size_filter not in dimensions and size_filter != str(enriched.get("task_size") or "").lower():
            continue
        if tool_filter and tool_filter not in str(enriched.get("tool_name") or "").lower():
            continue
        if status_filter and status_filter != str(enriched.get("task_status") or "success").lower():
            continue
        items.append(enriched)
    groups: dict[str, list[dict[str, object]]] = {}
    for item in items:
        groups.setdefault(str(item["date"]), []).append(item)
    return {"items": items, "groups": [{"date": key, "items": value} for key, value in groups.items()]}


def delete_images(
    paths: list[str] | None = None,
    start_date: str = "",
    end_date: str = "",
    owner: str = "",
    all_matching: bool = False,
    admin_ids: set[str] | None = None,
) -> dict[str, int]:
    root = config.images_dir.resolve()
    targets = (
        [str(item["path"]) for item in _image_items(start_date, end_date, owner, admin_ids or set())]
        if all_matching
        else (paths or [])
    )
    removed = 0
    cleared_rels: list[str] = []
    for item in targets:
        path = (root / item).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            continue
        if path.is_file():
            path.unlink()
            for thumbnail in (_thumbnail_path(item), config.image_thumbnails_dir / _safe_relative_path(item)):
                if thumbnail.is_file():
                    thumbnail.unlink()
            remove_tags(item)
            cleared_rels.append(item)
            removed += 1
        else:
            cleared_rels.append(item)
            removed += 1
    if cleared_rels:
        remove_owners(cleared_rels)
        remove_prompts(cleared_rels)
        remove_remote_images(cleared_rels)
    _cleanup_empty_dirs(root)
    _cleanup_empty_dirs(config.image_thumbnails_dir)
    return {"removed": removed}


def download_images_zip(paths: list[str]) -> io.BytesIO:
    root = config.images_dir.resolve()
    group_map = get_image_task_group_index()
    remote_map = {
        str(remote.get("rel") or remote.get("path") or "").strip().lstrip("/"): remote
        for remote in list_remote_images()
    }
    remote_map.pop("", None)
    buf = io.BytesIO()
    added = 0
    used_names: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in paths:
            rel = _safe_relative_path(item)
            path = (root / rel).resolve()
            try:
                path.relative_to(root)
            except ValueError:
                continue
            payload: bytes | None = None
            if path.is_file():
                payload = path.read_bytes()
            else:
                remote_url = str((remote_map.get(rel) or {}).get("url") or "").strip()
                if remote_url:
                    try:
                        with urllib.request.urlopen(remote_url, timeout=30) as response:
                            payload = response.read()
                    except Exception:
                        payload = None
            if not payload:
                continue
            group_info = group_map.get(rel) or {}
            group_id = str(group_info.get("group_id") or "").strip()
            group_count = int(group_info.get("group_count") or 0)
            if group_id and group_count > 1:
                folder = _safe_zip_segment(str(group_info.get("group_title") or group_id), "collection")
                group_index = int(group_info.get("group_index") or 0) + 1
                name = f"{folder}/{group_index:02d}-{path.name}"
            else:
                name = path.name
            if name in used_names:
                parent = str(Path(name).parent)
                prefix = "" if parent == "." else f"{parent}/"
                stem = Path(name).stem
                suffix = Path(name).suffix
                counter = 2
                while f"{prefix}{stem}_{counter}{suffix}" in used_names:
                    counter += 1
                name = f"{prefix}{stem}_{counter}{suffix}"
            used_names.add(name)
            zf.writestr(name, payload)
            added += 1
    if added == 0:
        raise HTTPException(status_code=404, detail="no images found")
    buf.seek(0)
    return buf


def dedupe_similar_images(threshold: int = 4, dry_run: bool = True) -> dict[str, object]:
    root = config.images_dir.resolve()
    if not root.exists():
        return {"groups": [], "removed": 0}

    def average_hash(path: Path) -> str | None:
        try:
            with Image.open(path) as image:
                image = ImageOps.exif_transpose(image).convert("L").resize((8, 8), Image.Resampling.LANCZOS)
                pixels = list(image.getdata())
                avg = sum(pixels) / len(pixels)
                return "".join("1" if pixel >= avg else "0" for pixel in pixels)
        except Exception:
            return None

    def distance(left: str, right: str) -> int:
        return sum(1 for a, b in zip(left, right) if a != b)

    candidates: list[tuple[str, Path, str, int]] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        h = average_hash(path)
        if h:
            candidates.append((rel, path, h, path.stat().st_size))

    used: set[str] = set()
    groups: list[dict[str, object]] = []
    to_remove: list[str] = []
    for rel, path, h, size_bytes in candidates:
        if rel in used:
            continue
        group = [(rel, path, size_bytes)]
        for other_rel, other_path, other_h, other_size in candidates:
            if other_rel == rel or other_rel in used:
                continue
            if distance(h, other_h) <= threshold:
                group.append((other_rel, other_path, other_size))
        if len(group) <= 1:
            continue
        group.sort(key=lambda item: (item[1].stat().st_mtime, -item[2]), reverse=True)
        keep = group[0][0]
        duplicates = [item[0] for item in group[1:]]
        used.update(item[0] for item in group)
        to_remove.extend(duplicates)
        groups.append({"keep": keep, "duplicates": duplicates, "count": len(group)})

    removed = 0
    if not dry_run and to_remove:
        removed = delete_images(to_remove).get("removed", 0)
    return {"groups": groups, "removed": removed, "dry_run": dry_run}
