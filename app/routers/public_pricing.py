"""Public pricing page - SSR with Jinja2."""
from __future__ import annotations

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse

from app.cache import fetch_pricing
from app.deps import get_templates
from app.sanitizer import sanitize_server
from app.translation_service import build_public_pricing
from db.queries.servers import get_enabled_servers

router = APIRouter(tags=["public"])


@router.get("/", response_class=HTMLResponse)
@router.get("/pricing", response_class=HTMLResponse)
async def pricing_page(request: Request, server: str = Query("")):
    templates = get_templates()
    servers = await get_enabled_servers()

    selected_id = server or (servers[0]["id"] if servers else "")
    selected_server = next((item for item in servers if item["id"] == selected_id), None)

    pricing = None
    if selected_server:
        raw_pricing = await fetch_pricing(selected_id)
        if raw_pricing:
            pricing = await build_public_pricing(
                raw_pricing,
                str(selected_server.get("type") or "newapi"),
            )

    public_servers = [sanitize_server(item) for item in servers]
    return templates.TemplateResponse(
        "pricing.html",
        {
            "request": request,
            "servers": [item.model_dump() for item in public_servers],
            "selected_server_id": selected_id,
            "pricing": pricing.model_dump() if pricing else None,
            "model_count": len(pricing.models) if pricing else 0,
            "group_count": len(pricing.groups) if pricing else 0,
        },
    )
