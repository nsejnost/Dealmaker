"""GNR Deal Maker - FastAPI application."""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import deals

app = FastAPI(
    title="GNR Deal Maker",
    description="Deal structuring + analytics for Ginnie Mae Multifamily / Project Loan Agency CMBS (GNR REMIC)",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],
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
