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
4. PT group gets pt_share of principal (pro-rata within group)
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


def run_waterfall(
    collateral_cashflows: list[CashflowRow],
    structure: DealStructure,
    loans: list[LoanInput],
) -> dict[str, list[BondCashflowRow]]:
    """Run the full waterfall producing bond-level cashflows.

    Returns dict mapping class_id -> list of BondCashflowRow.
    """
    classes = structure.classes
    if not classes:
        return {}

    pt_share = structure.pt_share
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

    # Track collateral balances for WAC computation
    # For single-loan MVP, loan balance tracks from cashflows
    collat_bal = collateral_cashflows[0].beg_bal if collateral_cashflows else 0.0

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
        # For single loan: WAC = coupon_net
        pool_wac = loans[0].coupon_net if loans else 0.0
        # For multi-loan: would compute from remaining balances

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

        # IO classes get remaining interest
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

        # PT group first
        if pt_classes and pt_share > 0:
            pt_total_bal = sum(bond_bals[c.class_id] for c in pt_classes)
            pt_prin = min(pt_share * principal_rem, pt_total_bal)

            for cls in pt_classes:
                cls_bal = bond_bals[cls.class_id]
                if pt_total_bal > 0:
                    share = cls_bal / pt_total_bal
                else:
                    share = 0.0
                cls_prin = pt_prin * share
                cls_prin = min(cls_prin, cls_bal)

                # Update the last entry
                entry = result[cls.class_id][-1]
                entry.principal_paid = cls_prin
                entry.end_bal = cls_bal - cls_prin
                bond_bals[cls.class_id] = entry.end_bal

            principal_rem -= pt_prin

        # SEQ classes
        for cls in seq_classes:
            cls_bal = bond_bals[cls.class_id]
            cls_prin = min(cls_bal, principal_rem)
            principal_rem = max(0.0, principal_rem - cls_prin)

            entry = result[cls.class_id][-1]
            entry.principal_paid = cls_prin
            entry.end_bal = cls_bal - cls_prin
            bond_bals[cls.class_id] = entry.end_bal

        # Update collateral balance for next period
        collat_bal = cf.end_bal

    return result


def compute_bond_analytics(
    bond_cfs: list[BondCashflowRow],
    settle_serial: int,
    collateral_cfs: list[CashflowRow],
    original_balance: float,
    annual_yield: float,
) -> dict:
    """Compute PV, price, WAL for a single bond class."""
    # WAL using 30/360 day count from CF dates (matching Excel convention)
    from app.engines.analytics_engine import _yf_30_360

    total_prn = 0.0
    weighted_prn = 0.0
    for bcf in bond_cfs:
        if bcf.month == 0:
            continue
        total_prn += bcf.principal_paid
        cf_match = next((c for c in collateral_cfs if c.month == bcf.month), None)
        if cf_match:
            yf = _yf_30_360(settle_serial, cf_match.cf_date_serial)
        else:
            yf = bcf.month / 12.0
        weighted_prn += bcf.principal_paid * yf

    wal = weighted_prn / total_prn if total_prn > 0 else 0.0

    # PV
    y = annual_yield / 100.0
    pv = 0.0
    for bcf in bond_cfs:
        if bcf.month == 0:
            continue
        cf_match = next((c for c in collateral_cfs if c.month == bcf.month), None)
        if cf_match:
            cf_serial = cf_match.cf_date_serial
            yf = (cf_serial - settle_serial) / 365.25
        else:
            yf = bcf.month / 12.0

        total_cf = bcf.interest_paid + bcf.principal_paid
        if yf > 0:
            disc = (1.0 + y / 2.0) ** (2.0 * yf)
            pv += total_cf / disc
        else:
            pv += total_cf

    price = (pv / original_balance * 100.0) if original_balance > 0 else 0.0

    return {
        "wal": wal,
        "pv": pv,
        "price": price,
    }
