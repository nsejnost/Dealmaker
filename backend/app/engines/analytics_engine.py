"""
Analytics engine: PV, yield, WAL, duration, convexity, J-spread.

Replicates Excel workbook analytics (cells I13-I21).

Excel analytics:
    Price (I13) = 100
    Accrued (I14) = 2 days accrued interest
    Yield (I15) = 5.0262282776780243
    J-Spread (I16) = 98.636284600046224 bps
    WAL (I17) = 9.5964120313959143
    Modified Duration (I18) = 7.4254997403846348
    Convexity (I19) = 0.69080983748686908
    Risk dP/dY (I20) = 7.4275623792014072
    Tsy Rate @ WAL (I21) = 4.039865431677562

Key observations from Excel:
- Net coupon (5.00%) used for Int to Inv (investor interest)
- Gross WAC (5.25%) used for Int to Agy and scheduled principal calc
- Fee = WAC - Net = 25bp
- Yield is bond-equivalent yield (BEY)
- Discounting uses CF dates (with delay) and year fractions
"""

from __future__ import annotations

import math
from typing import Optional

from app.models.loan import (
    AnalyticsOutput,
    CashflowRow,
    TreasuryCurve,
    TreasuryCurvePoint,
)


def _yf_30_360(serial1: int, serial2: int) -> float:
    """30/360 year fraction between two Excel serial dates."""
    from app.engines.cashflow_engine import _serial_to_date
    d1 = _serial_to_date(serial1)
    d2 = _serial_to_date(serial2)
    y1, m1, day1 = d1.year, d1.month, min(d1.day, 30)
    y2, m2, day2 = d2.year, d2.month, d2.day
    if day1 == 31:
        day1 = 30
    if day2 == 31 and day1 >= 30:
        day2 = 30
    return ((y2 - y1) * 360 + (m2 - m1) * 30 + (day2 - day1)) / 360.0


def compute_wal(cashflows: list[CashflowRow], settle_serial: int = 0) -> float:
    """Compute Weighted Average Life using 30/360 day count on CF dates.

    WAL = sum(NetPrn_t * YF_30_360(settle, cfdt_t)) / sum(NetPrn_t)
    """
    total_prn = 0.0
    weighted_prn = 0.0

    if settle_serial == 0 and cashflows:
        settle_serial = cashflows[0].cf_date_serial

    for cf in cashflows:
        if cf.month == 0:
            continue
        total_prn += cf.net_prn
        yf = _yf_30_360(settle_serial, cf.cf_date_serial)
        weighted_prn += cf.net_prn * yf

    if total_prn < 1e-10:
        return 0.0
    return weighted_prn / total_prn


def compute_pv(
    cashflows: list[CashflowRow],
    annual_yield: float,
    settle_serial: int,
) -> float:
    """Compute present value of investor cashflows.

    Discount each net_flow by (1 + y/2)^(2*yf) where yf = year fraction.
    The Excel workbook uses semi-annual compounding (BEY convention).
    """
    y = annual_yield / 100.0
    pv = 0.0
    for cf in cashflows:
        if cf.month == 0:
            continue
        # Year fraction from settlement to CF date
        yf = (cf.cf_date_serial - settle_serial) / 365.25
        if yf <= 0:
            pv += cf.net_flow
        else:
            # Semi-annual compounding (BEY)
            disc = (1.0 + y / 2.0) ** (2.0 * yf)
            pv += cf.net_flow / disc
    return pv


def compute_price_from_yield(
    cashflows: list[CashflowRow],
    annual_yield: float,
    settle_serial: int,
    original_face: float,
) -> float:
    """Compute dirty price per 100 face from yield (PV / face * 100)."""
    pv = compute_pv(cashflows, annual_yield, settle_serial)
    return (pv / original_face) * 100.0


def compute_yield_from_price(
    cashflows: list[CashflowRow],
    target_price: float,
    settle_serial: int,
    original_face: float,
    accrued_per_100: float = 0.0,
    tol: float = 1e-10,
    max_iter: int = 200,
) -> float:
    """Newton-Raphson solver: find yield given price.

    Price is clean price. PV is dirty (includes accrued).
    target_pv = (clean_price + accrued) / 100 * original_face
    Solve: PV(y) = target_pv
    """
    target_pv = ((target_price + accrued_per_100) / 100.0) * original_face

    y = 0.05  # initial guess 5%

    for _ in range(max_iter):
        pv = compute_pv(cashflows, y * 100.0, settle_serial)
        err = pv - target_pv

        if abs(err) < tol:
            break

        # Numerical derivative
        dy = 0.0001
        pv_up = compute_pv(cashflows, (y + dy) * 100.0, settle_serial)
        deriv = (pv_up - pv) / dy

        if abs(deriv) < 1e-15:
            break

        y = y - err / deriv

    return y * 100.0  # return as percentage


def compute_accrued(
    settle_serial: int,
    dated_date_serial: int,
    coupon_net: float,
    original_face: float,
) -> float:
    """Compute accrued interest using 30/360 convention for agency MBS.

    Accrued = yf_30_360(dated, settle) * coupon * face
    """
    yf = _yf_30_360(dated_date_serial, settle_serial)
    if yf <= 0:
        return 0.0
    return yf * coupon_net * original_face


def compute_modified_duration(
    cashflows: list[CashflowRow],
    annual_yield: float,
    settle_serial: int,
    original_face: float,
    dy_bps: float = 1.0,
) -> float:
    """Compute modified duration using finite differences.

    ModDur = -(P_up - P_dn) / (2 * dy * P_0)
    """
    p0 = compute_price_from_yield(cashflows, annual_yield, settle_serial, original_face)
    dy = dy_bps / 100.0  # convert bps to percent
    p_up = compute_price_from_yield(cashflows, annual_yield + dy, settle_serial, original_face)
    p_dn = compute_price_from_yield(cashflows, annual_yield - dy, settle_serial, original_face)

    if abs(p0) < 1e-15:
        return 0.0

    return -(p_up - p_dn) / (2.0 * (dy / 100.0) * p0)


def compute_convexity(
    cashflows: list[CashflowRow],
    annual_yield: float,
    settle_serial: int,
    original_face: float,
    dy_bps: float = 1.0,
) -> float:
    """Compute convexity using finite differences.

    Convexity = (P_up + P_dn - 2*P_0) / (dy^2 * P_0)
    """
    p0 = compute_price_from_yield(cashflows, annual_yield, settle_serial, original_face)
    dy = dy_bps / 100.0
    p_up = compute_price_from_yield(cashflows, annual_yield + dy, settle_serial, original_face)
    p_dn = compute_price_from_yield(cashflows, annual_yield - dy, settle_serial, original_face)

    if abs(p0) < 1e-15:
        return 0.0

    return (p_up + p_dn - 2.0 * p0) / ((dy / 100.0) ** 2 * p0) / 100.0


def compute_risk_dpdy(
    cashflows: list[CashflowRow],
    annual_yield: float,
    settle_serial: int,
    original_face: float,
    dy_bps: float = 1.0,
) -> float:
    """Compute dollar risk dP/dY (price change per 100bp yield change).

    Risk = -(P_up - P_dn) / (2 * dy_in_pct)
    """
    dy = dy_bps / 100.0
    p_up = compute_price_from_yield(cashflows, annual_yield + dy, settle_serial, original_face)
    p_dn = compute_price_from_yield(cashflows, annual_yield - dy, settle_serial, original_face)

    return -(p_up - p_dn) / (2.0 * dy)


def interpolate_tsy_rate(wal: float, curve: TreasuryCurve) -> float:
    """Linear interpolation of treasury rate at given WAL."""
    points = sorted(curve.points, key=lambda p: p.term)
    if not points:
        return 0.0

    if wal <= points[0].term:
        return points[0].rate
    if wal >= points[-1].term:
        return points[-1].rate

    for i in range(len(points) - 1):
        if points[i].term <= wal <= points[i + 1].term:
            t1, r1 = points[i].term, points[i].rate
            t2, r2 = points[i + 1].term, points[i + 1].rate
            frac = (wal - t1) / (t2 - t1)
            return r1 + frac * (r2 - r1)

    return points[-1].rate


def compute_j_spread(
    annual_yield: float,
    wal: float,
    curve: TreasuryCurve,
) -> float:
    """J-Spread = Yield - interpolated treasury rate at WAL, in basis points."""
    tsy_rate = interpolate_tsy_rate(wal, curve)
    return (annual_yield - tsy_rate) * 100.0  # bps


def compute_full_analytics(
    cashflows: list[CashflowRow],
    settle_serial: int,
    dated_date_serial: int,
    coupon_net: float,
    original_face: float,
    pricing_type: str,
    pricing_input: float,
    curve: TreasuryCurve,
) -> AnalyticsOutput:
    """Compute all analytics matching Excel output."""
    wal = compute_wal(cashflows, settle_serial)

    # Compute accrued before pricing so yield solver can use it
    accrued_val = compute_accrued(settle_serial, dated_date_serial, coupon_net, original_face)
    accrued_per_face = accrued_val / original_face * 100.0 if original_face > 0 else 0.0

    if pricing_type == "Price":
        price = pricing_input
        yield_pct = compute_yield_from_price(
            cashflows, price, settle_serial, original_face,
            accrued_per_100=accrued_per_face,
        )
    elif pricing_type == "JSpread":
        # pricing_input is J-Spread in bps; solve for yield = tsy_rate_at_wal + spread
        tsy_at_wal = interpolate_tsy_rate(wal, curve)
        yield_pct = tsy_at_wal + pricing_input / 100.0
        price = compute_price_from_yield(
            cashflows, yield_pct, settle_serial, original_face
        ) - accrued_per_face  # convert dirty → clean
    else:
        yield_pct = pricing_input
        price = compute_price_from_yield(
            cashflows, yield_pct, settle_serial, original_face
        ) - accrued_per_face  # convert dirty → clean

    mod_dur = compute_modified_duration(
        cashflows, yield_pct, settle_serial, original_face
    )
    convex = compute_convexity(
        cashflows, yield_pct, settle_serial, original_face
    )
    risk = compute_risk_dpdy(
        cashflows, yield_pct, settle_serial, original_face
    )
    tsy_at_wal = interpolate_tsy_rate(wal, curve)
    j_spread = compute_j_spread(yield_pct, wal, curve)

    return AnalyticsOutput(
        price=price,
        accrued=accrued_per_face,
        yield_pct=yield_pct,
        j_spread=j_spread,
        wal=wal,
        modified_duration=mod_dur,
        convexity=convex,
        risk_dpdy=risk,
        tsy_rate_at_wal=tsy_at_wal,
    )
