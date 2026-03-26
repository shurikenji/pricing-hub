"""Adapter factory — returns the right adapter for a server type."""
from __future__ import annotations

from app.adapters.base import BaseAdapter
from app.adapters.custom import CustomAdapter
from app.adapters.newapi import NewApiAdapter
from app.adapters.rixapi import RixApiAdapter


_ADAPTERS: dict[str, type[BaseAdapter]] = {
    "custom": CustomAdapter,
    "newapi": NewApiAdapter,
    "rixapi": RixApiAdapter,
}


def get_adapter(server: dict) -> BaseAdapter:
    server_type = (server.get("type") or "newapi").lower()
    cls = _ADAPTERS.get(server_type, NewApiAdapter)
    return cls()
