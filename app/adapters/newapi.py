"""NewAPI adapter — servers like AABao, KKSJ, XJAI.

These servers expose:
  /api/pricing      → model list with quota_type, model_ratio, etc.
  /api/ratio_config → model_ratio, completion_ratio, cache_ratio (optional)

Pricing formula (token-based):
  input_usd_per_1M  = 2 * group_ratio * model_ratio
  output_usd_per_1M = 2 * group_ratio * model_ratio * completion_ratio
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

import aiohttp

from app.adapters.base import (
    BaseAdapter,
    build_headers,
    compute_token_prices,
    infer_endpoints,
    infer_pricing_mode,
    join_url,
    normalize_tags,
    _TIMEOUT,
)
from app.schemas import (
    GroupPriceSnapshot,
    NormalizedGroup,
    NormalizedModel,
    NormalizedPricing,
    PricingMode,
)

logger = logging.getLogger(__name__)


class NewApiAdapter(BaseAdapter):
    """Adapter for standard NewAPI / OneAPI servers."""

    async def fetch_pricing(self, server: dict) -> NormalizedPricing:
        headers = build_headers(server)
        pricing_data = await self._fetch_json(server, server.get("pricing_path") or "/api/pricing", headers)
        ratio_data: dict = {}
        if server.get("ratio_config_enabled"):
            ratio_data = await self._fetch_json(server, server.get("ratio_config_path") or "/api/ratio_config", headers)

        return self._normalize(server, pricing_data, ratio_data)

    # ── internal helpers ─────────────────────────────────────────────────

    async def _fetch_json(self, server: dict, path: str, headers: dict) -> dict:
        url = join_url(server["base_url"], path)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers, timeout=_TIMEOUT) as resp:
                    data = await resp.json()
                    return data if isinstance(data, dict) else {}
        except Exception as exc:
            logger.error("NewAPI fetch %s failed: %s", url, exc)
            return {}

    def _normalize(
        self,
        server: dict,
        pricing_raw: dict,
        ratio_raw: dict,
    ) -> NormalizedPricing:
        now = datetime.now(timezone.utc).isoformat()

        # --- Parse ratio_config if available ---
        ratio_map: dict[str, dict] = {}
        if ratio_raw:
            data = ratio_raw.get("data", ratio_raw)
            if isinstance(data, dict):
                for model_id, info in data.items():
                    if isinstance(info, dict):
                        ratio_map[model_id] = info

        # --- Parse groups from pricing data ---
        groups_dict: dict[str, NormalizedGroup] = {}
        raw_data = pricing_raw.get("data", pricing_raw)

        # RixAPI-style inline group_info
        group_info = raw_data.get("group_info", {}) if isinstance(raw_data, dict) else {}
        for gname, ginfo in group_info.items():
            if isinstance(ginfo, dict):
                groups_dict[gname] = NormalizedGroup(
                    name=gname,
                    display_name=ginfo.get("DisplayName", gname),
                    ratio=float(ginfo.get("GroupRatio", 1.0)),
                    description=ginfo.get("Description", ""),
                )

        # --- Parse models ---
        models: list[NormalizedModel] = []
        model_list = raw_data.get("model_info", []) if isinstance(raw_data, dict) else []
        if not isinstance(model_list, list):
            model_list = []

        for entry in model_list:
            if not isinstance(entry, dict):
                continue
            model_name = entry.get("model_name") or ""
            if not model_name:
                continue

            # Get ratio data (prefer ratio_config, fallback to pricing inline)
            ratio_info = ratio_map.get(model_name, {})

            # Extract price_info — first group's default pricing as base
            price_info = entry.get("price_info", {})
            base_pricing = self._extract_base_pricing(price_info, ratio_info)

            model_ratio = base_pricing["model_ratio"]
            completion_ratio = base_pricing["completion_ratio"]
            cache_ratio = base_pricing["cache_ratio"]
            model_price = base_pricing["model_price"]
            quota_type = base_pricing["quota_type"]

            pricing_mode = infer_pricing_mode(quota_type, model_price, model_ratio, completion_ratio)

            # Compute base prices (group_ratio=1)
            input_p = output_p = cached_p = request_p = None
            if pricing_mode == PricingMode.token and model_ratio > 0:
                prices = compute_token_prices(model_ratio, completion_ratio, 1.0, cache_ratio)
                input_p = prices["input"]
                output_p = prices["output"]
                cached_p = prices["cached"]
            elif pricing_mode == PricingMode.fixed and model_price > 0:
                request_p = model_price

            # Tags
            raw_tags = entry.get("tags")
            tags = normalize_tags(raw_tags)
            if pricing_mode == PricingMode.token and "thinking" in model_name.lower() and "thinking" not in tags:
                tags.append("thinking")

            # Endpoints
            endpoints = infer_endpoints(
                entry.get("supported_endpoint_types"),
                entry.get("endpoints"),
                model_name,
                tags,
            )

            # Enable groups
            enable_groups = entry.get("enable_groups") or []

            # Per-group prices
            group_prices: dict[str, GroupPriceSnapshot] = {}
            for gname in enable_groups:
                g = groups_dict.get(gname)
                gr = g.ratio if g else 1.0
                gp_pricing = self._extract_group_pricing(price_info, gname, ratio_info)
                gp_mode = infer_pricing_mode(
                    gp_pricing["quota_type"], gp_pricing["model_price"],
                    gp_pricing["model_ratio"], gp_pricing["completion_ratio"],
                )
                snap = GroupPriceSnapshot(
                    group_name=gname,
                    group_display_name=g.display_name if g else gname,
                    group_ratio=gr,
                    pricing_mode=gp_mode,
                )
                if gp_mode == PricingMode.token and gp_pricing["model_ratio"] > 0:
                    prices = compute_token_prices(
                        gp_pricing["model_ratio"], gp_pricing["completion_ratio"],
                        gr, gp_pricing["cache_ratio"],
                    )
                    snap.input_price_per_1m = prices["input"]
                    snap.output_price_per_1m = prices["output"]
                    snap.cached_input_price_per_1m = prices["cached"]
                elif gp_mode == PricingMode.fixed:
                    snap.request_price = gp_pricing["model_price"]
                group_prices[gname] = snap

            models.append(NormalizedModel(
                model_name=model_name,
                description=entry.get("description", ""),
                icon=entry.get("icon", ""),
                tags=tags,
                vendor_name=entry.get("owner_by", ""),
                pricing_mode=pricing_mode,
                model_ratio=model_ratio,
                completion_ratio=completion_ratio,
                cache_ratio=cache_ratio,
                model_price=model_price,
                enable_groups=enable_groups,
                supported_endpoints=endpoints,
                input_price_per_1m=input_p,
                output_price_per_1m=output_p,
                cached_input_price_per_1m=cached_p,
                request_price=request_p,
                group_prices=group_prices,
            ))

        return NormalizedPricing(
            server_id=server["id"],
            server_name=server["name"],
            models=models,
            groups=list(groups_dict.values()),
            fetched_at=now,
        )

    def _extract_base_pricing(self, price_info: dict, ratio_info: dict) -> dict:
        """Extract base pricing from first available group or ratio_config."""
        model_ratio = float(ratio_info.get("model_ratio", 0))
        completion_ratio = float(ratio_info.get("completion_ratio", 0))
        cache_ratio_val = ratio_info.get("cache_ratio")
        cache_ratio = float(cache_ratio_val) if cache_ratio_val is not None else None
        model_price = float(ratio_info.get("model_price", 0))
        quota_type = int(ratio_info.get("quota_type", 1))

        # If ratio_config has values, use them
        if model_ratio > 0 or model_price > 0:
            return {
                "model_ratio": model_ratio,
                "completion_ratio": completion_ratio,
                "cache_ratio": cache_ratio,
                "model_price": model_price,
                "quota_type": quota_type,
            }

        # Fallback: extract from first group in price_info
        for _gname, gdata in (price_info or {}).items():
            if isinstance(gdata, dict):
                default = gdata.get("default", gdata)
                if isinstance(default, dict):
                    return {
                        "model_ratio": float(default.get("model_ratio", 0)),
                        "completion_ratio": float(default.get("model_completion_ratio", 0)),
                        "cache_ratio": float(cr) if (cr := default.get("model_cache_ratio")) is not None else None,
                        "model_price": float(default.get("model_price", 0)),
                        "quota_type": int(default.get("quota_type", 1)),
                    }
            break

        return {"model_ratio": 0, "completion_ratio": 0, "cache_ratio": None, "model_price": 0, "quota_type": 1}

    def _extract_group_pricing(self, price_info: dict, group_name: str, ratio_info: dict) -> dict:
        """Extract pricing for a specific group."""
        gdata = (price_info or {}).get(group_name, {})
        if isinstance(gdata, dict):
            default = gdata.get("default", gdata)
            if isinstance(default, dict):
                return {
                    "model_ratio": float(default.get("model_ratio", 0)),
                    "completion_ratio": float(default.get("model_completion_ratio", 0)),
                    "cache_ratio": float(cr) if (cr := default.get("model_cache_ratio")) is not None else None,
                    "model_price": float(default.get("model_price", 0)),
                    "quota_type": int(default.get("quota_type", 1)),
                }
        # Fallback to ratio_config
        return self._extract_base_pricing(price_info, ratio_info)
