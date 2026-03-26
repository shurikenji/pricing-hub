"""FastAPI application factory."""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.config import get_settings

_BASE_DIR = Path(__file__).resolve().parent.parent


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    from db.database import close_db, init_db

    await init_db()
    try:
        yield
    finally:
        await close_db()


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title=settings.app_title,
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )

    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.admin_secret,
    )

    # Static files
    static_dir = _BASE_DIR / "static"
    static_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    # --- Public routers ---
    from app.routers.public_pricing import router as pricing_router
    from app.routers.public_logs import router as logs_router
    from app.routers.public_keys import router as keys_router

    app.include_router(pricing_router)
    app.include_router(logs_router)
    app.include_router(keys_router)

    # --- API routers ---
    from app.routers.api_pricing import router as api_pricing_router
    from app.routers.api_logs import router as api_logs_router
    from app.routers.api_keys import router as api_keys_router

    app.include_router(api_pricing_router)
    app.include_router(api_logs_router)
    app.include_router(api_keys_router)

    # --- Admin routers ---
    from app.routers.control.auth import router as auth_router
    from app.routers.control.settings import router as settings_router
    from app.routers.control.servers import router as servers_router

    app.include_router(auth_router)
    app.include_router(settings_router)
    app.include_router(servers_router)

    # Health check
    @app.get("/health")
    async def health():
        return {"status": "ok"}

    return app
