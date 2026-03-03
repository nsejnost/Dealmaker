"""Default data for GNR Deal Maker."""

from datetime import date

from app.models.loan import (
    CPJInput,
    Deal,
    DealStructure,
    LoanInput,
    LoanPricingProfile,
    PLDCurveEntry,
    PricingInput,
    PricingType,
    TreasuryCurve,
    TreasuryCurvePoint,
)


DEFAULT_PLD_CURVE = [
    PLDCurveEntry(start_month=1, end_month=12, annual_rate=0.0130),
    PLDCurveEntry(start_month=13, end_month=24, annual_rate=0.0247),
    PLDCurveEntry(start_month=25, end_month=36, annual_rate=0.0251),
    PLDCurveEntry(start_month=37, end_month=48, annual_rate=0.0220),
    PLDCurveEntry(start_month=49, end_month=60, annual_rate=0.0213),
    PLDCurveEntry(start_month=61, end_month=72, annual_rate=0.0146),
    PLDCurveEntry(start_month=73, end_month=84, annual_rate=0.0126),
    PLDCurveEntry(start_month=85, end_month=96, annual_rate=0.0080),
    PLDCurveEntry(start_month=97, end_month=108, annual_rate=0.0057),
    PLDCurveEntry(start_month=109, end_month=168, annual_rate=0.0050),
    PLDCurveEntry(start_month=169, end_month=240, annual_rate=0.0025),
    PLDCurveEntry(start_month=241, end_month=9999, annual_rate=0.0000),
]


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


def make_default_deal() -> Deal:
    """Create default deal matching Excel workbook inputs."""
    return Deal(
        deal_id="default",
        deal_name="GNPL Default (Excel Parity)",
        loan=LoanInput(
            dated_date=date(2026, 3, 1),
            first_settle=date(2026, 3, 1),
            delay=44,
            original_face=1_000_000.0,
            coupon_net=0.05,
            wac_gross=0.0525,
            wam=480,
            amort_wam=480,
            io_period=0,
            balloon=120,
            seasoning=0,
        ),
        pricing=PricingInput(
            pricing_type=PricingType.PRICE,
            pricing_input=100.0,
            settle_date=date(2026, 3, 3),
            curve_date=date(2026, 3, 3),
        ),
        treasury_curve=DEFAULT_TSY_CURVE,
        cpj=CPJInput(
            enabled=False,
            cpj_speed=15.0,
            lockout_months=0,
            pld_curve=DEFAULT_PLD_CURVE,
        ),
        structure=DealStructure(),
    )
