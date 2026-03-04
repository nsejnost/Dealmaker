"""GNR Deal Maker - FastAPI application."""

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse

from app.routers import deals

app = FastAPI(
    title="GNR Deal Maker",
    description="Deal structuring + analytics for Ginnie Mae Multifamily / Project Loan Agency CMBS (GNR REMIC)",
    version="1.0.0",
)

# CORS: read allowed origins from env var, fall back to localhost defaults
_default_origins = "http://localhost:3000,http://localhost:5173"
_origins = os.environ.get("ALLOWED_ORIGINS", _default_origins).split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(deals.router)


@app.get("/")
def root():
    return {"app": "GNR Deal Maker", "version": "1.0.0"}


@app.get("/health")
def health():
    return {"status": "ok"}


# Serve React static build if the static directory exists
_static_dir = Path(__file__).resolve().parent.parent / "static"
if _static_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=_static_dir / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Catch-all: serve index.html for any non-API route (SPA fallback)."""
        file_path = _static_dir / full_path
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(_static_dir / "index.html")
