"""Admin authentication — simple secret-based login."""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from app.config import get_settings
from app.deps import get_templates

router = APIRouter(prefix="/control", tags=["admin"])


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    templates = get_templates()
    return templates.TemplateResponse("control/login.html", {
        "request": request,
        "error": "",
    })


@router.post("/login")
async def login_submit(request: Request):
    form = await request.form()
    secret = str(form.get("secret", "")).strip()
    settings = get_settings()

    if secret == settings.admin_secret:
        request.session["is_admin"] = True
        return RedirectResponse("/control", status_code=303)

    templates = get_templates()
    return templates.TemplateResponse("control/login.html", {
        "request": request,
        "error": "Invalid secret.",
    })


@router.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/control/login", status_code=303)


@router.get("", response_class=HTMLResponse)
async def control_dashboard(request: Request):
    if not request.session.get("is_admin"):
        return RedirectResponse("/control/login", status_code=303)
    templates = get_templates()
    return templates.TemplateResponse("control/dashboard.html", {
        "request": request,
    })
