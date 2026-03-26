"""Admin server management: CRUD + sync."""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse

from app.cache import fetch_pricing
from app.deps import get_templates
from db.queries.servers import (
    delete_server,
    get_all_servers,
    get_latest_sync_map,
    upsert_server,
)

router = APIRouter(prefix="/control/servers", tags=["admin"])

_SERVER_TYPES = [
    {"value": "newapi", "label": "NewAPI Standard"},
    {"value": "rixapi", "label": "RixAPI (Inline Ratio)"},
    {"value": "custom", "label": "Custom Manual"},
]


@router.get("", response_class=HTMLResponse)
async def servers_page(request: Request):
    if not request.session.get("is_admin"):
        return RedirectResponse("/control/login", status_code=303)

    templates = get_templates()
    sync_map = await get_latest_sync_map()
    servers = []
    for server in await get_all_servers():
        server_copy = dict(server)
        server_copy["latest_sync"] = sync_map.get(server["id"])
        servers.append(server_copy)

    return templates.TemplateResponse(
        "control/servers.html",
        {
            "request": request,
            "servers": servers,
            "server_types": _SERVER_TYPES,
        },
    )


@router.post("/save")
async def servers_save(request: Request):
    if not request.session.get("is_admin"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    form = await request.form()
    server_id = str(form.get("id", "")).strip()
    if not server_id:
        return RedirectResponse("/control/servers", status_code=303)

    fields = {
        "name": str(form.get("name", "")).strip(),
        "base_url": str(form.get("base_url", "")).strip(),
        "type": str(form.get("type", "newapi")).strip(),
        "enabled": 1 if form.get("enabled") else 0,
        "sort_order": int(form.get("sort_order", 0) or 0),
        "supports_group_chain": 1 if form.get("supports_group_chain") else 0,
        "ratio_config_enabled": 1 if form.get("ratio_config_enabled") else 0,
        "auth_mode": str(form.get("auth_mode", "header")).strip(),
        "auth_user_header": str(form.get("auth_user_header", "")).strip(),
        "auth_user_value": str(form.get("auth_user_value", "")).strip(),
        "auth_token": str(form.get("auth_token", "")).strip(),
        "auth_cookie": str(form.get("auth_cookie", "")).strip(),
        "pricing_path": str(form.get("pricing_path", "/api/pricing")).strip(),
        "ratio_config_path": str(form.get("ratio_config_path", "/api/ratio_config")).strip(),
        "log_path": str(form.get("log_path", "/api/log/self")).strip(),
        "token_search_path": str(form.get("token_search_path", "/api/token/search")).strip(),
        "groups_path": str(form.get("groups_path", "")).strip(),
        "notes": str(form.get("notes", "")).strip(),
    }

    await upsert_server(server_id, **fields)
    return RedirectResponse("/control/servers", status_code=303)


@router.get("/{server_id}/delete")
async def servers_delete(request: Request, server_id: str):
    if not request.session.get("is_admin"):
        return RedirectResponse("/control/login", status_code=303)
    await delete_server(server_id)
    return RedirectResponse("/control/servers", status_code=303)


@router.post("/sync-all")
async def servers_sync_all(request: Request):
    if not request.session.get("is_admin"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    servers = await get_all_servers()
    for server in servers:
        if server.get("enabled"):
            await fetch_pricing(server["id"], force=True)
    return RedirectResponse("/control/servers", status_code=303)


@router.post("/{server_id}/sync")
async def servers_sync(request: Request, server_id: str):
    if not request.session.get("is_admin"):
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    pricing = await fetch_pricing(server_id, force=True)
    if pricing:
        return {"success": True, "models": len(pricing.models), "groups": len(pricing.groups)}
    return JSONResponse({"error": "Sync failed"}, status_code=500)
