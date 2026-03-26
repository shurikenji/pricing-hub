"""Translation cache and optional AI translation for public pricing."""
from __future__ import annotations

import json
import logging
import re
from typing import Any

import aiohttp

from app.config import get_settings
from app.sanitizer import contains_cjk, fallback_english, sanitize_pricing
from app.schemas import NormalizedPricing
from db.queries.translations import get_cached_translations, save_translations

logger = logging.getLogger(__name__)

_AI_TIMEOUT = aiohttp.ClientTimeout(total=30)


async def build_public_pricing(pricing: NormalizedPricing, server_type: str) -> NormalizedPricing:
    """Apply cached/AI translations before public sanitization."""
    translated = await apply_group_translations(pricing, server_type)
    return sanitize_pricing(translated)


async def apply_group_translations(pricing: NormalizedPricing, server_type: str) -> NormalizedPricing:
    keys = []
    group_payloads = []
    for group in pricing.groups:
        if contains_cjk(group.display_name or group.name) or contains_cjk(group.description):
            keys.append(group.name)
            group_payloads.append({
                "original_name": group.name,
                "display_name": group.display_name or group.name,
                "description": group.description or "",
            })

    cached = await get_cached_translations(keys, server_type)
    missing = [item for item in group_payloads if item["original_name"] not in cached]
    if missing:
        generated = _build_fallback_translations(missing)
        ai_generated = await _translate_groups_with_ai(missing)
        if ai_generated:
            generated.update(ai_generated)
        if generated:
            cached.update(generated)
            await save_translations(generated, server_type)

    translated_groups = []
    for group in pricing.groups:
        data = cached.get(group.name)
        if data:
            translated_groups.append(group.model_copy(update={
                "display_name": data.get("name_en") or fallback_english(group.display_name or group.name),
                "description": data.get("desc_en") or fallback_english(group.description),
                "category": data.get("category") or group.category,
            }))
        else:
            translated_groups.append(group)

    return pricing.model_copy(update={"groups": translated_groups})


async def warm_translation_cache(pricing: NormalizedPricing, server_type: str) -> int:
    """Populate translation cache for a pricing snapshot and return affected group count."""
    keys = []
    group_payloads = []
    for group in pricing.groups:
        if contains_cjk(group.display_name or group.name) or contains_cjk(group.description):
            keys.append(group.name)
            group_payloads.append({
                "original_name": group.name,
                "display_name": group.display_name or group.name,
                "description": group.description or "",
            })

    cached = await get_cached_translations(keys, server_type)
    missing = [item for item in group_payloads if item["original_name"] not in cached]
    if not missing:
        return 0

    generated = _build_fallback_translations(missing)
    ai_generated = await _translate_groups_with_ai(missing)
    if ai_generated:
        generated.update(ai_generated)
    if generated:
        await save_translations(generated, server_type)
    return len(generated)


def _build_fallback_translations(groups: list[dict[str, str]]) -> dict[str, dict]:
    translated: dict[str, dict] = {}
    for item in groups:
        key = item["original_name"]
        translated[key] = {
            "name_en": fallback_english(item.get("display_name") or key),
            "desc_en": fallback_english(item.get("description") or ""),
            "category": "Other",
        }
    return translated


async def _translate_groups_with_ai(groups: list[dict[str, str]]) -> dict[str, dict]:
    settings = get_settings()
    if not settings.ai_enabled or not settings.ai_api_key:
        return {}

    endpoint = (settings.ai_base_url or "https://api.openai.com/v1").rstrip("/") + "/chat/completions"
    payload = {
        "model": settings.ai_model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": (
                    "Translate Chinese API group labels into concise English. "
                    "Return JSON with key 'items'. Each item must include "
                    "original_name, name_en, desc_en, and category. "
                    "Categories: General, Premium, Official, Reverse, Experimental, Regional, Other."
                ),
            },
            {
                "role": "user",
                "content": json.dumps({"items": groups}, ensure_ascii=False),
            },
        ],
    }
    headers = {
        "Authorization": f"Bearer {settings.ai_api_key}",
        "Content-Type": "application/json",
    }

    try:
        async with aiohttp.ClientSession(timeout=_AI_TIMEOUT) as session:
            async with session.post(endpoint, json=payload, headers=headers) as resp:
                data = await resp.json()
                content = (
                    data.get("choices", [{}])[0]
                    .get("message", {})
                    .get("content", "")
                )
    except Exception as exc:
        logger.warning("AI translation request failed: %s", exc)
        return {}

    parsed = _parse_ai_json(content)
    items = parsed.get("items", [])
    if not isinstance(items, list):
        return {}

    translated: dict[str, dict] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        key = str(item.get("original_name") or "").strip()
        if not key:
            continue
        translated[key] = {
            "name_en": str(item.get("name_en") or "").strip() or fallback_english(key),
            "desc_en": str(item.get("desc_en") or "").strip(),
            "category": str(item.get("category") or "Other").strip() or "Other",
        }
    return translated


def _parse_ai_json(content: str) -> dict[str, Any]:
    if not content:
        return {}
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        logger.warning("Could not parse AI translation payload")
        return {}
