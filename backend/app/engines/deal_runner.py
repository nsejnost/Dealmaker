"""
Deal runner: orchestrates cashflow generation, CPJ overlay, waterfall, and analytics.

Three cashflow streams:
A) Contractual (spreadsheet parity) - no prepay
B) Loan Pricing (market convention) - optional overrides
C) Bond Valuation (contractual + CPJ) - feeds waterfall
"""

from __future__ import annotations

from datetime import date

from app.models.loan import (
    AnalyticsOutput,
    BondCashflowRow,
    CashflowRow,
    Deal,
    DealResult,
    TreasuryCurve,
    TreasuryCurvePoint,
)
from app.engines.cashflow_engine import (
    generate_contractual_cashflows,
    generate_loan_pricing_cashflows,
    apply_cpj_overlay,
    _date_to_serial,
)
from app.engines.analytics_engine import compute_full_analytics
from app.engines.waterfall_engine import run_waterfall, compute_bond_analytics


DEFAULT_TSY_CURVE = TreasuryCurve(points=[
    TreasuryCurvePoint(term=1 / 12, rate=3.564),
    TreasuryCurvePoint(term=2 / 12, rate=3.698),
    TreasuryCurvePoint(term=3 / 12, rate=3.682),
    TreasuryCurvePoint(term=4 / 12, rate=3.673),
    TreasuryCurvePoint(term=6 / 12, rate=3.633),
    TreasuryCurvePoint(term=1.0, rate=3.564),
    TreasuryCurvePoint(term=2.0, rate=3.513),
    TreasuryCurvePoint(term=3.0, rate=3.521),
    TreasuryCurvePoint(term=5.0, rate=3.649),
    TreasuryCurvePoint(term=7.0, rate=3.846),
    TreasuryCurvePoint(term=10.0, rate=4.070),
    TreasuryCurvePoint(term=20.0, rate=4.665),
    TreasuryCurvePoint(term=30.0, rate=4.716),
])


def run_deal(deal: Deal) -> DealResult:
    """Execute the full deal computation pipeline."""
    loan = deal.loan
    pricing = deal.pricing

    settle_serial = _date_to_serial(pricing.settle_date)
    dated_serial = _date_to_serial(loan.dated_date)

    curve = deal.treasury_curve if deal.treasury_curve.points else DEFAULT_TSY_CURVE

    # --- Stream A: Contractual cashflows (spreadsheet parity) ---
    contractual_cfs = generate_contractual_cashflows(loan, pricing.settle_date)

    contractual_analytics = compute_full_analytics(
        cashflows=contractual_cfs,
        settle_serial=settle_serial,
        dated_date_serial=dated_serial,
        coupon_net=loan.coupon_net,
        original_face=loan.original_face,
        pricing_type=pricing.pricing_type.value,
        pricing_input=pricing.pricing_input,
        curve=curve,
    )

    # --- Stream B: Loan Pricing cashflows (market convention) ---
    loan_pricing_cfs = contractual_cfs  # default: same as contractual
    loan_pricing_analytics = contractual_analytics

    if deal.loan_pricing_profile:
        profile_dict = deal.loan_pricing_profile.model_dump()
        if any(v is not None for v in profile_dict.values()):
            loan_pricing_cfs = generate_loan_pricing_cashflows(
                loan, profile_dict, pricing.settle_date
            )
            loan_pricing_analytics = compute_full_analytics(
                cashflows=loan_pricing_cfs,
                settle_serial=settle_serial,
                dated_date_serial=dated_serial,
                coupon_net=loan.coupon_net,
                original_face=loan.original_face,
                pricing_type=pricing.pricing_type.value,
                pricing_input=pricing.pricing_input,
                curve=curve,
            )

    # --- Stream C: Bond collateral cashflows (contractual + CPJ) ---
    if deal.cpj.enabled:
        # Copy lockout from loan if not set on CPJ
        cpj = deal.cpj.model_copy()
        if cpj.lockout_months == 0 and loan.lockout_months > 0:
            cpj.lockout_months = loan.lockout_months
        bond_collat_cfs = apply_cpj_overlay(contractual_cfs, loan, cpj)
    else:
        bond_collat_cfs = contractual_cfs

    # --- Waterfall ---
    bond_cashflows: dict[str, list[BondCashflowRow]] = {}
    bond_analytics: dict[str, AnalyticsOutput] = {}
    io_cashflows: list[BondCashflowRow] = []

    if deal.structure.classes:
        bond_cashflows = run_waterfall(
            bond_collat_cfs,
            deal.structure,
            [loan],
        )

        # Compute bond analytics
        for cls in deal.structure.classes:
            if cls.class_id in bond_cashflows:
                ba = compute_bond_analytics(
                    bond_cashflows[cls.class_id],
                    settle_serial,
                    bond_collat_cfs,
                    cls.original_balance if cls.original_balance > 0 else 1.0,
                    cls.pricing_type.value,
                    cls.pricing_input,
                    curve,
                )
                bond_analytics[cls.class_id] = AnalyticsOutput(
                    price=ba["price"],
                    yield_pct=ba["yield_pct"],
                    wal=ba["wal"],
                    j_spread=ba["j_spread"],
                    modified_duration=ba["modified_duration"],
                    convexity=ba["convexity"],
                    risk_dpdy=ba["risk_dpdy"],
                    tsy_rate_at_wal=ba["tsy_rate_at_wal"],
                    accrued=ba["accrued"],
                )

            if cls.class_type.value == "IO" and cls.class_id in bond_cashflows:
                io_cashflows = bond_cashflows[cls.class_id]

    return DealResult(
        collateral_cashflows=contractual_cfs,
        collateral_analytics=contractual_analytics,
        loan_pricing_cashflows=loan_pricing_cfs,
        loan_pricing_analytics=loan_pricing_analytics,
        bond_collateral_cashflows=bond_collat_cfs,
        bond_cashflows=bond_cashflows,
        bond_analytics=bond_analytics,
        io_cashflows=io_cashflows,
    )


def run_scenario_grid(
    deal: Deal,
    rate_shocks_bps: list[float] = None,
    cpj_multipliers: list[float] = None,
) -> dict:
    """Run scenario grid for bond valuation.

    Returns nested dict: {rate_shock: {cpj_mult: {class_id: analytics}}}
    """
    if rate_shocks_bps is None:
        rate_shocks_bps = [-100, -50, -25, 0, 25, 50, 100]
    if cpj_multipliers is None:
        cpj_multipliers = [0.5, 1.0, 1.5]

    base_result = run_deal(deal)
    base_yield = base_result.collateral_analytics.yield_pct if base_result.collateral_analytics else 5.0

    grid: dict = {}

    for shock in rate_shocks_bps:
        grid[shock] = {}
        for mult in cpj_multipliers:
            # Create modified deal
            mod_deal = deal.model_copy(deep=True)

            # Adjust CPJ speed
            if mod_deal.cpj.enabled:
                mod_deal.cpj.cpj_speed = deal.cpj.cpj_speed * mult

            result = run_deal(mod_deal)

            # Re-price bonds at shocked yield
            shocked_yield = base_yield + shock / 100.0
            class_results = {}

            for cls in mod_deal.structure.classes:
                if cls.class_id in result.bond_cashflows:
                    ba = compute_bond_analytics(
                        result.bond_cashflows[cls.class_id],
                        _date_to_serial(deal.pricing.settle_date),
                        result.bond_collateral_cashflows,
                        cls.original_balance if cls.original_balance > 0 else 1.0,
                        shocked_yield,
                    )
                    class_results[cls.class_id] = {
                        "price": ba["price"],
                        "wal": ba["wal"],
                        "pnl": ba["price"] - (base_result.bond_analytics.get(
                            cls.class_id, AnalyticsOutput()
                        ).price or 100.0),
                    }

            grid[shock][mult] = class_results

    return grid
