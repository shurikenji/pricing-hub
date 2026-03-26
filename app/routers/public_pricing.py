"""Public pricing page — SSR with Jinja2."""
from __future__ import annotations

from fastapi import APIRouter, Request, Query
from fastapi.responses import HTMLResponse

from app.deps import get_templates
from app.cache import fetch_pricing
from app.sanitizer import sanitize_pricing, sanitize_server
from db.queries.servers import get_enabled_servers

router = APIRouter(tags=["public"])


@router.get("/", response_class=HTMLResponse)
@router.get("/pricing", response_class=HTMLResponse)
async def pricing_page(request: Request, server: str = Query("")):
    templates = get_templates()
    servers = await get_enabled_servers()

    # Pick server
    selected_id = server or (servers[0]["id"] if servers else "")
    selected_server = next((s for s in servers if s["id"] == selected_id), None)

    # Fetch + sanitize pricing
    pricing = None
    if selected_server:
        raw_pricing = await fetch_pricing(selected_id)
        if raw_pricing:
            pricing = sanitize_pricing(raw_pricing)

    public_servers = [sanitize_server(s) for s in servers]

    return templates.TemplateResponse("pricing.html", {
        "request": request,
        "servers": [s.model_dump() for s in public_servers],
        "selected_server_id": selected_id,
        "pricing": pricing.model_dump() if pricing else None,
        "model_count": len(pricing.models) if pricing else 0,
        "group_count": len(pricing.groups) if pricing else 0,
    })
