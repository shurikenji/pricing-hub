"""In-memory pricing cache with TTL and sync logging."""
from __future__ import annotations

import logging
import time

from app.adapters import get_adapter
from app.schemas import NormalizedPricing
from db.queries.servers import (
    create_sync_log,
    get_enabled_servers,
    get_server,
    update_server_cache,
)

logger = logging.getLogger(__name__)

_cache: dict[str, tuple[float, NormalizedPricing]] = {}
_DEFAULT_TTL = 300  # 5 minutes


def get_cached_pricing(server_id: str) -> NormalizedPricing | None:
    entry = _cache.get(server_id)
    if entry is None:
        return None
    ts, data = entry
    if time.time() - ts > _DEFAULT_TTL:
        del _cache[server_id]
        return None
    return data


def set_cached_pricing(server_id: str, data: NormalizedPricing) -> None:
    _cache[server_id] = (time.time(), data)


async def fetch_pricing(server_id: str, *, force: bool = False) -> NormalizedPricing | None:
    """Fetch pricing for a server, using cache if available."""
    if not force:
        cached = get_cached_pricing(server_id)
        if cached:
            return cached

    server = await get_server(server_id)
    if not server:
        return None

    adapter = get_adapter(server)
    started_at = time.perf_counter()
    try:
        pricing = await adapter.fetch_pricing(server)
        set_cached_pricing(server_id, pricing)

        await update_server_cache(
            server_id,
            pricing_cache=pricing.model_dump_json(),
        )
        await create_sync_log(
            server_id,
            status="success",
            model_count=len(pricing.models),
            group_count=len(pricing.groups),
            duration_ms=int((time.perf_counter() - started_at) * 1000),
        )
        return pricing
    except Exception as exc:
        logger.error("Failed to fetch pricing for %s: %s", server_id, exc)
        await create_sync_log(
            server_id,
            status="failed",
            duration_ms=int((time.perf_counter() - started_at) * 1000),
            error_message=str(exc)[:500],
        )

        raw = server.get("pricing_cache")
        if raw:
            try:
                pricing = NormalizedPricing.model_validate_json(raw)
                set_cached_pricing(server_id, pricing)
                return pricing
            except Exception:
                pass
        return None


async def fetch_all_pricing() -> dict[str, NormalizedPricing]:
    """Fetch pricing for all enabled servers."""
    servers = await get_enabled_servers()
    result: dict[str, NormalizedPricing] = {}
    for server in servers:
        pricing = await fetch_pricing(server["id"])
        if pricing:
            result[server["id"]] = pricing
    return result
