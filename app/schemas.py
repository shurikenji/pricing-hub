"""Pydantic models for normalized pricing data."""
from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class ServerType(str, Enum):
    newapi = "newapi"
    rixapi = "rixapi"
    custom = "custom"


class AuthMode(str, Enum):
    header = "header"
    bearer = "bearer"
    cookie = "cookie"
    none = "none"


class PricingMode(str, Enum):
    token = "token"
    request_scaled = "request_scaled"
    fixed = "fixed"
    unknown = "unknown"


# --- Normalized pricing data ---


class GroupPriceSnapshot(BaseModel):
    group_name: str
    group_display_name: str = ""
    group_ratio: float = 1.0
    pricing_mode: PricingMode = PricingMode.unknown
    input_price_per_1m: float | None = None
    output_price_per_1m: float | None = None
    cached_input_price_per_1m: float | None = None
    request_price: float | None = None


class NormalizedModel(BaseModel):
    model_name: str
    description: str = ""
    icon: str = ""
    tags: list[str] = Field(default_factory=list)
    vendor_name: str = ""
    pricing_mode: PricingMode = PricingMode.unknown
    model_ratio: float = 0.0
    completion_ratio: float = 0.0
    cache_ratio: float | None = None
    model_price: float = 0.0
    enable_groups: list[str] = Field(default_factory=list)
    supported_endpoints: list[str] = Field(default_factory=list)
    # Computed base prices (group_ratio=1)
    input_price_per_1m: float | None = None
    output_price_per_1m: float | None = None
    cached_input_price_per_1m: float | None = None
    request_price: float | None = None
    # Per-group prices
    group_prices: dict[str, GroupPriceSnapshot] = Field(default_factory=dict)


class NormalizedGroup(BaseModel):
    name: str
    display_name: str = ""
    ratio: float = 1.0
    description: str = ""
    category: str = "Other"


class NormalizedPricing(BaseModel):
    server_id: str
    server_name: str
    models: list[NormalizedModel] = Field(default_factory=list)
    groups: list[NormalizedGroup] = Field(default_factory=list)
    fetched_at: str = ""


# --- Public-safe server info ---


class PublicServer(BaseModel):
    id: str
    name: str
    type: ServerType
    supports_group_chain: bool = False


# --- Admin server config ---


class ServerConfig(BaseModel):
    id: str
    name: str
    base_url: str
    type: ServerType = ServerType.newapi
    enabled: bool = True
    sort_order: int = 0
    supports_group_chain: bool = False
    ratio_config_enabled: bool = False
    auth_mode: AuthMode = AuthMode.header
    auth_user_header: str = ""
    auth_user_value: str = ""
    auth_token: str = ""
    auth_cookie: str = ""
    pricing_path: str = "/api/pricing"
    ratio_config_path: str = "/api/ratio_config"
    log_path: str = "/api/log/self"
    token_search_path: str = "/api/token/search"
    groups_path: str = ""
    notes: str = ""
