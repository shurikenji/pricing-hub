"""JSON API: /api/keys - resolve key info, list groups, change group."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.adapters import get_adapter
from app.cache import fetch_pricing
from app.sanitizer import sanitize_group_name
from db.queries.servers import get_server

router = APIRouter(prefix="/api", tags=["api"])


class KeyResolveRequest(BaseModel):
    server_id: str
    api_key: str


class KeyUpdateRequest(BaseModel):
    server_id: str
    api_key: str
    groups: list[str]


def _normalize_groups(raw: dict[str, Any]) -> list[str]:
    direct = raw.get("TokenGroup") or raw.get("group") or raw.get("selected_groups")
    if isinstance(direct, list):
        return [str(value).strip() for value in direct if str(value).strip()]
    if isinstance(direct, str):
        return [value.strip() for value in direct.split(",") if value.strip()]
    return []


def _selection_mode(server: dict) -> str:
    return "multiple" if bool(server.get("supports_group_chain")) else "single"


def _normalize_selected_groups(groups: list[str], selection_mode: str) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for group in groups:
        value = str(group).strip()
        if value and value not in seen:
            seen.add(value)
            cleaned.append(value)
    if selection_mode == "single":
        return cleaned[:1]
    return cleaned


def _match_models_by_groups(models: list, groups: list[str], selection_mode: str) -> int:
    if not groups:
        return len(models)
    group_set = set(groups)
    count = 0
    for model in models:
        enabled = set(model.enable_groups or [])
        if selection_mode == "multiple":
            if enabled & group_set:
                count += 1
        elif enabled & group_set:
            count += 1
    return count


def _build_update_payload(server_type: str, raw: dict[str, Any], groups: list[str]) -> dict[str, Any] | None:
    joined = ",".join(groups)
    remain_quota = raw.get("remain_quota")
    if not isinstance(remain_quota, (int, float)):
        remain_quota = raw.get("remainQuota")
    if not isinstance(remain_quota, (int, float)):
        remain_quota = 0

    if server_type == "rixapi":
        return {
            "id": raw.get("id"),
            "remain_quota": remain_quota,
            "name": raw.get("name"),
            "group": joined,
            "TokenGroup": joined,
            "expired_time": raw.get("expired_time", -1),
            "key": raw.get("key"),
            "user_id": raw.get("user_id"),
            "created_time": raw.get("created_time"),
            "updated_time": raw.get("updated_time"),
            "status": raw.get("status"),
            "is_active": raw.get("is_active"),
            "mj_mode": raw.get("mj_mode", "default"),
            "mj_cdn": raw.get("mj_cdn", "default"),
            "mj_cdn_addr": raw.get("mj_cdn_addr", ""),
            "remain_count": raw.get("remain_count", 0),
            "unlimited_count": raw.get("unlimited_count", True),
            "model_limits_enabled": raw.get("model_limits_enabled", False),
            "model_limits": raw.get("model_limits", ""),
            "allow_ips": raw.get("allow_ips", ""),
            "exclude_ips": raw.get("exclude_ips", ""),
            "rate_limits_enabled": raw.get("rate_limits_enabled", False),
            "rate_limits_time": raw.get("rate_limits_time", 10),
            "rate_limits_count": raw.get("rate_limits_count", 900),
            "rate_limits_content": raw.get("rate_limits_content", ""),
        }

    if server_type == "newapi":
        return {
            "id": raw.get("id"),
            "remain_quota": remain_quota,
            "name": raw.get("name"),
            "group": joined,
            "selected_groups": groups if len(groups) > 1 else None,
            "expired_time": raw.get("expired_time", -1),
            "unlimited_quota": raw.get("unlimited_quota", False),
            "model_limits_enabled": raw.get("model_limits_enabled", False),
            "model_limits": raw.get("model_limits", ""),
            "allow_ips": raw.get("allow_ips", ""),
            "key": raw.get("key"),
            "user_id": raw.get("user_id"),
            "created_time": raw.get("created_time"),
            "updated_time": raw.get("updated_time"),
            "status": raw.get("status"),
            "is_active": raw.get("is_active"),
        }

    return None


@router.post("/keys/resolve")
async def api_key_resolve(body: KeyResolveRequest):
    """Resolve API key to token info and available groups."""
    server = await get_server(body.server_id)
    if not server:
        return JSONResponse({"error": "Server not found"}, status_code=404)

    adapter = get_adapter(server)
    token = await adapter.search_token(server, body.api_key)
    if not token:
        return JSONResponse({"error": "Token not found"}, status_code=404)

    pricing = await fetch_pricing(body.server_id)
    selection_mode = _selection_mode(server)
    groups = _normalize_selected_groups(_normalize_groups(token), selection_mode)
    available_groups = []
    available_model_count = 0
    if pricing:
        available_groups = [
            {
                "name": group.name,
                "display_name": sanitize_group_name(group.name, group.display_name),
                "ratio": group.ratio,
                "category": group.category,
            }
            for group in pricing.groups
        ]
        available_model_count = _match_models_by_groups(pricing.models, groups, selection_mode)

    return {
        "token": {
            "id": token.get("id"),
            "name": token.get("name"),
            "remain_quota": token.get("remain_quota"),
            "used_quota": token.get("used_quota"),
            "groups": groups,
            "display_groups": [sanitize_group_name(group) for group in groups],
        },
        "available_groups": available_groups,
        "supports_group_chain": bool(server.get("supports_group_chain")),
        "selection_mode": selection_mode,
        "available_model_count": available_model_count,
        "raw": {k: v for k, v in token.items() if k not in ("key",)},
    }


@router.put("/keys")
async def api_key_update(body: KeyUpdateRequest):
    """Update token groups for a resolved API key."""
    server = await get_server(body.server_id)
    if not server:
        return JSONResponse({"error": "Server not found"}, status_code=404)

    if not server.get("auth_token") or not server.get("auth_user_value"):
        return JSONResponse(
            {"error": "Server admin credentials are not configured."},
            status_code=400,
        )

    selection_mode = _selection_mode(server)
    groups = _normalize_selected_groups(body.groups, selection_mode)
    if not groups:
        return JSONResponse({"error": "Select at least one group."}, status_code=400)
    if selection_mode == "single" and len(body.groups) > 1:
        return JSONResponse({"error": "This server allows only one group."}, status_code=400)

    adapter = get_adapter(server)
    token = await adapter.search_token(server, body.api_key)
    if not token:
        return JSONResponse({"error": "Token not found"}, status_code=404)

    payload = _build_update_payload(str(server.get("type") or "newapi"), token, groups)
    if not payload:
        return JSONResponse(
            {"error": "This server type does not support token group updates yet."},
            status_code=400,
        )

    try:
        response = await adapter.update_token(server, payload)
    except Exception as exc:
        return JSONResponse({"error": f"Key update failed: {exc}"}, status_code=502)

    if not response.get("success"):
        message = response.get("message") if isinstance(response, dict) else None
        return JSONResponse(
            {"error": message or "Upstream token update failed."},
            status_code=502,
        )

    pricing = await fetch_pricing(body.server_id)
    available_model_count = _match_models_by_groups(
        pricing.models if pricing else [],
        groups,
        selection_mode,
    )
    return {
        "success": True,
        "token_name": token.get("name"),
        "groups": groups,
        "display_groups": [sanitize_group_name(group) for group in groups],
        "selection_mode": selection_mode,
        "available_model_count": available_model_count,
    }
