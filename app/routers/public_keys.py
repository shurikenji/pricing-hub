"""Public key manager page — SSR shell, data loaded via API."""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from app.deps import get_templates
from db.queries.servers import get_enabled_servers
from app.sanitizer import sanitize_server

router = APIRouter(tags=["public"])


@router.get("/keys", response_class=HTMLResponse)
async def keys_page(request: Request):
    templates = get_templates()
    servers = await get_enabled_servers()
    public_servers = [sanitize_server(s).model_dump() for s in servers]
    return templates.TemplateResponse("keys.html", {
        "request": request,
        "servers": public_servers,
    })
