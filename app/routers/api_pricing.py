"""JSON API: /api/pricing - returns normalized, sanitized pricing data."""
from __future__ import annotations

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from app.cache import fetch_pricing
from app.translation_service import build_public_pricing
from db.queries.servers import get_enabled_servers, get_server

router = APIRouter(prefix="/api", tags=["api"])


@router.get("/servers")
async def api_servers():
    """Public list of enabled servers (no secrets)."""
    servers = await get_enabled_servers()
    return [
        {
            "id": server["id"],
            "name": server["name"],
            "type": server["type"],
            "supports_group_chain": bool(server.get("supports_group_chain")),
        }
        for server in servers
    ]


@router.get("/pricing/{server_id}")
async def api_pricing(server_id: str, force: bool = Query(False)):
    """Fetch normalized pricing for a server."""
    server = await get_server(server_id)
    if not server:
        return JSONResponse({"error": "Server not found or fetch failed"}, status_code=404)

    pricing = await fetch_pricing(server_id, force=force)
    if not pricing:
        return JSONResponse({"error": "Server not found or fetch failed"}, status_code=404)

    sanitized = await build_public_pricing(pricing, str(server.get("type") or "newapi"))
    return sanitized.model_dump()
