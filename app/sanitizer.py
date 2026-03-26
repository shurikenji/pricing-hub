"""Public data sanitizer — hide internal details, translate to English."""
from __future__ import annotations

import re

from app.schemas import NormalizedGroup, NormalizedModel, NormalizedPricing, PublicServer

CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")

# Chinese → English fallback replacements (ported from shopbot)
_FALLBACK_REPLACEMENTS = (
    ("默认分组", "Default Group"),
    ("默认", "Default"),
    ("官转", "Official Relay"),
    ("官方", "Official"),
    ("官逆", "Official Reverse"),
    ("逆向", "Reverse"),
    ("无审", "Unfiltered"),
    ("高并发", "High Concurrency"),
    ("低并发", "Low Concurrency"),
    ("高可用", "High Availability"),
    ("企业级", "Enterprise"),
    ("专属", "Dedicated"),
    ("特价", "Discount"),
    ("优质", "Premium"),
    ("直连", "Direct"),
    ("慢速", "Slow"),
    ("渠道", "Route"),
    ("可用站内大部分模型", "Most Models"),
    ("大模型", "Model Pool"),
    ("纯", "Pure"),
    ("分组", "Group"),
    ("该渠道不能跑", "Not supported on this route:"),
    ("只接受官方端", "Official client only"),
    ("禁止酒馆", "SillyTavern not allowed"),
)


def contains_cjk(text: str) -> bool:
    return bool(CJK_RE.search(text))


def fallback_english(text: str) -> str:
    """Best-effort Chinese → English using static replacement table."""
    if not text or not contains_cjk(text):
        return text
    value = text
    for source, target in _FALLBACK_REPLACEMENTS:
        value = value.replace(source, f" {target} ")
    value = value.replace("（", "(").replace("）", ")")
    value = re.sub(r"[\[\]{}]", " ", value)
    value = CJK_RE.sub(" ", value)
    value = re.sub(r"\s*[-_/,:;]+\s*", " ", value)
    value = re.sub(r"\(\s*([^)]+?)\s*\)", r" \1 ", value)
    value = re.sub(r"\s+", " ", value).strip(" -_,")
    return value or text


def sanitize_server(server: dict) -> PublicServer:
    """Strip internal fields from server for public display."""
    return PublicServer(
        id=server["id"],
        name=server["name"],
        type=server.get("type", "newapi"),
        supports_group_chain=bool(server.get("supports_group_chain")),
    )


def sanitize_group_name(name: str, display_name: str = "") -> str:
    """Return a public-safe English group label."""
    preferred = display_name or name
    if not contains_cjk(preferred):
        return preferred
    return fallback_english(preferred)


def sanitize_description(desc: str) -> str:
    """Clean description for public display — translate CJK."""
    if not desc:
        return ""
    return fallback_english(desc)


def sanitize_pricing(pricing: NormalizedPricing) -> NormalizedPricing:
    """Sanitize entire pricing payload for public consumption."""
    sanitized_groups = []
    for g in pricing.groups:
        sanitized_groups.append(NormalizedGroup(
            name=g.name,
            display_name=sanitize_group_name(g.name, g.display_name),
            ratio=g.ratio,
            description=sanitize_description(g.description),
            category=g.category,
        ))

    group_display_map = {g.name: g.display_name for g in sanitized_groups}

    sanitized_models = []
    for m in pricing.models:
        new_group_prices = {}
        for gname, gp in m.group_prices.items():
            gp_copy = gp.model_copy()
            gp_copy.group_display_name = group_display_map.get(gname, sanitize_group_name(gname, gp.group_display_name))
            new_group_prices[gname] = gp_copy

        sanitized_models.append(m.model_copy(update={
            "description": sanitize_description(m.description),
            "group_prices": new_group_prices,
        }))

    return NormalizedPricing(
        server_id=pricing.server_id,
        server_name=pricing.server_name,
        models=sanitized_models,
        groups=sanitized_groups,
        fetched_at=pricing.fetched_at,
    )
