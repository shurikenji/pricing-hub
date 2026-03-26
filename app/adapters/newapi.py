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
    extract_ratio_hint,
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
        ratio_map = self._build_ratio_map(ratio_raw)

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

        # NewAPI/AABao-style top-level group metadata
        group_ratio = pricing_raw.get("group_ratio", {})
        usable_group = pricing_raw.get("usable_group", {})
        if isinstance(group_ratio, dict) or isinstance(usable_group, dict):
            group_names = set()
            if isinstance(group_ratio, dict):
                group_names.update(str(name) for name in group_ratio.keys())
            if isinstance(usable_group, dict):
                group_names.update(str(name) for name in usable_group.keys())
            for gname in sorted(group_names):
                description = str(usable_group.get(gname, "")) if isinstance(usable_group, dict) else ""
                groups_dict[gname] = NormalizedGroup(
                    name=gname,
                    display_name=self._group_display_name(gname, description),
                    ratio=self._to_float(
                        group_ratio.get(gname) if isinstance(group_ratio, dict) else None,
                        default=extract_ratio_hint(description, default=1.0),
                    ),
                    description=description,
                )

        # --- Parse models ---
        models: list[NormalizedModel] = []
        model_list: list[dict] = []
        if isinstance(raw_data, dict):
            candidate = raw_data.get("model_info") or raw_data.get("data") or []
            if isinstance(candidate, list):
                model_list = [item for item in candidate if isinstance(item, dict)]
        elif isinstance(raw_data, list):
            model_list = [item for item in raw_data if isinstance(item, dict)]
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
            base_pricing = self._extract_base_pricing(price_info, ratio_info, entry)

            model_ratio = base_pricing["model_ratio"]
            cache_ratio = base_pricing["cache_ratio"]
            model_price = base_pricing["model_price"]
            quota_type = base_pricing["quota_type"]

            # Tags
            raw_tags = entry.get("tags")
            tags = normalize_tags(raw_tags)
            if "thinking" in model_name.lower() and "thinking" not in tags:
                tags.append("thinking")

            completion_ratio = self._resolve_completion_ratio(
                model_name,
                base_pricing["completion_ratio"],
                tags,
            )

            pricing_mode = infer_pricing_mode(quota_type, model_price, model_ratio, completion_ratio)

            # Compute base prices (group_ratio=1)
            input_p = output_p = cached_p = request_p = None
            if pricing_mode == PricingMode.token and model_ratio > 0:
                prices = compute_token_prices(model_ratio, max(completion_ratio, 0.0), 1.0, cache_ratio)
                input_p = prices["input"]
                output_p = None if completion_ratio <= 0 else prices["output"]
                cached_p = prices["cached"]
            elif pricing_mode == PricingMode.fixed and model_price > 0:
                request_p = model_price

            # Endpoints
            endpoints = infer_endpoints(
                entry.get("supported_endpoint_types"),
                entry.get("endpoints"),
                model_name,
                tags,
            )

            # Enable groups
            enable_groups = entry.get("enable_groups") or []
            if not enable_groups and isinstance(price_info, dict):
                enable_groups = [str(name) for name in price_info.keys()]
            enable_groups = [str(name) for name in enable_groups if str(name).strip()]

            # Per-group prices
            group_prices: dict[str, GroupPriceSnapshot] = {}
            for gname in enable_groups:
                g = groups_dict.get(gname)
                gr = g.ratio if g else 1.0
                gp_pricing = self._extract_group_pricing(price_info, gname, ratio_info, entry)
                gp_completion_ratio = self._resolve_completion_ratio(
                    model_name,
                    gp_pricing["completion_ratio"],
                    tags,
                )
                gp_mode = infer_pricing_mode(
                    gp_pricing["quota_type"], gp_pricing["model_price"],
                    gp_pricing["model_ratio"], gp_completion_ratio,
                )
                snap = GroupPriceSnapshot(
                    group_name=gname,
                    group_display_name=g.display_name if g else gname,
                    group_ratio=gr,
                    pricing_mode=gp_mode,
                )
                if gp_mode == PricingMode.token and gp_pricing["model_ratio"] > 0:
                    prices = compute_token_prices(
                        gp_pricing["model_ratio"], max(gp_completion_ratio, 0.0),
                        gr, gp_pricing["cache_ratio"],
                    )
                    snap.input_price_per_1m = prices["input"]
                    snap.output_price_per_1m = None if gp_completion_ratio <= 0 else prices["output"]
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

    def _build_ratio_map(self, ratio_raw: dict) -> dict[str, dict]:
        ratio_map: dict[str, dict] = {}
        if not ratio_raw:
            return ratio_map

        data = ratio_raw.get("data", ratio_raw)
        if not isinstance(data, dict):
            return ratio_map

        # Shape A: {model_id: {model_ratio, completion_ratio, ...}}
        for model_id, info in data.items():
            if isinstance(info, dict) and any(
                key in info for key in ("model_ratio", "completion_ratio", "cache_ratio", "model_price", "quota_type")
            ):
                ratio_map[str(model_id)] = info

        # Shape B: {model_ratio: {...}, completion_ratio: {...}, ...}
        grouped_fields = {
            "model_ratio": data.get("model_ratio"),
            "completion_ratio": data.get("completion_ratio"),
            "cache_ratio": data.get("cache_ratio"),
            "model_price": data.get("model_price"),
            "quota_type": data.get("quota_type"),
        }
        if any(isinstance(value, dict) for value in grouped_fields.values()):
            model_names: set[str] = set()
            for value in grouped_fields.values():
                if isinstance(value, dict):
                    model_names.update(str(name) for name in value.keys())
            for model_name in model_names:
                info = ratio_map.setdefault(model_name, {})
                for field_name, field_value in grouped_fields.items():
                    if isinstance(field_value, dict) and model_name in field_value:
                        info[field_name] = field_value[model_name]

        return ratio_map

    def _group_display_name(self, group_name: str, description: str) -> str:
        if not description:
            return group_name
        head = description.split("（", 1)[0].strip()
        return head or group_name

    def _is_single_sided_token_model(self, model_name: str, tags: list[str]) -> bool:
        lower_name = model_name.lower()
        if any(tag in {"audio", "rerank"} for tag in tags):
            return True
        return any(
            hint in lower_name
            for hint in (
                "embedding",
                "whisper",
                "tts-",
                "tts_",
                "speech",
                "transcription",
                "rerank",
                "moderation",
            )
        )

    def _resolve_completion_ratio(self, model_name: str, completion_ratio: float, tags: list[str]) -> float:
        if completion_ratio > 0:
            return completion_ratio
        if self._is_single_sided_token_model(model_name, tags):
            return 0.0
        # Some upstream NewAPI servers omit completion_ratio for chat models.
        # Missing should not be interpreted as free output.
        return 1.0

    def _to_float(self, value: object, *, default: float = 0.0) -> float:
        try:
            if value is None or value == "":
                return default
            return float(value)
        except (TypeError, ValueError):
            return default

    def _extract_base_pricing(self, price_info: dict, ratio_info: dict, entry: dict | None = None) -> dict:
        """Extract base pricing from first available group or ratio_config."""
        model_ratio = self._to_float(ratio_info.get("model_ratio"))
        completion_ratio = self._to_float(ratio_info.get("completion_ratio"))
        cache_ratio_val = ratio_info.get("cache_ratio")
        cache_ratio = self._to_float(cache_ratio_val, default=0.0) if cache_ratio_val is not None else None
        model_price = self._to_float(ratio_info.get("model_price"))
        quota_type = int(self._to_float(ratio_info.get("quota_type"), default=1))

        if entry:
            if model_ratio <= 0:
                model_ratio = self._to_float(entry.get("model_ratio"))
            if completion_ratio <= 0:
                completion_ratio = self._to_float(entry.get("completion_ratio"))
            if model_price <= 0:
                model_price = self._to_float(entry.get("model_price"))
            if quota_type == 1 and entry.get("quota_type") is not None:
                quota_type = int(self._to_float(entry.get("quota_type"), default=1))

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
                        "model_ratio": self._to_float(default.get("model_ratio")),
                        "completion_ratio": self._to_float(default.get("model_completion_ratio")),
                        "cache_ratio": self._to_float(cr, default=0.0) if (cr := default.get("model_cache_ratio")) is not None else None,
                        "model_price": self._to_float(default.get("model_price")),
                        "quota_type": int(self._to_float(default.get("quota_type"), default=1)),
                    }
            break

        return {"model_ratio": 0, "completion_ratio": 0, "cache_ratio": None, "model_price": 0, "quota_type": 1}

    def _extract_group_pricing(self, price_info: dict, group_name: str, ratio_info: dict, entry: dict | None = None) -> dict:
        """Extract pricing for a specific group."""
        gdata = (price_info or {}).get(group_name, {})
        if isinstance(gdata, dict) and gdata:
            default = gdata.get("default", gdata)
            if isinstance(default, dict) and default:
                return {
                    "model_ratio": self._to_float(default.get("model_ratio")),
                    "completion_ratio": self._to_float(default.get("model_completion_ratio")),
                    "cache_ratio": self._to_float(cr, default=0.0) if (cr := default.get("model_cache_ratio")) is not None else None,
                    "model_price": self._to_float(default.get("model_price")),
                    "quota_type": int(self._to_float(default.get("quota_type"), default=1)),
                }
        # Fallback to ratio_config
        return self._extract_base_pricing(price_info, ratio_info, entry)

    async def fetch_groups(self, server: dict) -> list[dict]:
        groups = await super().fetch_groups(server)
        if groups or server.get("groups_path"):
            return groups

        fallback_server = {**server, "groups_path": "/api/token/group"}
        return await super().fetch_groups(fallback_server)

    def parse_groups(self, data: dict) -> list[dict]:
        """Ported from shopbot NewAPI client group parsing."""
        groups: list[dict] = []

        if (
            isinstance(data, dict)
            and isinstance(data.get("data"), dict)
            and isinstance(data.get("ratios"), dict)
        ):
            descriptions = data.get("data", {})
            ratios = data.get("ratios", {})
            for name, desc in descriptions.items():
                groups.append(
                    {
                        "name": name,
                        "ratio": ratios.get(name, 1.0),
                        "desc": desc if isinstance(desc, str) else "",
                        "translation_source": desc if isinstance(desc, str) else name,
                    }
                )
            return groups

        if isinstance(data, dict):
            for name, info in data.items():
                if isinstance(info, dict):
                    groups.append(
                        {
                            "name": name,
                            "ratio": info.get("ratio", 1.0),
                            "desc": info.get("desc", ""),
                            "translation_source": info.get("desc", "") or name,
                        }
                    )
                else:
                    groups.append(
                        {
                            "name": name,
                            "ratio": 1.0,
                            "desc": "",
                            "translation_source": name,
                        }
                    )
        elif isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    name = (
                        item.get("value")
                        or item.get("group")
                        or item.get("name")
                        or item.get("key")
                        or "unknown"
                    )
                    raw_label = item.get("key") or item.get("label") or item.get("description") or ""
                    groups.append(
                        {
                            "name": name,
                            "ratio": item.get("ratio") or item.get("multiplier") or extract_ratio_hint(raw_label, name),
                            "desc": item.get("desc") or item.get("description") or raw_label,
                            "translation_source": raw_label or item.get("description") or item.get("desc") or name,
                        }
                    )

        return groups
