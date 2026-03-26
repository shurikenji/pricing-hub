"""Public data sanitizer - hide internal details and normalize group labels."""
from __future__ import annotations

import re

from app.schemas import NormalizedGroup, NormalizedPricing, PublicServer

CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
SPACED_URL_RE = re.compile(r"\bhttps?\s+(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:/\S*)?\b", re.IGNORECASE)
DOMAIN_RE = re.compile(r"\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:/\S*)?\b", re.IGNORECASE)

_FALLBACK_REPLACEMENTS = (
    ("\u9ed8\u8ba4\u5206\u7ec4", "Default Group"),
    ("\u9ed8\u8ba4", "Default"),
    ("\u5b98\u65b9\u4e2d\u8f6c", "Official Relay"),
    ("\u5b98\u8f6c", "Official Relay"),
    ("\u5b98\u65b9", "Official"),
    ("\u5b98\u9006", "Official Reverse"),
    ("\u9006\u5411", "Reverse"),
    ("\u65e0\u5ba1", "Unfiltered"),
    ("\u9ad8\u5e76\u53d1", "High Concurrency"),
    ("\u4f4e\u5e76\u53d1", "Low Concurrency"),
    ("\u9ad8\u53ef\u7528", "High Availability"),
    ("\u4f01\u4e1a\u7ea7", "Enterprise"),
    ("\u4e13\u5c5e", "Dedicated"),
    ("\u4e13\u7528", "Dedicated"),
    ("\u7279\u4ef7", "Discount"),
    ("\u9650\u65f6", "Limited Time"),
    ("\u4f18\u8d28", "Premium"),
    ("\u76f4\u8fde", "Direct"),
    ("\u6162\u901f", "Slow"),
    ("\u6e20\u9053", "Route"),
    ("\u53ef\u7528\u7ad9\u5185\u5927\u90e8\u5206\u6a21\u578b", "Most Models"),
    ("\u5927\u6a21\u578b", "Model Pool"),
    ("\u7eaf", "Pure"),
    ("\u5206\u7ec4", "Group"),
    ("\u8be5\u6e20\u9053\u4e0d\u80fd\u8dd1", "Not supported on this route"),
    ("\u53ea\u63a5\u53d7\u5b98\u65b9\u7aef", "Official client only"),
    ("\u7981\u6b62\u9152\u9986", "SillyTavern not allowed"),
    ("\u9152\u9986", "SillyTavern"),
    ("\u6b21\u5361\u6a21\u578b", "Session Model"),
    ("\u7ed8\u753b\u6a21\u578b", "Image Model"),
    ("\u89c6\u9891\u6a21\u578b", "Video Model"),
    ("\u5b9a\u5236", "Custom"),
)


def contains_cjk(text: str) -> bool:
    return bool(text and CJK_RE.search(text))


def fallback_english(text: str) -> str:
    """Best-effort Chinese -> English using a static replacement table."""
    if not text or not contains_cjk(text):
        return text

    value = str(text)
    for source, target in _FALLBACK_REPLACEMENTS:
        value = value.replace(source, f" {target} ")

    value = (
        value
        .replace("（", "(")
        .replace("）", ")")
        .replace("【", " ")
        .replace("】", " ")
        .replace("“", " ")
        .replace("”", " ")
        .replace("‘", " ")
        .replace("’", " ")
        .replace("，", " ")
        .replace("。", " ")
        .replace("！", " ")
        .replace("？", " ")
        .replace("：", " ")
        .replace("；", " ")
        .replace("、", " ")
    )
    value = re.sub(r"[\[\]{}<>]", " ", value)
    value = CJK_RE.sub(" ", value)
    value = re.sub(r"\s*[-_/,:;]+\s*", " ", value)
    value = re.sub(r"\(\s*([^)]+?)\s*\)", r" \1 ", value)
    value = re.sub(r"\s+", " ", value).strip(" -_,.")
    return value or str(text)


def _strip_links(text: str) -> str:
    value = str(text or "")
    value = URL_RE.sub(" ", value)
    value = SPACED_URL_RE.sub(" ", value)
    value = DOMAIN_RE.sub(" ", value)
    value = re.sub(r"\bhttps?\b", " ", value, flags=re.IGNORECASE)
    value = re.sub(r"\s+", " ", value).strip(" -_,.")
    return value


def sanitize_server(server: dict) -> PublicServer:
    """Strip internal fields from server for public display."""
    return PublicServer(
        id=server["id"],
        name=server["name"],
        supports_group_chain=bool(server.get("supports_group_chain")),
    )


def sanitize_group_name(name: str, display_name: str = "") -> str:
    """Return a public-safe English group label."""
    original = (name or "").strip()
    preferred = (display_name or original).strip()
    if not original and not preferred:
        return ""

    if original and re.search(r"[A-Za-z0-9]", original):
        return fallback_english(original) if contains_cjk(original) else original

    if not contains_cjk(preferred):
        return preferred
    return fallback_english(preferred)


def sanitize_description(desc: str) -> str:
    """Clean descriptions for public display and translate CJK when present."""
    if not desc:
        return ""
    cleaned = _strip_links(desc)
    translated = fallback_english(cleaned)
    return _strip_links(translated)


def sanitize_tag(tag: str) -> str:
    """Normalize model tags for public display."""
    if not tag:
        return ""
    cleaned = _strip_links(tag)
    translated = fallback_english(cleaned)
    return _strip_links(translated) or str(tag).strip()


def sanitize_pricing(
    pricing: NormalizedPricing,
    *,
    group_catalog: dict[str, dict] | None = None,
) -> NormalizedPricing:
    """Sanitize the pricing payload for public consumption."""
    sanitized_groups = []
    allowed_group_names = set(group_catalog or {})
    for group in pricing.groups:
        catalog_item = (group_catalog or {}).get(group.name, {})
        if group_catalog is not None and group.name not in allowed_group_names:
            continue
        display_name = sanitize_group_name(
            group.name,
            str(catalog_item.get("label_en") or group.display_name or group.name),
        )
        sanitized_groups.append(
            NormalizedGroup(
                name=group.name,
                display_name=display_name,
                ratio=float(group.ratio or 1.0),
                description=sanitize_description(
                    str(catalog_item.get("desc") or group.description or "")
                ),
                category=str(catalog_item.get("category") or group.category or "Other"),
            )
        )

    group_display_map = {group.name: group.display_name for group in sanitized_groups}
    sanitized_models = []
    for model in pricing.models:
        new_group_prices = {}
        for group_name, group_price in model.group_prices.items():
            if group_catalog is not None and group_name not in allowed_group_names:
                continue
            catalog_item = (group_catalog or {}).get(group_name, {})
            copy = group_price.model_copy()
            copy.group_display_name = group_display_map.get(
                group_name,
                sanitize_group_name(
                    group_name,
                    str(
                        catalog_item.get("label_en")
                        or group_price.group_display_name
                        or group_name
                    ),
                ),
            )
            new_group_prices[group_name] = copy

        filtered_enable_groups = [
            group_name
            for group_name in model.enable_groups
            if group_catalog is None or group_name in allowed_group_names
        ]
        if group_catalog is not None and not filtered_enable_groups and not new_group_prices:
            continue

        sanitized_models.append(
            model.model_copy(
                update={
                    "description": sanitize_description(model.description),
                    "tags": [
                        normalized
                        for normalized in (sanitize_tag(tag) for tag in model.tags)
                        if normalized
                    ],
                    "enable_groups": filtered_enable_groups,
                    "group_prices": new_group_prices,
                }
            )
        )

    return NormalizedPricing(
        server_id=pricing.server_id,
        server_name=pricing.server_name,
        models=sanitized_models,
        groups=sanitized_groups,
        fetched_at=pricing.fetched_at,
    )
