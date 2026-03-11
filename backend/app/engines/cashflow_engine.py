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
    PrepaymentAssumption,
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
    io = loan.io_period if loan.io_period is not None else 0
    balloon = loan.balloon  # None means no balloon (fully amortizing)
    delay = loan.delay
    seas = loan.seasoning
    wam = loan.wam

    gr = gwac / 12.0
    nr = nwac / 12.0
    # When balloon is None → fully amortizing (use wam as term)
    if balloon is not None:
        rembal = max(0, balloon - seas)
    else:
        rembal = max(0, wam - seas)
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
        elif gr == 0:
            begbal = origbal - pmt * k
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

        # Balloon payment (only if balloon is explicitly set)
        if balloon is not None and mo == rembal:
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

        # Recalculate interest based on current balance
        nr = loan.coupon_net / 12.0
        gr = loan.wac_gross / 12.0
        new_row.int_to_inv = current_bal * nr
        new_row.int_to_agy = current_bal * gr

        # Scheduled principal: scale by surviving balance factor
        io_period = loan.io_period if loan.io_period is not None else 0
        totmo = loan.seasoning + row.month
        if totmo <= io_period or current_bal < 0.000001:
            sched_prn = 0.0
            new_row.pmt_to_agy = current_bal * gr if current_bal >= 0.000001 else 0.0
        else:
            sched_factor = row.reg_prn / row.beg_bal if row.beg_bal > 0.000001 else 0.0
            sched_prn = min(current_bal, current_bal * sched_factor)
            new_row.pmt_to_agy = current_bal * gr + sched_prn

        new_row.reg_prn = sched_prn

        # Compute separate SMMs using hazard-style decomposition
        smm_pld = 1.0 - (1.0 - min(max(pld_rate, 0.0), 1.0)) ** (1.0 / 12.0)
        if age <= lockout:
            smm_cpr = 0.0
        else:
            smm_cpr = 1.0 - (1.0 - min(max(cpr_ann, 0.0), 1.0)) ** (1.0 / 12.0)

        # Total SMM via hazard combination (consistent decomposition)
        smm = 1.0 - (1.0 - smm_pld) * (1.0 - smm_cpr)

        # Prepayable balance and hazard-consistent split
        prepayable = max(0.0, current_bal - sched_prn)
        unsched_prn_inv = prepayable * smm_pld
        unsched_prn_vol = prepayable * (1.0 - smm_pld) * smm_cpr
        unsched_prn = unsched_prn_inv + unsched_prn_vol

        # Check if this is the balloon month
        balloon = loan.balloon
        if balloon is not None:
            rembal = max(0, balloon - loan.seasoning)
            is_balloon = (row.month == rembal)
        else:
            is_balloon = False

        if is_balloon:
            # Balloon payoff is contractual maturity principal, not prepayment
            total_prn = current_bal
            new_row.balloon_pay = current_bal - sched_prn
            new_row.unsched_prn = 0.0
            new_row.unsched_prn_vol = 0.0
            new_row.unsched_prn_inv = 0.0
        else:
            total_prn = min(current_bal, sched_prn + unsched_prn)
            new_row.balloon_pay = 0.0
            new_row.unsched_prn = unsched_prn
            new_row.unsched_prn_vol = unsched_prn_vol
            new_row.unsched_prn_inv = unsched_prn_inv
        new_row.total_prn = total_prn
        new_row.smm = smm
        new_row.annual_prepay_rate = 1.0 - (1.0 - smm) ** 12.0

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


def apply_cpr_overlay(
    contractual: list[CashflowRow],
    loan: LoanInput,
    cpr_annual: float,
    lockout_months: int = 0,
) -> list[CashflowRow]:
    """Apply a flat constant prepayment rate (CPR) overlay.

    CPR is expressed as a percentage (e.g., 10.0 = 10% CPR).
    SMM = 1 - (1 - CPR/100)^(1/12)

    During lockout (loan age <= lockout_months), no voluntary prepayment occurs.
    """
    annual_rate = min(max(cpr_annual / 100.0, 0.0), 1.0)
    smm = 1.0 - (1.0 - annual_rate) ** (1.0 / 12.0)

    result: list[CashflowRow] = []
    current_bal = contractual[0].beg_bal if contractual else 0.0

    for row in contractual:
        new_row = row.model_copy()

        if row.month == 0:
            new_row.beg_bal = current_bal
            new_row.end_bal = current_bal
            result.append(new_row)
            continue

        new_row.beg_bal = current_bal

        nr = loan.coupon_net / 12.0
        gr = loan.wac_gross / 12.0
        new_row.int_to_inv = current_bal * nr
        new_row.int_to_agy = current_bal * gr

        # Scheduled principal: scale by surviving balance factor
        io_period = loan.io_period if loan.io_period is not None else 0
        totmo = loan.seasoning + row.month
        if totmo <= io_period or current_bal < 0.000001:
            sched_prn = 0.0
            new_row.pmt_to_agy = current_bal * gr if current_bal >= 0.000001 else 0.0
        else:
            sched_factor = row.reg_prn / row.beg_bal if row.beg_bal > 0.000001 else 0.0
            sched_prn = min(current_bal, current_bal * sched_factor)
            new_row.pmt_to_agy = current_bal * gr + sched_prn

        new_row.reg_prn = sched_prn

        prepayable = max(0.0, current_bal - sched_prn)
        # Apply lockout: no voluntary prepayment during lockout period
        age = loan.seasoning + row.month
        if lockout_months > 0 and age <= lockout_months:
            unsched_prn = 0.0
            effective_smm = 0.0
        else:
            unsched_prn = prepayable * smm
            effective_smm = smm

        balloon = loan.balloon
        if balloon is not None:
            rembal = max(0, balloon - loan.seasoning)
            is_balloon = (row.month == rembal)
        else:
            is_balloon = False

        if is_balloon:
            # Balloon payoff is contractual maturity principal, not prepayment
            total_prn = current_bal
            new_row.balloon_pay = current_bal - sched_prn
            new_row.unsched_prn = 0.0
            new_row.unsched_prn_vol = 0.0
            new_row.unsched_prn_inv = 0.0
        else:
            total_prn = min(current_bal, sched_prn + unsched_prn)
            new_row.balloon_pay = 0.0
            new_row.unsched_prn = unsched_prn
            # CPR: all unscheduled is voluntary (no PLD component)
            new_row.unsched_prn_vol = unsched_prn
            new_row.unsched_prn_inv = 0.0
        new_row.total_prn = total_prn
        new_row.smm = effective_smm
        new_row.annual_prepay_rate = annual_rate if effective_smm > 0 else 0.0

        new_row.rem_prn = current_bal - sched_prn
        new_row.end_bal = max(0.0, current_bal - total_prn)
        new_row.net_prn = total_prn
        new_row.net_flow = total_prn + new_row.int_to_inv

        current_bal = new_row.end_bal
        result.append(new_row)

        if current_bal < 0.000001:
            break

    return result


def apply_prepay_overlay(
    contractual: list[CashflowRow],
    loan: LoanInput,
    prepay: PrepaymentAssumption,
) -> list[CashflowRow]:
    """Dispatch to appropriate prepayment overlay based on type."""
    if prepay.prepay_type.value == "CPJ":
        cpj = CPJInput(
            enabled=True,
            cpj_speed=prepay.speed,
            lockout_months=prepay.lockout_months,
            pld_curve=prepay.pld_curve,
            pld_multiplier=prepay.pld_multiplier,
        )
        if cpj.lockout_months == 0 and (loan.lockout_months or 0) > 0:
            cpj.lockout_months = loan.lockout_months
        return apply_cpj_overlay(contractual, loan, cpj)
    elif prepay.prepay_type.value == "CPR":
        lockout = prepay.lockout_months
        if lockout == 0 and (loan.lockout_months or 0) > 0:
            lockout = loan.lockout_months
        return apply_cpr_overlay(contractual, loan, prepay.speed, lockout_months=lockout)
    return contractual


def aggregate_cashflows(all_cfs: list[list[CashflowRow]]) -> list[CashflowRow]:
    """Aggregate multiple loans' cashflows by month.

    Sums financial fields across loans. Uses the first loan's date fields
    as the reference. Handles different-length streams (different balloon months).
    """
    if not all_cfs:
        return []
    if len(all_cfs) == 1:
        return all_cfs[0]

    # Collect all months across all loans
    month_set: set[int] = set()
    for cfs in all_cfs:
        for row in cfs:
            month_set.add(row.month)

    # Index each loan's cashflows by month for fast lookup
    indexed: list[dict[int, CashflowRow]] = []
    for cfs in all_cfs:
        indexed.append({row.month: row for row in cfs})

    result: list[CashflowRow] = []
    for month in sorted(month_set):
        # Use first loan that has this month for date fields
        ref = None
        for idx_map in indexed:
            if month in idx_map:
                ref = idx_map[month]
                break
        if ref is None:
            continue

        agg = CashflowRow(
            month=month,
            date_serial=ref.date_serial,
            cf_date_serial=ref.cf_date_serial,
            year_frac=ref.year_frac,
            beg_bal=0.0,
            pmt_to_agy=0.0,
            int_to_inv=0.0,
            int_to_agy=0.0,
            reg_prn=0.0,
            rem_prn=0.0,
            balloon_pay=0.0,
            end_bal=0.0,
            net_prn=0.0,
            net_flow=0.0,
            unsched_prn=0.0,
            total_prn=0.0,
            smm=0.0,
            annual_prepay_rate=0.0,
        )

        for idx_map in indexed:
            if month in idx_map:
                row = idx_map[month]
                agg.beg_bal += row.beg_bal
                agg.pmt_to_agy += row.pmt_to_agy
                agg.int_to_inv += row.int_to_inv
                agg.int_to_agy += row.int_to_agy
                agg.reg_prn += row.reg_prn
                agg.rem_prn += row.rem_prn
                agg.balloon_pay += row.balloon_pay
                agg.end_bal += row.end_bal
                agg.net_prn += row.net_prn
                agg.net_flow += row.net_flow
                agg.unsched_prn += row.unsched_prn
                agg.unsched_prn_vol += row.unsched_prn_vol
                agg.unsched_prn_inv += row.unsched_prn_inv
                agg.total_prn += row.total_prn

        # Derive aggregate SMM from aggregate balances
        prepayable = agg.beg_bal - agg.reg_prn
        if prepayable > 0.000001:
            agg.smm = agg.unsched_prn / prepayable
        else:
            agg.smm = 0.0
        agg.annual_prepay_rate = 1.0 - (1.0 - agg.smm) ** 12.0

        result.append(agg)

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
