"""Translation cache and optional AI translation for public pricing."""
from __future__ import annotations

import json
import logging
import re
from typing import Any

import aiohttp

from app.config import get_settings
from app.group_catalog import build_group_catalog_map, ensure_server_group_catalog
from app.sanitizer import contains_cjk, fallback_english, sanitize_pricing
from app.schemas import NormalizedPricing
from db.queries.settings import get_settings_dict
from db.queries.translations import get_cached_translations, save_translations

logger = logging.getLogger(__name__)

_AI_TIMEOUT = aiohttp.ClientTimeout(total=45)
_ALLOWED_CATEGORIES = {
    "General",
    "Premium",
    "Official",
    "Reverse",
    "Experimental",
    "Regional",
    "Other",
}

async def build_public_pricing(pricing: NormalizedPricing, server: dict) -> NormalizedPricing:
    """Apply cached/AI translations before public sanitization."""
    server_type = str(server.get("type") or "newapi")
    catalog_rows = await ensure_server_group_catalog(server)
    group_catalog = build_group_catalog_map(catalog_rows) if catalog_rows else None

    if group_catalog:
        return sanitize_pricing(pricing, group_catalog=group_catalog)

    translated = await apply_group_translations(pricing, server_type)
    return sanitize_pricing(translated)


async def translate_group_rows(groups: list[dict[str, Any]], server_type: str) -> list[dict[str, Any]]:
    """Translate a raw server group catalog using the same cache/AI flow as shopbot."""
    payloads = [_group_row_payload(group) for group in groups if str(group.get("name") or "").strip()]
    if not payloads:
        return []

    cached = await get_cached_translations(
        [item["original_name"] for item in payloads],
        server_type,
    )
    missing = [
        item
        for item in payloads
        if _needs_translation_refresh(item, cached.get(item["original_name"]))
    ]

    if missing:
        generated = _build_fallback_translations(missing)
        ai_generated = await _translate_groups_with_ai(missing)
        if ai_generated:
            generated.update(_sanitize_translation_payload(ai_generated, missing))
        if generated:
            cached.update(generated)
            await save_translations(generated, server_type)

    translated_rows: list[dict[str, Any]] = []
    payload_map = {item["original_name"]: item for item in payloads}
    for group in groups:
        original_name = str(group.get("name") or "").strip()
        if not original_name:
            continue
        payload = payload_map[original_name]
        translation = cached.get(original_name, {})
        normalized = _build_translation_fields(payload, translation)
        translated_rows.append(
            {
                **group,
                "label_en": normalized["name_en"],
                "name_en": normalized["name_en"],
                "desc": normalized["desc_en"] or str(group.get("desc") or ""),
                "desc_en": normalized["desc_en"],
                "category": normalized["category"] or str(group.get("category") or "Other"),
            }
        )

    return translated_rows


async def apply_group_translations(pricing: NormalizedPricing, server_type: str) -> NormalizedPricing:
    group_payloads = _collect_groups_for_translation(pricing)
    cached = await get_cached_translations([item["original_name"] for item in group_payloads], server_type)
    missing = [item for item in group_payloads if _needs_translation_refresh(item, cached.get(item["original_name"]))]

    if missing:
        generated = _build_fallback_translations(missing)
        ai_generated = await _translate_groups_with_ai(missing)
        if ai_generated:
            generated.update(_sanitize_translation_payload(ai_generated, missing))
        if generated:
            cached.update(generated)
            await save_translations(generated, server_type)

    translated_groups = []
    for group in pricing.groups:
        data = cached.get(group.name)
        if data:
            normalized = _build_translation_fields(_group_payload(group), data)
            translated_groups.append(group.model_copy(update={
                "display_name": normalized["name_en"],
                "description": normalized["desc_en"],
                "category": normalized["category"] or group.category,
            }))
        else:
            translated_groups.append(group)

    return pricing.model_copy(update={"groups": translated_groups})


async def warm_translation_cache(pricing: NormalizedPricing, server_type: str) -> int:
    """Populate translation cache for a pricing snapshot and return affected group count."""
    group_payloads = _collect_groups_for_translation(pricing)
    cached = await get_cached_translations([item["original_name"] for item in group_payloads], server_type)
    missing = [item for item in group_payloads if _needs_translation_refresh(item, cached.get(item["original_name"]))]
    if not missing:
        return 0

    generated = _build_fallback_translations(missing)
    ai_generated = await _translate_groups_with_ai(missing)
    if ai_generated:
        generated.update(_sanitize_translation_payload(ai_generated, missing))
    if generated:
        await save_translations(generated, server_type)
    return len(generated)


def _collect_groups_for_translation(pricing: NormalizedPricing) -> list[dict[str, str]]:
    return [
        _group_payload(group)
        for group in pricing.groups
        if contains_cjk(group.display_name or group.name) or contains_cjk(group.description)
    ]


def _group_payload(group) -> dict[str, str]:
    original_name = str(group.name or "").strip()
    display_name = str(group.display_name or original_name).strip()
    description = str(group.description or "").strip()
    source_text = description or display_name or original_name
    return {
        "original_name": original_name,
        "display_name": display_name,
        "description": description,
        "source_text": source_text,
    }


def _group_row_payload(group: dict[str, Any]) -> dict[str, str]:
    original_name = str(group.get("name") or "").strip()
    display_name = str(
        group.get("label_en")
        or group.get("name_en")
        or group.get("display_name")
        or original_name
    ).strip()
    description = str(group.get("desc") or group.get("description") or "").strip()
    source_text = str(
        group.get("translation_source")
        or description
        or display_name
        or original_name
    ).strip()
    return {
        "original_name": original_name,
        "display_name": display_name,
        "description": description,
        "source_text": source_text,
    }


def _needs_translation_refresh(group: dict[str, str], cached: dict[str, Any] | None = None) -> bool:
    current = cached or {}
    name_en = str(current.get("name_en") or "").strip()
    desc_en = str(current.get("desc_en") or "").strip()
    if not name_en or contains_cjk(name_en):
        return True
    if not desc_en and contains_cjk(group.get("source_text") or ""):
        return True
    return contains_cjk(desc_en)


def _resolve_english_name(*, preferred: object, original_name: str, source_text: str) -> str:
    name_en = str(preferred or "").strip()
    if name_en and not contains_cjk(name_en):
        return name_en
    return (
        fallback_english(name_en)
        or fallback_english(original_name)
        or fallback_english(source_text)
        or original_name
    )


def _resolve_english_description(*, preferred: object, source_text: str, fallback_name: str) -> str:
    desc_en = str(preferred or "").strip()
    if desc_en and not contains_cjk(desc_en):
        return desc_en
    return (
        fallback_english(desc_en)
        or fallback_english(source_text)
        or fallback_name
    )


def _build_translation_fields(group: dict[str, str], translation: dict[str, Any]) -> dict[str, str]:
    original_name = str(group.get("original_name") or "")
    source_text = str(group.get("source_text") or original_name)
    name_en = _resolve_english_name(
        preferred=translation.get("name_en") or group.get("display_name"),
        original_name=original_name,
        source_text=source_text,
    )
    desc_en = _resolve_english_description(
        preferred=translation.get("desc_en") or group.get("description"),
        source_text=source_text,
        fallback_name=name_en,
    )
    category = str(translation.get("category") or "Other").strip() or "Other"
    if category not in _ALLOWED_CATEGORIES:
        category = "Other"
    return {
        "name_en": name_en,
        "desc_en": desc_en,
        "category": category,
    }


def _sanitize_translation_payload(
    translations: dict[str, dict[str, Any]],
    groups: list[dict[str, str]],
) -> dict[str, dict[str, str]]:
    source_map = {group["original_name"]: group for group in groups}
    cleaned: dict[str, dict[str, str]] = {}
    for original_name, translation in translations.items():
        group = source_map.get(original_name)
        if not group:
            continue
        cleaned[original_name] = _build_translation_fields(group, translation)
    return cleaned


def _build_fallback_translations(groups: list[dict[str, str]]) -> dict[str, dict[str, str]]:
    return {
        item["original_name"]: _build_translation_fields(item, {})
        for item in groups
    }


async def _translate_groups_with_ai(groups: list[dict[str, str]]) -> dict[str, dict[str, Any]]:
    ai_settings = await _get_runtime_ai_settings()
    if not ai_settings["enabled"] or not ai_settings["api_key"]:
        return {}

    system_prompt = (
        "You translate API token-group labels and descriptions into concise English for a pricing dashboard. "
        "Use source_text as the richer context when it contains Chinese notes, route hints, or quality markers. "
        "Preserve well-known brand names like Azure, OpenAI, Claude, Gemini, Grok, Kimi, DeepSeek, and Anthropic. "
        "Return English only. No Chinese characters, no mixed Chinese-English output, no markdown. "
        "Return JSON with key 'items'. Each item must include original_name, name_en, desc_en, and category. "
        "Allowed categories: General, Premium, Official, Reverse, Experimental, Regional, Other."
    )
    user_prompt = json.dumps({"items": groups}, ensure_ascii=False)

    try:
        provider = ai_settings["provider"]
        if provider == "anthropic":
            content = await _call_anthropic(
                system_prompt,
                user_prompt,
                api_key=ai_settings["api_key"],
                model=ai_settings["model"],
            )
        elif provider == "gemini":
            content = await _call_gemini(
                system_prompt,
                user_prompt,
                api_key=ai_settings["api_key"],
                model=ai_settings["model"],
            )
        elif provider == "openai_compatible":
            content = await _call_openai_chat(
                system_prompt,
                user_prompt,
                api_key=ai_settings["api_key"],
                model=ai_settings["model"],
                endpoint=_resolve_openai_endpoint(ai_settings["base_url"], compatible_only=True),
            )
        else:
            content = await _call_openai_chat(
                system_prompt,
                user_prompt,
                api_key=ai_settings["api_key"],
                model=ai_settings["model"],
                endpoint=_resolve_openai_endpoint(ai_settings["base_url"], compatible_only=False),
            )
    except Exception as exc:
        logger.warning("AI translation request failed: %s", exc)
        return {}

    return _normalize_ai_response(_parse_ai_json(content))


def _resolve_openai_endpoint(base_url: str, *, compatible_only: bool) -> str:
    normalized = (base_url or "").strip().rstrip("/")
    if not normalized:
        return "https://api.openai.com/v1/chat/completions"
    if normalized.endswith("/chat/completions"):
        return normalized
    if normalized.endswith("/v1"):
        return f"{normalized}/chat/completions"
    if compatible_only:
        return f"{normalized}/v1/chat/completions"
    return f"{normalized}/v1/chat/completions"


async def _call_openai_chat(system_prompt: str, user_prompt: str, *, api_key: str, model: str, endpoint: str) -> str:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }

    async with aiohttp.ClientSession(timeout=_AI_TIMEOUT) as session:
        async with session.post(endpoint, json=payload, headers=headers) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise RuntimeError(f"OpenAI-compatible AI error {resp.status}: {text[:300]}")
            data = await resp.json()
            return (
                data.get("choices", [{}])[0]
                .get("message", {})
                .get("content", "")
            )


async def _call_anthropic(system_prompt: str, user_prompt: str, *, api_key: str, model: str) -> str:
    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
    }
    payload = {
        "model": model,
        "max_tokens": 1500,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
    }

    async with aiohttp.ClientSession(timeout=_AI_TIMEOUT) as session:
        async with session.post("https://api.anthropic.com/v1/messages", json=payload, headers=headers) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise RuntimeError(f"Anthropic AI error {resp.status}: {text[:300]}")
            data = await resp.json()
            parts = data.get("content", [])
            if not parts:
                return ""
            return str(parts[0].get("text") or "")


async def _call_gemini(system_prompt: str, user_prompt: str, *, api_key: str, model: str) -> str:
    model = model if model.startswith("gemini-") else f"gemini-{model}"
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": f"{system_prompt}\n\n{user_prompt}"}],
            }
        ],
        "generationConfig": {
            "temperature": 0,
            "maxOutputTokens": 1500,
        },
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

    async with aiohttp.ClientSession(timeout=_AI_TIMEOUT) as session:
        async with session.post(url, json=payload, headers={"Content-Type": "application/json"}) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise RuntimeError(f"Gemini AI error {resp.status}: {text[:300]}")
            data = await resp.json()
            candidates = data.get("candidates", [])
            if not candidates:
                return ""
            parts = candidates[0].get("content", {}).get("parts", [])
            if not parts:
                return ""
            return str(parts[0].get("text") or "")


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
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                parsed = json.loads(text[start:end])
                return parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                pass
        logger.warning("Could not parse AI translation payload")
        return {}


def _normalize_ai_response(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    if not payload:
        return {}

    if isinstance(payload.get("items"), list):
        items = payload["items"]
    else:
        items = []

    translations: dict[str, dict[str, Any]] = {}

    for item in items:
        if not isinstance(item, dict):
            continue
        original_name = str(item.get("original_name") or "").strip()
        if not original_name:
            continue
        translations[original_name] = {
            "name_en": str(item.get("name_en") or "").strip(),
            "desc_en": str(item.get("desc_en") or "").strip(),
            "category": str(item.get("category") or "Other").strip() or "Other",
        }

    if translations:
        return translations

    for original_name, item in payload.items():
        if original_name == "items" or not isinstance(item, dict):
            continue
        translations[str(original_name).strip()] = {
            "name_en": str(item.get("name_en") or "").strip(),
            "desc_en": str(item.get("desc_en") or "").strip(),
            "category": str(item.get("category") or "Other").strip() or "Other",
        }
    return translations


async def _get_runtime_ai_settings() -> dict[str, str | bool]:
    env_settings = get_settings()
    defaults = {
        "ai_provider": env_settings.ai_provider,
        "ai_api_key": env_settings.ai_api_key,
        "ai_model": env_settings.ai_model,
        "ai_base_url": env_settings.ai_base_url,
        "ai_enabled": "true" if env_settings.ai_enabled else "false",
    }
    stored = await get_settings_dict(defaults)
    return {
        "provider": str(stored.get("ai_provider") or "openai").strip().lower(),
        "api_key": str(stored.get("ai_api_key") or "").strip(),
        "model": str(stored.get("ai_model") or env_settings.ai_model).strip(),
        "base_url": str(stored.get("ai_base_url") or "").strip(),
        "enabled": str(stored.get("ai_enabled") or "").strip().lower() == "true",
    }


async def test_ai_connection(provider: str, api_key: str, model: str, base_url: str = "") -> tuple[bool, str]:
    provider_value = (provider or "openai").strip().lower()
    key_value = (api_key or "").strip()
    model_value = (model or "").strip()
    base_url_value = (base_url or "").strip()

    if not key_value:
        return False, "API key is required."
    if not model_value:
        return False, "Model is required."

    system_prompt = "Reply with a short JSON object."
    user_prompt = '{"ping":"ok"}'

    try:
        if provider_value == "anthropic":
            content = await _call_anthropic(
                system_prompt,
                user_prompt,
                api_key=key_value,
                model=model_value,
            )
        elif provider_value == "gemini":
            content = await _call_gemini(
                system_prompt,
                user_prompt,
                api_key=key_value,
                model=model_value,
            )
        elif provider_value == "openai_compatible":
            content = await _call_openai_chat(
                system_prompt,
                user_prompt,
                api_key=key_value,
                model=model_value,
                endpoint=_resolve_openai_endpoint(base_url_value, compatible_only=True),
            )
        else:
            content = await _call_openai_chat(
                system_prompt,
                user_prompt,
                api_key=key_value,
                model=model_value,
                endpoint=_resolve_openai_endpoint(base_url_value, compatible_only=False),
            )
    except Exception as exc:
        return False, str(exc)

    return True, "Connection succeeded." if content is not None else "Connection succeeded."
