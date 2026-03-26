"""JSON API: /api/keys — resolve key info, list groups, change group."""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.adapters import get_adapter
from app.sanitizer import sanitize_group_name
from db.queries.servers import get_server

router = APIRouter(prefix="/api", tags=["api"])


class KeyResolveRequest(BaseModel):
    server_id: str
    api_key: str


@router.post("/keys/resolve")
async def api_key_resolve(body: KeyResolveRequest):
    """Resolve API key → token info (name, quota, group)."""
    server = await get_server(body.server_id)
    if not server:
        return JSONResponse({"error": "Server not found"}, status_code=404)

    adapter = get_adapter(server)
    token = await adapter.search_token(server, body.api_key)
    if not token:
        return JSONResponse({"error": "Token not found"}, status_code=404)

    # Sanitize group names for public display
    raw_group = str(token.get("group") or "")
    groups = [g.strip() for g in raw_group.split(",") if g.strip()]
    display_groups = [sanitize_group_name(g) for g in groups]

    return {
        "name": token.get("name"),
        "remain_quota": token.get("remain_quota"),
        "used_quota": token.get("used_quota"),
        "groups": groups,
        "display_groups": display_groups,
        "raw": {
            k: v for k, v in token.items()
            if k not in ("key",)  # never expose full key
        },
    }
