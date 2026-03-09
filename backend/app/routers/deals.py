"""API routes for deal management and computation."""

from __future__ import annotations

import json
import logging
import traceback
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

logger = logging.getLogger(__name__)

from app.models.loan import (
    AnalyticsOutput,
    BondCashflowRow,
    BondClass,
    BondClassType,
    CashflowRow,
    CouponType,
    CPJInput,
    Deal,
    DealResult,
    DealStructure,
    LoanInput,
    LoanPricingProfile,
    PLDCurveEntry,
    PricingInput,
    TreasuryCurve,
)
from app.engines.deal_runner import run_deal, run_scenario_grid
from app.data.defaults import make_default_deal, DEFAULT_PLD_CURVE, DEFAULT_TSY_CURVE

router = APIRouter(prefix="/api/deals", tags=["deals"])

# In-memory deal storage (MVP)
DEALS_STORE: dict[str, Deal] = {}
DEALS_DIR = Path("deals_data")
DEALS_DIR.mkdir(exist_ok=True)


def _save_deal(deal: Deal) -> None:
    """Persist deal to JSON file."""
    path = DEALS_DIR / f"{deal.deal_id}.json"
    path.write_text(deal.model_dump_json(indent=2))
    DEALS_STORE[deal.deal_id] = deal


def _load_deals() -> None:
    """Load all deals from disk."""
    for path in DEALS_DIR.glob("*.json"):
        try:
            deal = Deal.model_validate_json(path.read_text())
            DEALS_STORE[deal.deal_id] = deal
        except Exception:
            pass


# Load on startup
_load_deals()


@router.get("/defaults")
def get_defaults():
    """Return default deal parameters matching Excel workbook."""
    deal = make_default_deal()
    return deal.model_dump()


@router.get("/pld-curve")
def get_pld_curve():
    """Return default PLD curve."""
    return [e.model_dump() for e in DEFAULT_PLD_CURVE]


@router.get("/tsy-curve")
def get_tsy_curve():
    """Return default treasury curve."""
    return DEFAULT_TSY_CURVE.model_dump()



@router.post("/create")
def create_deal(deal: Deal) -> Deal:
    """Create a new deal."""
    if not deal.deal_id:
        deal.deal_id = str(uuid.uuid4())[:8]
    _save_deal(deal)
    return deal


@router.get("/list")
def list_deals():
    """List all saved deals."""
    return [
        {"deal_id": d.deal_id, "deal_name": d.deal_name}
        for d in DEALS_STORE.values()
    ]


@router.get("/{deal_id}")
def get_deal(deal_id: str) -> Deal:
    """Get a deal by ID."""
    if deal_id not in DEALS_STORE:
        raise HTTPException(status_code=404, detail="Deal not found")
    return DEALS_STORE[deal_id]


@router.put("/{deal_id}")
def update_deal(deal_id: str, deal: Deal) -> Deal:
    """Update a deal."""
    deal.deal_id = deal_id
    _save_deal(deal)
    return deal


@router.post("/{deal_id}/clone")
def clone_deal(deal_id: str, new_name: str = "") -> Deal:
    """Clone a deal."""
    if deal_id not in DEALS_STORE:
        raise HTTPException(status_code=404, detail="Deal not found")
    original = DEALS_STORE[deal_id]
    cloned = original.model_copy(deep=True)
    cloned.deal_id = str(uuid.uuid4())[:8]
    cloned.deal_name = new_name or f"{original.deal_name} (copy)"
    cloned.result = None
    _save_deal(cloned)
    return cloned


@router.post("/{deal_id}/run")
def run_deal_endpoint(deal_id: str) -> DealResult:
    """Run deal computation pipeline."""
    if deal_id not in DEALS_STORE:
        raise HTTPException(status_code=404, detail="Deal not found")
    deal = DEALS_STORE[deal_id]
    try:
        result = run_deal(deal)
    except Exception as exc:
        tb = traceback.format_exc()
        logger.error("run_deal failed for %s: %s\n%s", deal_id, exc, tb)
        raise HTTPException(
            status_code=500,
            detail=f"Deal computation failed: {exc}",
        )
    deal.result = result
    _save_deal(deal)
    return result


@router.post("/run-inline")
def run_deal_inline(deal: Deal) -> DealResult:
    """Run deal computation without saving."""
    try:
        return run_deal(deal)
    except Exception as exc:
        tb = traceback.format_exc()
        logger.error("run_deal_inline failed: %s\n%s", exc, tb)
        raise HTTPException(
            status_code=500,
            detail=f"Deal computation failed: {exc}",
        )


@router.post("/{deal_id}/scenarios")
def run_scenarios(
    deal_id: str,
    rate_shocks: Optional[list[float]] = None,
    cpj_multipliers: Optional[list[float]] = None,
):
    """Run scenario grid."""
    if deal_id not in DEALS_STORE:
        raise HTTPException(status_code=404, detail="Deal not found")
    deal = DEALS_STORE[deal_id]
    return run_scenario_grid(deal, rate_shocks, cpj_multipliers)


@router.get("/{deal_id}/export/cashflows")
def export_cashflows(deal_id: str):
    """Export cashflow tables as CSV-ready data."""
    if deal_id not in DEALS_STORE:
        raise HTTPException(status_code=404, detail="Deal not found")
    deal = DEALS_STORE[deal_id]
    if not deal.result:
        raise HTTPException(status_code=400, detail="Run the deal first")

    return {
        "contractual": [cf.model_dump() for cf in deal.result.collateral_cashflows],
        "loan_pricing": [cf.model_dump() for cf in deal.result.loan_pricing_cashflows],
        "bond_collateral": [cf.model_dump() for cf in deal.result.bond_collateral_cashflows],
        "bond_classes": {
            k: [cf.model_dump() for cf in v]
            for k, v in deal.result.bond_cashflows.items()
        },
    }


@router.delete("/{deal_id}")
def delete_deal(deal_id: str):
    """Delete a deal."""
    if deal_id not in DEALS_STORE:
        raise HTTPException(status_code=404, detail="Deal not found")
    del DEALS_STORE[deal_id]
    path = DEALS_DIR / f"{deal_id}.json"
    if path.exists():
        path.unlink()
    return {"status": "deleted"}
