"""JSON API: /api/logs - proxy log queries to upstream servers."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.adapters import get_adapter
from app.cache import fetch_pricing
from app.log_pricing import enrich_logs_payload
from db.queries.servers import get_server

router = APIRouter(prefix="/api", tags=["api"])


class LogRequest(BaseModel):
    server_id: str
    api_key: str | None = None
    userId: str | None = None
    accessToken: str | None = None
    page: int = 1
    pageSize: int = 50
    token_name: str | None = None
    model_name: str | None = None
    start_timestamp: int | None = None
    end_timestamp: int | None = None
    group: str | None = None


@router.post("/logs")
async def api_logs(body: LogRequest):
    server = await get_server(body.server_id)
    if not server:
        return JSONResponse({"error": "Server not found"}, status_code=404)

    adapter = get_adapter(server)
    params = body.model_dump(exclude={"server_id", "api_key"}, exclude_none=True)

    resolved_by_key = False
    resolved_token = None

    if body.start_timestamp is None:
        params["start_timestamp"] = int((datetime.now(timezone.utc) - timedelta(days=1)).timestamp())
    if body.end_timestamp is None:
        params["end_timestamp"] = int(datetime.now(timezone.utc).timestamp())

    if body.api_key:
        if not server.get("auth_token"):
            return JSONResponse(
                {"error": "Server lacks admin token for API-key log lookup."},
                status_code=400,
            )
        token = await adapter.search_token(server, body.api_key)
        if not token or not token.get("name"):
            return JSONResponse(
                {"error": "Could not resolve token from API key."},
                status_code=404,
            )
        params["token_name"] = token["name"]
        params["accessToken"] = server["auth_token"]
        if server.get("auth_user_value"):
            params["userId"] = server["auth_user_value"]
        resolved_by_key = True
        resolved_token = token["name"]
    elif body.token_name:
        if not server.get("auth_token"):
            return JSONResponse(
                {"error": "Server lacks admin token for token-name log lookup."},
                status_code=400,
            )
        params["accessToken"] = server["auth_token"]
        if server.get("auth_user_value"):
            params["userId"] = server["auth_user_value"]
        resolved_token = body.token_name
    elif server.get("auth_token"):
        params["accessToken"] = server["auth_token"]
        if server.get("auth_user_value"):
            params["userId"] = server["auth_user_value"]

    if not params.get("accessToken"):
        return JSONResponse(
            {"error": "Missing credentials. Provide API key, token name, or configure server admin token."},
            status_code=400,
        )

    try:
        data = await adapter.fetch_logs(server, params)
        pricing = await fetch_pricing(server["id"])
        enriched = enrich_logs_payload(data, pricing)
        if isinstance(enriched, list):
            enriched = {
                "items": enriched,
                "available_groups": [],
            }
        enriched["resolved_by_key"] = resolved_by_key
        enriched["resolved_token"] = resolved_token
        return enriched
    except Exception as exc:
        return JSONResponse({"error": f"Log fetch failed: {exc}"}, status_code=502)
