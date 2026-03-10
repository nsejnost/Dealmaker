"""
Waterfall engine: SEQ/PT/IO bond structure and cashflow allocation.

Supports:
- SEQ (sequential principal)
- PT (pass-through/pro-rata)
- IO (interest-only)
- FIX and WAC coupon types

Waterfall order:
1. Pay fees
2. Pay bond interest by priority rank (SEQ/PT)
3. IO gets remaining interest
4. PT group gets pro-rata share of principal by balance
5. SEQ gets remaining principal sequentially by rank
"""

from __future__ import annotations

from typing import Optional

from app.models.loan import (
    BondCashflowRow,
    BondClass,
    BondClassType,
    CashflowRow,
    CouponType,
    DealStructure,
    LoanInput,
    TreasuryCurve,
)


def compute_pool_wac(
    loans: list[LoanInput],
    balances: list[float],
) -> float:
    """Compute weighted average coupon of remaining collateral.

    PoolWAC = sum(balance_i * coupon_i) / sum(balance_i)
    """
    total_bal = sum(balances)
    if total_bal < 1e-10:
        return 0.0
    weighted = sum(b * l.coupon_net for b, l in zip(balances, loans))
    return weighted / total_bal


def _get_penalty_rate(loan: LoanInput, month: int) -> float:
    """Get the prepayment penalty rate for a given month.

    The penalty schedule is an annual step-down, e.g. [10,9,8,7,6,5,4,3,2,1]
    means 10% in year 1 after lockout, 9% in year 2 after lockout, etc.
    The schedule starts the month after the lockout period expires.
    """
    if not loan.prepayment_penalty:
        return 0.0
    lockout = loan.lockout_months or 0
    age = loan.seasoning + month
    if age <= lockout:
        return 0.0
    months_past_lockout = age - lockout
    year_idx = (months_past_lockout - 1) // 12
    if year_idx < len(loan.prepayment_penalty):
        return loan.prepayment_penalty[year_idx]
    return 0.0


def run_waterfall(
    collateral_cashflows: list[CashflowRow],
    structure: DealStructure,
    loans: list[LoanInput],
    per_loan_bond_cfs: list[list[CashflowRow]] | None = None,
) -> dict[str, list[BondCashflowRow]]:
    """Run the full waterfall producing bond-level cashflows.

    Returns dict mapping class_id -> list of BondCashflowRow.
    """
    classes = structure.classes
    if not classes:
        return {}

    fee_rate = structure.fee_rate

    # Initialize bond balances
    bond_bals: dict[str, float] = {}
    for cls in classes:
        bond_bals[cls.class_id] = cls.original_balance

    # Separate class types
    seq_classes = sorted(
        [c for c in classes if c.class_type == BondClassType.SEQ],
        key=lambda c: c.priority_rank,
    )
    pt_classes = [c for c in classes if c.class_type == BondClassType.PT]
    io_classes = [c for c in classes if c.class_type == BondClassType.IO]

    result: dict[str, list[BondCashflowRow]] = {c.class_id: [] for c in classes}

    # Track per-loan balances for WAC computation and penalties
    loan_balances = [l.original_face for l in loans]
    collat_bal = collateral_cashflows[0].beg_bal if collateral_cashflows else 0.0

    # Index per-loan cashflows by month for penalty computation
    per_loan_by_month: list[dict[int, CashflowRow]] = []
    if per_loan_bond_cfs:
        for cfs in per_loan_bond_cfs:
            per_loan_by_month.append({row.month: row for row in cfs})

    for cf in collateral_cashflows:
        month = cf.month

        # Collateral interest and principal for this period
        collat_interest = cf.int_to_inv  # investor interest (net coupon)
        collat_principal = cf.net_prn

        # Fees
        fees = 0.0
        if fee_rate > 0:
            fees = collat_bal * fee_rate / 12.0

        net_interest = max(0.0, collat_interest - fees)

        # Compute pool WAC for this month (for WAC coupon classes)
        pool_wac = compute_pool_wac(loans, loan_balances)

        # Interest waterfall
        interest_rem = net_interest

        for cls in seq_classes + pt_classes:
            beg_bal = bond_bals[cls.class_id]
            if cls.coupon_type == CouponType.WAC:
                coupon_rate = pool_wac
            else:
                coupon_rate = cls.coupon_fix

            int_due = beg_bal * coupon_rate / 12.0
            int_paid = min(int_due, interest_rem)
            interest_rem = max(0.0, interest_rem - int_paid)

            # Store for later
            result[cls.class_id].append(BondCashflowRow(
                month=month,
                beg_bal=beg_bal,
                interest_due=int_due,
                interest_paid=int_paid,
                principal_paid=0.0,  # filled below
                end_bal=beg_bal,  # updated below
                coupon_rate=coupon_rate,
            ))

        # IO classes get remaining interest; track notional balance
        for cls in io_classes:
            result[cls.class_id].append(BondCashflowRow(
                month=month,
                beg_bal=0.0,
                interest_due=interest_rem,
                interest_paid=interest_rem,
                principal_paid=0.0,
                end_bal=0.0,
                coupon_rate=0.0,
            ))
        interest_rem = 0.0

        # Principal waterfall
        principal_rem = collat_principal

        # Compute collateral principal breakdown ratios for this period
        collat_sched = cf.reg_prn + cf.balloon_pay
        collat_prepaid = cf.unsched_prn_vol
        collat_default = cf.unsched_prn_inv
        collat_total = collat_sched + collat_prepaid + collat_default
        if collat_total > 0:
            ratio_sched = collat_sched / collat_total
            ratio_prepaid = collat_prepaid / collat_total
            ratio_default = collat_default / collat_total
        else:
            ratio_sched = 1.0
            ratio_prepaid = 0.0
            ratio_default = 0.0

        # PT bonds get pro-rata share by balance, SEQ gets remainder sequentially
        all_prin_classes = pt_classes + seq_classes
        total_prin_bal = sum(bond_bals[c.class_id] for c in all_prin_classes)

        # PT group: pro-rata share of principal based on balance
        if pt_classes and total_prin_bal > 0:
            pt_total_bal = sum(bond_bals[c.class_id] for c in pt_classes)
            pt_prin = min(principal_rem * (pt_total_bal / total_prin_bal), pt_total_bal)

            for cls in pt_classes:
                cls_bal = bond_bals[cls.class_id]
                if pt_total_bal > 0:
                    share = cls_bal / pt_total_bal
                else:
                    share = 0.0
                cls_prin = min(pt_prin * share, cls_bal)

                entry = result[cls.class_id][-1]
                entry.principal_paid = cls_prin
                entry.sched_prn = cls_prin * ratio_sched
                entry.prepaid_prn = cls_prin * ratio_prepaid
                entry.default_prn = cls_prin * ratio_default
                entry.end_bal = cls_bal - cls_prin
                bond_bals[cls.class_id] = entry.end_bal

            principal_rem -= pt_prin

        # SEQ classes: sequential paydown with remaining principal
        for cls in seq_classes:
            cls_bal = bond_bals[cls.class_id]
            cls_prin = min(cls_bal, principal_rem)
            principal_rem = max(0.0, principal_rem - cls_prin)

            entry = result[cls.class_id][-1]
            entry.principal_paid = cls_prin
            entry.sched_prn = cls_prin * ratio_sched
            entry.prepaid_prn = cls_prin * ratio_prepaid
            entry.default_prn = cls_prin * ratio_default
            entry.end_bal = cls_bal - cls_prin
            bond_bals[cls.class_id] = entry.end_bal

        # Prepayment penalty income (sum across loans)
        penalty = 0.0
        if per_loan_by_month and loans:
            for i, loan in enumerate(loans):
                if i < len(per_loan_by_month) and month in per_loan_by_month[i]:
                    loan_cf = per_loan_by_month[i][month]
                    if loan_cf.unsched_prn_vol > 0:
                        rate = _get_penalty_rate(loan, month)
                        penalty += loan_cf.unsched_prn_vol * rate / 100.0
        elif cf.unsched_prn_vol > 0 and loans:
            # Fallback: single-loan or no per-loan data
            penalty_rate = _get_penalty_rate(loans[0], month)
            penalty = cf.unsched_prn_vol * penalty_rate / 100.0

        if penalty > 0:
            all_classes = seq_classes + pt_classes + io_classes
            has_overrides = any(c.penalty_pct is not None for c in all_classes)
            if has_overrides:
                for cls in all_classes:
                    pct = (cls.penalty_pct or 0) / 100.0
                    entry = result[cls.class_id][-1]
                    entry.penalty_income = penalty * pct
            elif io_classes:
                # All penalty income goes to IO class
                for cls in io_classes:
                    entry = result[cls.class_id][-1]
                    entry.penalty_income = penalty
            else:
                # Distribute pro-rata to all bond classes as excess cashflow
                total_bal = sum(bond_bals[c.class_id] for c in seq_classes + pt_classes)
                for cls in seq_classes + pt_classes:
                    entry = result[cls.class_id][-1]
                    if total_bal > 0:
                        share = bond_bals[cls.class_id] / total_bal
                    else:
                        share = 1.0 / max(1, len(seq_classes) + len(pt_classes))
                    entry.penalty_income = penalty * share

        # Update collateral balance for next period
        collat_bal = cf.end_bal

        # Update per-loan balances for WAC computation
        if per_loan_by_month:
            for i in range(len(loans)):
                if i < len(per_loan_by_month) and month in per_loan_by_month[i]:
                    loan_balances[i] = per_loan_by_month[i][month].end_bal
        elif loans:
            loan_balances = [cf.end_bal]

    return result


def _index_collateral_by_month(
    collateral_cfs: list[CashflowRow],
) -> dict[int, CashflowRow]:
    """Index collateral cashflows by month for O(1) lookup."""
    return {c.month: c for c in collateral_cfs}


def _bond_pv(
    bond_cfs: list[BondCashflowRow],
    settle_serial: int,
    collateral_cfs: list[CashflowRow],
    annual_yield: float,
    _collat_index: dict[int, CashflowRow] | None = None,
) -> float:
    """Compute PV of bond cashflows at given yield (BEY convention)."""
    y = annual_yield / 100.0
    pv = 0.0
    idx = _collat_index or _index_collateral_by_month(collateral_cfs)
    for bcf in bond_cfs:
        if bcf.month == 0:
            continue
        cf_match = idx.get(bcf.month)
        if cf_match:
            yf = (cf_match.cf_date_serial - settle_serial) / 365.25
        else:
            yf = bcf.month / 12.0
        total_cf = bcf.interest_paid + bcf.principal_paid
        if yf > 0:
            base = 1.0 + y / 2.0
            if base <= 0:
                pv += total_cf * 1e6
            else:
                disc = base ** (2.0 * yf)
                pv += total_cf / disc
        else:
            pv += total_cf
    return pv


def _bond_price_from_yield(
    bond_cfs: list[BondCashflowRow],
    settle_serial: int,
    collateral_cfs: list[CashflowRow],
    original_balance: float,
    annual_yield: float,
    _collat_index: dict[int, CashflowRow] | None = None,
) -> float:
    idx = _collat_index or _index_collateral_by_month(collateral_cfs)
    pv = _bond_pv(bond_cfs, settle_serial, collateral_cfs, annual_yield, _collat_index=idx)
    return (pv / original_balance * 100.0) if original_balance > 0 else 0.0


def _bond_yield_from_price(
    bond_cfs: list[BondCashflowRow],
    settle_serial: int,
    collateral_cfs: list[CashflowRow],
    original_balance: float,
    target_price: float,
    tol: float = 1e-10,
    max_iter: int = 200,
    _collat_index: dict[int, CashflowRow] | None = None,
) -> float:
    """Newton-Raphson solver: find yield given price for a bond."""
    idx = _collat_index or _index_collateral_by_month(collateral_cfs)
    target_pv = (target_price / 100.0) * original_balance
    y = 0.05
    for _ in range(max_iter):
        pv = _bond_pv(bond_cfs, settle_serial, collateral_cfs, y * 100.0, _collat_index=idx)
        err = pv - target_pv
        if abs(err) < tol:
            break
        dy = 0.0001
        pv_up = _bond_pv(bond_cfs, settle_serial, collateral_cfs, (y + dy) * 100.0, _collat_index=idx)
        deriv = (pv_up - pv) / dy
        if abs(deriv) < 1e-15:
            break
        y = max(-1.99, min(y - err / deriv, 10.0))
    return y * 100.0


def compute_bond_analytics(
    bond_cfs: list[BondCashflowRow],
    settle_serial: int,
    collateral_cfs: list[CashflowRow],
    original_balance: float,
    pricing_type: str,
    pricing_input: float,
    curve: Optional["TreasuryCurve"] = None,
    is_io: bool = False,
) -> dict:
    """Compute full analytics for a single bond class.

    Returns dict with: price, yield_pct, wal, j_spread, modified_duration,
    convexity, risk_dpdy, tsy_rate_at_wal, accrued.

    For IO bonds (is_io=True), WAL is computed using collateral balance
    reductions as synthetic principal (IO never receives actual principal).
    """
    from app.engines.analytics_engine import _yf_30_360, interpolate_tsy_rate

    # Build index once for O(1) lookups
    collat_idx = _index_collateral_by_month(collateral_cfs)

    # WAL
    total_prn = 0.0
    weighted_prn = 0.0
    prev_collat_bal = original_balance if is_io else 0.0
    for bcf in bond_cfs:
        if bcf.month == 0:
            continue
        cf_match = collat_idx.get(bcf.month)
        if is_io:
            prn = max(0.0, prev_collat_bal - cf_match.end_bal) if cf_match else 0.0
            if cf_match:
                prev_collat_bal = cf_match.end_bal
        else:
            prn = bcf.principal_paid
        total_prn += prn
        if cf_match:
            yf = _yf_30_360(settle_serial, cf_match.cf_date_serial)
        else:
            yf = bcf.month / 12.0
        weighted_prn += prn * yf
    wal = weighted_prn / total_prn if total_prn > 0 else 0.0

    # Pricing
    if pricing_type == "Price":
        price = pricing_input
        yield_pct = _bond_yield_from_price(
            bond_cfs, settle_serial, collateral_cfs, original_balance, price,
            _collat_index=collat_idx,
        )
    elif pricing_type == "JSpread" and curve is not None:
        tsy_at_wal = interpolate_tsy_rate(wal, curve)
        yield_pct = tsy_at_wal + pricing_input / 100.0
        price = _bond_price_from_yield(
            bond_cfs, settle_serial, collateral_cfs, original_balance, yield_pct,
            _collat_index=collat_idx,
        )
    else:  # Yield
        yield_pct = pricing_input
        price = _bond_price_from_yield(
            bond_cfs, settle_serial, collateral_cfs, original_balance, yield_pct,
            _collat_index=collat_idx,
        )

    # Duration & Convexity (1bp bump)
    dy = 0.01  # 1bp in percent
    p0 = price
    p_up = _bond_price_from_yield(
        bond_cfs, settle_serial, collateral_cfs, original_balance, yield_pct + dy,
        _collat_index=collat_idx,
    )
    p_dn = _bond_price_from_yield(
        bond_cfs, settle_serial, collateral_cfs, original_balance, yield_pct - dy,
        _collat_index=collat_idx,
    )
    dy_dec = dy / 100.0  # decimal
    mod_dur = -(p_up - p_dn) / (2.0 * dy_dec * p0) if abs(p0) > 1e-15 else 0.0
    convexity = (p_up + p_dn - 2.0 * p0) / (dy_dec ** 2 * p0) if abs(p0) > 1e-15 else 0.0
    risk_dpdy = -(p_up - p_dn) / (2.0 * dy_dec)

    # J-spread & tsy rate
    tsy_at_wal = 0.0
    j_spread = 0.0
    if curve is not None:
        tsy_at_wal = interpolate_tsy_rate(wal, curve)
        j_spread = (yield_pct - tsy_at_wal) * 100.0  # bps

    return {
        "price": price,
        "yield_pct": yield_pct,
        "wal": wal,
        "j_spread": j_spread,
        "modified_duration": mod_dur,
        "convexity": convexity,
        "risk_dpdy": risk_dpdy,
        "tsy_rate_at_wal": tsy_at_wal,
        "accrued": 0.0,
    }
