"""
Cashflow engine: replicates the Excel LoanAmortTbl LAMBDA exactly.

Excel LAMBDA parameters:
    settle, origbal, gwac, nwac, wam, amortwam, io, balloon, delay, seas

Excel LAMBDA body (pseudo-code translation):
    For each row rw (1-based) -> mo = rw - 1:
        gr = gwac / 12
        nr = nwac / 12
        rembal = max(0, balloon - seas)
        pmt = PMT(gr, amortwam, -origbal)
        totmo = seas + mo
        k = max(0, totmo - io - 1)
        begbal = origbal if totmo <= io
                 origbal if k == 0
                 origbal*(1+gr)^k - pmt*((1+gr)^k - 1)/gr
        pmtagy = 0 if mo == 0
                 0 if begbal < tol
                 begbal*gr if totmo <= io
                 pmt otherwise
        intinv = begbal * nr
        intagy = begbal * gr
        regprn = 0 if mo == 0 or totmo <= io or begbal < tol
                 max(0, pmtagy - intagy)
        remprn = begbal - regprn
        balloonpay = remprn if mo == rembal else 0
        endbal = max(0, remprn - balloonpay)
        netprn = regprn + balloonpay
        netflow = netprn + intinv
        dt = settle if mo == 0 else EDATE(settle, mo)
        cfdt = settle if mo == 0 else EOMONTH(settle, mo-1) + delay - 29
        yrfrac = 0 if mo == 0 else mo / 12
"""

from __future__ import annotations

import math
from datetime import date, timedelta
from calendar import monthrange
from typing import Optional

from app.models.loan import (
    CashflowRow,
    LoanInput,
    CPJInput,
    PLDCurveEntry,
)


# Default PLD curve (annualized rates by mortgage loan age bucket)
DEFAULT_PLD_CURVE: list[PLDCurveEntry] = [
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


def _excel_pmt(rate: float, nper: int, pv: float) -> float:
    """Replicate Excel PMT(rate, nper, -pv) -> positive payment amount.

    Excel: PMT(gr, amortwam, -origbal) returns the periodic payment.
    """
    if rate == 0:
        return pv / nper
    return pv * rate * (1 + rate) ** nper / ((1 + rate) ** nper - 1)


def _date_to_serial(d: date) -> int:
    """Convert a Python date to an Excel serial number (1900 date system)."""
    # Excel epoch: Jan 0, 1900 = serial 0; but Excel has the Lotus 1-2-3 bug
    # where Feb 29, 1900 exists. So serial 1 = Jan 1, 1900.
    delta = d - date(1899, 12, 30)
    return delta.days


def _serial_to_date(serial: int) -> date:
    """Convert Excel serial to Python date."""
    return date(1899, 12, 30) + timedelta(days=serial)


def _edate(base: date, months: int) -> date:
    """Excel EDATE: add months to date, keeping day-of-month (clamped)."""
    year = base.year + (base.month - 1 + months) // 12
    month = (base.month - 1 + months) % 12 + 1
    day = min(base.day, monthrange(year, month)[1])
    return date(year, month, day)


def _eomonth(base: date, months: int) -> date:
    """Excel EOMONTH: last day of month that is 'months' months from base."""
    year = base.year + (base.month - 1 + months) // 12
    month = (base.month - 1 + months) % 12 + 1
    day = monthrange(year, month)[1]
    return date(year, month, day)


def generate_contractual_cashflows(
    loan: LoanInput,
    settle_date: Optional[date] = None,
) -> list[CashflowRow]:
    """Generate contractual (no-prepay) cashflow schedule matching Excel exactly.

    This replicates the LoanAmortTbl LAMBDA function cell-by-cell.
    """
    settle = settle_date or loan.first_settle
    origbal = loan.original_face
    gwac = loan.wac_gross
    nwac = loan.coupon_net
    amortwam = loan.amort_wam
    io = loan.io_period
    balloon = loan.balloon
    delay = loan.delay
    seas = loan.seasoning

    gr = gwac / 12.0
    nr = nwac / 12.0
    rembal = max(0, balloon - seas)
    tol = 0.000001

    pmt = _excel_pmt(gr, amortwam, origbal)

    rows: list[CashflowRow] = []

    for rw in range(1, rembal + 2):  # 1-based row; rw=1 is month 0
        mo = rw - 1
        totmo = seas + mo
        k = max(0, totmo - io - 1)

        # Beginning balance
        if totmo <= io:
            begbal = origbal
        elif k == 0:
            begbal = origbal
        else:
            begbal = origbal * (1 + gr) ** k - pmt * ((1 + gr) ** k - 1) / gr

        # Payment to agency
        if mo == 0:
            pmtagy = 0.0
        elif begbal < tol:
            pmtagy = 0.0
        elif totmo <= io:
            pmtagy = begbal * gr
        else:
            pmtagy = pmt

        # Interest to investor
        if mo == 0 or begbal < tol:
            intinv = 0.0
        else:
            intinv = begbal * nr

        # Interest to agency
        if mo == 0 or begbal < tol:
            intagy = 0.0
        else:
            intagy = begbal * gr

        # Regular principal
        if mo == 0 or totmo <= io or begbal < tol:
            regprn = 0.0
        else:
            regprn = max(0.0, pmtagy - intagy)

        remprn = begbal - regprn

        # Balloon payment
        if mo == rembal:
            balloonpay = remprn
        else:
            balloonpay = 0.0

        endbal = max(0.0, remprn - balloonpay)
        netprn = regprn + balloonpay
        netflow = netprn + intinv

        # Dates
        if mo == 0:
            dt = settle
            cfdt = settle
        else:
            dt = _edate(settle, mo)
            eomonth_prev = _eomonth(settle, mo - 1)
            cfdt = eomonth_prev + timedelta(days=delay - 29)

        yrfrac = 0.0 if mo == 0 else mo / 12.0

        rows.append(CashflowRow(
            month=mo,
            date_serial=_date_to_serial(dt),
            cf_date_serial=_date_to_serial(cfdt),
            year_frac=yrfrac,
            beg_bal=begbal,
            pmt_to_agy=pmtagy,
            int_to_inv=intinv,
            int_to_agy=intagy,
            reg_prn=regprn,
            rem_prn=remprn,
            balloon_pay=balloonpay,
            end_bal=endbal,
            net_prn=netprn,
            net_flow=netflow,
        ))

    return rows


def get_pld_rate(age_months: int, pld_curve: list[PLDCurveEntry], multiplier: float = 1.0) -> float:
    """Look up the annualized PLD rate for a given mortgage loan age."""
    for entry in pld_curve:
        if entry.start_month <= age_months <= entry.end_month:
            return entry.annual_rate * multiplier
    return 0.0


def apply_cpj_overlay(
    contractual: list[CashflowRow],
    loan: LoanInput,
    cpj: CPJInput,
) -> list[CashflowRow]:
    """Apply CPJ prepayment overlay to contractual cashflows.

    CPJ definition:
    - During lockout: AnnualPrepayRate(t) = PLD_rate(t)
    - After lockout:  AnnualPrepayRate(t) = PLD_rate(t) + CPR_ann

    SMM(t) = 1 - (1 - AnnualPrepayRate(t))^(1/12)

    PrepayableBal = max(0, BegBal - ScheduledPrin)
    UnscheduledPrin = PrepayableBal * SMM
    TotalPrin = min(BegBal, ScheduledPrin + UnscheduledPrin)
    EndBal = BegBal - TotalPrin
    """
    if not cpj.enabled:
        return contractual

    pld_curve = cpj.pld_curve if cpj.pld_curve else DEFAULT_PLD_CURVE
    cpr_ann = cpj.cpj_speed / 100.0
    lockout = cpj.lockout_months

    result: list[CashflowRow] = []
    current_bal = contractual[0].beg_bal if contractual else 0.0

    for i, row in enumerate(contractual):
        new_row = row.model_copy()

        if row.month == 0:
            new_row.beg_bal = current_bal
            new_row.end_bal = current_bal
            result.append(new_row)
            continue

        new_row.beg_bal = current_bal

        # Mortgage loan age = seasoning + month
        age = loan.seasoning + row.month

        # PLD rate
        pld_rate = get_pld_rate(age, pld_curve, cpj.pld_multiplier)

        # Annual prepay rate
        if age <= lockout:
            annual_rate = pld_rate
        else:
            annual_rate = pld_rate + cpr_ann

        # Clamp to [0, 1]
        annual_rate = min(max(annual_rate, 0.0), 1.0)

        # SMM
        smm = 1.0 - (1.0 - annual_rate) ** (1.0 / 12.0)

        # Recalculate interest based on current balance
        nr = loan.coupon_net / 12.0
        gr = loan.wac_gross / 12.0
        new_row.int_to_inv = current_bal * nr
        new_row.int_to_agy = current_bal * gr

        # Scheduled principal from contractual amort applied to current balance
        # We need to compute what the scheduled principal would be on current_bal
        totmo = loan.seasoning + row.month
        if totmo <= loan.io_period or current_bal < 0.000001:
            sched_prn = 0.0
            new_row.pmt_to_agy = current_bal * gr if current_bal >= 0.000001 else 0.0
        else:
            pmt = _excel_pmt(gr, loan.amort_wam, loan.original_face)
            new_row.pmt_to_agy = pmt if current_bal >= 0.000001 else 0.0
            sched_prn = max(0.0, pmt - current_bal * gr)

        # Cap scheduled principal to current balance
        sched_prn = min(sched_prn, current_bal)

        new_row.reg_prn = sched_prn

        # Prepayable balance
        prepayable = max(0.0, current_bal - sched_prn)
        unsched_prn = prepayable * smm

        # Check if this is the balloon month
        rembal = max(0, loan.balloon - loan.seasoning)
        is_balloon = (row.month == rembal)

        if is_balloon:
            # At balloon, remaining balance pays off
            total_prn = current_bal
            new_row.balloon_pay = current_bal - sched_prn
        else:
            total_prn = min(current_bal, sched_prn + unsched_prn)
            new_row.balloon_pay = 0.0

        new_row.unsched_prn = unsched_prn if not is_balloon else (current_bal - sched_prn)
        new_row.total_prn = total_prn
        new_row.smm = smm
        new_row.annual_prepay_rate = annual_rate

        new_row.rem_prn = current_bal - sched_prn
        new_row.end_bal = max(0.0, current_bal - total_prn)
        new_row.net_prn = total_prn
        new_row.net_flow = total_prn + new_row.int_to_inv

        current_bal = new_row.end_bal

        result.append(new_row)

        # If balance is exhausted, stop
        if current_bal < 0.000001:
            break

    return result


def generate_loan_pricing_cashflows(
    loan: LoanInput,
    profile: dict,
    settle_date: Optional[date] = None,
) -> list[CashflowRow]:
    """Generate cashflows under loan pricing convention (market mode).

    The profile can override amort_wam, balloon, io_period, wam.
    """
    modified_loan = loan.model_copy()
    if profile.get("amort_wam_override") is not None:
        modified_loan.amort_wam = profile["amort_wam_override"]
    if profile.get("balloon_override") is not None:
        modified_loan.balloon = profile["balloon_override"]
    if profile.get("io_period_override") is not None:
        modified_loan.io_period = profile["io_period_override"]
    if profile.get("wam_override") is not None:
        modified_loan.wam = profile["wam_override"]

    return generate_contractual_cashflows(modified_loan, settle_date)
