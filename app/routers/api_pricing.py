"""JSON API: /api/pricing — returns normalized, sanitized pricing data."""
from __future__ import annotations

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from app.cache import fetch_pricing
from app.sanitizer import sanitize_pricing
from db.queries.servers import get_enabled_servers

router = APIRouter(prefix="/api", tags=["api"])


@router.get("/servers")
async def api_servers():
    """Public list of enabled servers (no secrets)."""
    servers = await get_enabled_servers()
    return [
        {"id": s["id"], "name": s["name"], "type": s["type"],
         "supports_group_chain": bool(s.get("supports_group_chain"))}
        for s in servers
    ]


@router.get("/pricing/{server_id}")
async def api_pricing(server_id: str, force: bool = Query(False)):
    """Fetch normalized pricing for a server."""
    pricing = await fetch_pricing(server_id, force=force)
    if not pricing:
        return JSONResponse({"error": "Server not found or fetch failed"}, status_code=404)
    sanitized = sanitize_pricing(pricing)
    return sanitized.model_dump()
