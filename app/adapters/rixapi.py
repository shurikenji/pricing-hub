"""RixAPI adapter — servers like 996444.cn.

RixAPI pricing endpoint returns both group_info and model_info inline.
Group ratios are embedded in group_info with GroupRatio field.
Supports group chain natively.
"""
from __future__ import annotations

import logging

from app.adapters.newapi import NewApiAdapter

logger = logging.getLogger(__name__)


class RixApiAdapter(NewApiAdapter):
    """RixAPI is a superset of NewAPI with inline group ratios.

    The normalize logic in NewApiAdapter already handles the RixAPI
    ``group_info`` / ``model_info`` structure, so we inherit directly.
    The only difference is RixAPI does NOT need ``/api/ratio_config``.
    """

    async def fetch_pricing(self, server: dict) -> "NormalizedPricing":  # noqa: F821
        from app.adapters.base import build_headers, join_url, _TIMEOUT
        import aiohttp
        from datetime import datetime, timezone

        headers = build_headers(server)
        url = join_url(server["base_url"], server.get("pricing_path") or "/api/pricing")
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers, timeout=_TIMEOUT) as resp:
                    pricing_data = await resp.json()
                    if not isinstance(pricing_data, dict):
                        pricing_data = {}
        except Exception as exc:
            logger.error("RixAPI fetch %s failed: %s", url, exc)
            pricing_data = {}

        # RixAPI has everything inline — no ratio_config needed
        return self._normalize(server, pricing_data, {})
