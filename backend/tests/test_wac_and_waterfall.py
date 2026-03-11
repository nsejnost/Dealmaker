"""
Tests for WAC coupon computation and waterfall engine.

Tests:
1. WAC coupon equals computed pool WAC each month
2. SEQ sequential principal allocation
3. PT pro-rata allocation
4. IO excess interest
5. FIX coupon constant
6. Reconciliation checks
7. Dual-mode tests
"""

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.models.loan import (
    BondClass,
    BondClassType,
    CouponType,
    CPJInput,
    DealStructure,
    LoanInput,
)
from app.engines.cashflow_engine import (
    generate_contractual_cashflows,
    apply_cpj_overlay,
    DEFAULT_PLD_CURVE,
)
from app.engines.waterfall_engine import run_waterfall, compute_pool_wac


LOAN = LoanInput(
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
)

SETTLE = date(2026, 3, 3)


def make_seq_structure():
    """Two SEQ classes splitting the collateral."""
    return DealStructure(
        classes=[
            BondClass(
                class_id="A",
                class_type=BondClassType.SEQ,
                original_balance=600_000.0,
                current_balance=600_000.0,
                coupon_type=CouponType.FIX,
                coupon_fix=0.04,
                priority_rank=1,
            ),
            BondClass(
                class_id="B",
                class_type=BondClassType.SEQ,
                original_balance=400_000.0,
                current_balance=400_000.0,
                coupon_type=CouponType.FIX,
                coupon_fix=0.045,
                priority_rank=2,
            ),
        ],
        fee_rate=0.0,
    )


def make_wac_structure():
    """A WAC coupon class."""
    return DealStructure(
        classes=[
            BondClass(
                class_id="WAC-A",
                class_type=BondClassType.SEQ,
                original_balance=1_000_000.0,
                current_balance=1_000_000.0,
                coupon_type=CouponType.WAC,
                coupon_fix=0.0,
                priority_rank=1,
            ),
        ],
        fee_rate=0.0,
    )


def make_io_structure():
    """SEQ + IO class."""
    return DealStructure(
        classes=[
            BondClass(
                class_id="A",
                class_type=BondClassType.SEQ,
                original_balance=800_000.0,
                current_balance=800_000.0,
                coupon_type=CouponType.FIX,
                coupon_fix=0.03,
                priority_rank=1,
            ),
            BondClass(
                class_id="IO",
                class_type=BondClassType.IO,
                original_balance=0.0,
                current_balance=0.0,
                coupon_type=CouponType.FIX,
                coupon_fix=0.0,
                priority_rank=0,
            ),
        ],
        fee_rate=0.0,
    )


class TestWACCoupon:
    """WAC coupon must equal pool WAC at each month."""

    def test_wac_equals_pool_coupon(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        structure = make_wac_structure()
        result = run_waterfall(cfs, structure, [LOAN])

        # For single loan, pool WAC = coupon_net = 0.05
        wac_cfs = result["WAC-A"]
        for bcf in wac_cfs:
            if bcf.month == 0:
                continue
            assert bcf.coupon_rate == pytest.approx(0.05, abs=1e-8), \
                f"Month {bcf.month}: WAC coupon {bcf.coupon_rate} != 0.05"

    def test_wac_interest_calculation(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        structure = make_wac_structure()
        result = run_waterfall(cfs, structure, [LOAN])

        wac_cfs = result["WAC-A"]
        for bcf in wac_cfs:
            if bcf.month == 0 or bcf.beg_bal < 0.01:
                continue
            expected_int = bcf.beg_bal * 0.05 / 12.0
            assert bcf.interest_due == pytest.approx(expected_int, abs=0.01), \
                f"Month {bcf.month}: WAC int {bcf.interest_due} != {expected_int}"


class TestPoolWACComputation:
    def test_single_loan_wac(self):
        wac = compute_pool_wac([LOAN], [1_000_000.0])
        assert wac == pytest.approx(0.05, abs=1e-10)

    def test_multi_loan_wac(self):
        loan2 = LOAN.model_copy()
        loan2.coupon_net = 0.06
        wac = compute_pool_wac([LOAN, loan2], [500_000.0, 500_000.0])
        assert wac == pytest.approx(0.055, abs=1e-10)

    def test_zero_balance(self):
        wac = compute_pool_wac([LOAN], [0.0])
        assert wac == 0.0


class TestSEQWaterfall:
    """SEQ classes receive principal sequentially."""

    def test_seq_a_first(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        structure = make_seq_structure()
        result = run_waterfall(cfs, structure, [LOAN])

        a_cfs = result["A"]
        b_cfs = result["B"]

        # Class A should receive all principal until it's paid down,
        # EXCEPT at the balloon month where principal may exceed A's balance
        # and overflow to B (which is correct sequential behavior).
        balloon_month = LOAN.balloon - LOAN.seasoning
        for i, (acf, bcf) in enumerate(zip(a_cfs, b_cfs)):
            if acf.month == 0 or acf.month == balloon_month:
                continue
            if acf.beg_bal > 0.01:
                assert bcf.principal_paid == pytest.approx(0.0, abs=0.01), \
                    f"Month {acf.month}: B got prn {bcf.principal_paid} while A still has {acf.beg_bal}"

    def test_seq_balloon_overflow(self):
        """At balloon, principal flows through SEQ: A first, then B."""
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        structure = make_seq_structure()
        result = run_waterfall(cfs, structure, [LOAN])

        a_cfs = result["A"]
        b_cfs = result["B"]
        balloon_month = LOAN.balloon - LOAN.seasoning

        a_balloon = next(cf for cf in a_cfs if cf.month == balloon_month)
        b_balloon = next(cf for cf in b_cfs if cf.month == balloon_month)

        # A should receive up to its beginning balance
        assert a_balloon.principal_paid == pytest.approx(a_balloon.beg_bal, abs=0.01)
        # B should receive the rest
        assert b_balloon.principal_paid == pytest.approx(b_balloon.beg_bal, abs=0.01)
        # Both should end at 0
        assert a_balloon.end_bal == pytest.approx(0.0, abs=0.01)
        assert b_balloon.end_bal == pytest.approx(0.0, abs=0.01)

    def test_total_principal_equals_collateral(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        structure = make_seq_structure()
        result = run_waterfall(cfs, structure, [LOAN])

        total_bond_prn = sum(
            sum(bcf.principal_paid for bcf in result[cls.class_id])
            for cls in structure.classes
            if cls.class_type != BondClassType.IO
        )
        total_collat_prn = sum(cf.net_prn for cf in cfs)

        assert total_bond_prn == pytest.approx(total_collat_prn, abs=1.0)


class TestFIXCoupon:
    """FIX coupon must be constant."""

    def test_fix_coupon_constant(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        structure = make_seq_structure()
        result = run_waterfall(cfs, structure, [LOAN])

        for bcf in result["A"]:
            assert bcf.coupon_rate == pytest.approx(0.04, abs=1e-10)
        for bcf in result["B"]:
            assert bcf.coupon_rate == pytest.approx(0.045, abs=1e-10)


class TestIOClass:
    """IO class receives excess interest."""

    def test_io_receives_excess(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        structure = make_io_structure()
        result = run_waterfall(cfs, structure, [LOAN])

        io_cfs = result["IO"]
        a_cfs = result["A"]

        for i in range(len(io_cfs)):
            if io_cfs[i].month == 0:
                continue
            # Collateral interest - A class interest = IO interest
            collat_int = cfs[i].int_to_inv
            a_int = a_cfs[i].interest_paid
            expected_io = collat_int - a_int
            assert io_cfs[i].interest_paid == pytest.approx(expected_io, abs=0.01), \
                f"Month {io_cfs[i].month}: IO {io_cfs[i].interest_paid} != {expected_io}"

    def test_io_no_principal(self):
        """IO bonds should never receive actual principal but track notional balance."""
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        structure = make_io_structure()
        result = run_waterfall(cfs, structure, [LOAN])

        for bcf in result["IO"]:
            assert bcf.principal_paid == 0.0
        # IO notional should track collateral — starts at IO original_balance, declines to 0
        io_cfs = result["IO"]
        assert io_cfs[0].beg_bal > 0, "IO notional should start > 0"
        assert io_cfs[-1].end_bal == 0.0, "IO notional should end at 0"


class TestReconciliation:
    """Waterfall reconciliation checks."""

    def test_interest_non_negative(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        structure = make_seq_structure()
        result = run_waterfall(cfs, structure, [LOAN])

        for cls_id, cls_cfs in result.items():
            for bcf in cls_cfs:
                assert bcf.interest_paid >= -0.001, \
                    f"{cls_id} month {bcf.month}: negative interest {bcf.interest_paid}"

    def test_principal_non_negative(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        structure = make_seq_structure()
        result = run_waterfall(cfs, structure, [LOAN])

        for cls_id, cls_cfs in result.items():
            for bcf in cls_cfs:
                assert bcf.principal_paid >= -0.001

    def test_end_balance_non_negative(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        structure = make_seq_structure()
        result = run_waterfall(cfs, structure, [LOAN])

        for cls_id, cls_cfs in result.items():
            for bcf in cls_cfs:
                assert bcf.end_bal >= -0.001


class TestDualValuation:
    """Dual valuation mode tests."""

    def test_contractual_mode_matches_excel(self):
        """Contractual mode (no CPJ) should match Excel exactly."""
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        # Already tested in parity tests, but confirm here
        assert len(cfs) == 121
        assert cfs[0].beg_bal == pytest.approx(1_000_000.0, abs=0.01)

    def test_loan_pricing_mode_different(self):
        """Loan pricing mode with overrides should produce different cashflows."""
        from app.engines.cashflow_engine import generate_loan_pricing_cashflows

        # Contractual: 480 amort, 120 balloon
        contractual = generate_contractual_cashflows(LOAN, SETTLE)

        # Loan pricing: 480 amort, 120 balloon, but with IO override
        profile = {"amort_wam_override": 480, "balloon_override": 120, "io_period_override": 24}
        loan_pricing = generate_loan_pricing_cashflows(LOAN, profile, SETTLE)

        # With IO period, first 24 months should have 0 regular principal
        for cf in loan_pricing[1:25]:
            assert cf.reg_prn == pytest.approx(0.0, abs=0.01)

        # Contractual has principal from month 1
        assert contractual[1].reg_prn > 0

    def test_bond_mode_uses_cpj(self):
        """Bond valuation mode uses contractual + CPJ."""
        contractual = generate_contractual_cashflows(LOAN, SETTLE)
        cpj = CPJInput(
            enabled=True,
            cpj_speed=15.0,
            lockout_months=24,
            pld_curve=DEFAULT_PLD_CURVE,
        )
        bond_cfs = apply_cpj_overlay(contractual, LOAN, cpj)

        # Should have prepayments (shorter life)
        assert len(bond_cfs) <= len(contractual)

        # Total principal should still equal face
        total_prn = sum(cf.net_prn for cf in bond_cfs)
        assert total_prn == pytest.approx(1_000_000.0, abs=1.0)


class TestPTWaterfall:
    """PT (pass-through) allocation tests."""

    def test_pt_pro_rata(self):
        structure = DealStructure(
            classes=[
                BondClass(
                    class_id="PT1",
                    class_type=BondClassType.PT,
                    original_balance=500_000.0,
                    current_balance=500_000.0,
                    coupon_type=CouponType.FIX,
                    coupon_fix=0.04,
                    priority_rank=0,
                ),
                BondClass(
                    class_id="PT2",
                    class_type=BondClassType.PT,
                    original_balance=500_000.0,
                    current_balance=500_000.0,
                    coupon_type=CouponType.FIX,
                    coupon_fix=0.04,
                    priority_rank=0,
                ),
            ],
            fee_rate=0.0,
        )

        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        result = run_waterfall(cfs, structure, [LOAN])

        # Both PT classes should get equal principal (50/50 split)
        for i in range(len(result["PT1"])):
            if result["PT1"][i].month == 0:
                continue
            p1 = result["PT1"][i].principal_paid
            p2 = result["PT2"][i].principal_paid
            if p1 + p2 > 0.01:
                assert p1 == pytest.approx(p2, rel=0.01), \
                    f"Month {result['PT1'][i].month}: PT1 prn {p1} != PT2 prn {p2}"


class TestMultiIOInterest:
    """Multiple IO classes must split interest pro-rata, not duplicate."""

    def _make_multi_io_structure(self):
        return DealStructure(
            classes=[
                BondClass(
                    class_id="A",
                    class_type=BondClassType.SEQ,
                    original_balance=800_000.0,
                    current_balance=800_000.0,
                    coupon_type=CouponType.FIX,
                    coupon_fix=0.03,
                    priority_rank=1,
                ),
                BondClass(
                    class_id="IO1",
                    class_type=BondClassType.IO,
                    original_balance=500_000.0,
                    current_balance=0.0,
                    coupon_type=CouponType.FIX,
                    coupon_fix=0.0,
                    priority_rank=0,
                ),
                BondClass(
                    class_id="IO2",
                    class_type=BondClassType.IO,
                    original_balance=500_000.0,
                    current_balance=0.0,
                    coupon_type=CouponType.FIX,
                    coupon_fix=0.0,
                    priority_rank=0,
                ),
            ],
            fee_rate=0.0,
        )

    def test_multi_io_interest_not_duplicated(self):
        """Total IO interest must not exceed available interest."""
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        structure = self._make_multi_io_structure()
        result = run_waterfall(cfs, structure, [LOAN])

        for i in range(len(result["IO1"])):
            month = result["IO1"][i].month
            if month == 0:
                continue
            io1_int = result["IO1"][i].interest_paid
            io2_int = result["IO2"][i].interest_paid
            a_int = result["A"][i].interest_paid
            collat_int = cfs[i].int_to_inv

            # Total bond interest must not exceed collateral interest
            total_bond_int = io1_int + io2_int + a_int
            assert total_bond_int <= collat_int + 0.01, \
                f"Month {month}: total bond interest {total_bond_int} > collateral {collat_int}"

    def test_multi_io_equal_notional_split(self):
        """Two IOs with equal notional get equal shares."""
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        structure = self._make_multi_io_structure()
        result = run_waterfall(cfs, structure, [LOAN])

        for i in range(len(result["IO1"])):
            if result["IO1"][i].month == 0:
                continue
            io1 = result["IO1"][i].interest_paid
            io2 = result["IO2"][i].interest_paid
            if io1 + io2 > 0.01:
                assert io1 == pytest.approx(io2, rel=0.01), \
                    f"Month {result['IO1'][i].month}: IO1={io1} != IO2={io2}"

    def test_multi_io_unequal_notional_split(self):
        """Two IOs with 3:1 notional get 3:1 interest split."""
        structure = DealStructure(
            classes=[
                BondClass(
                    class_id="A",
                    class_type=BondClassType.SEQ,
                    original_balance=800_000.0,
                    current_balance=800_000.0,
                    coupon_type=CouponType.FIX,
                    coupon_fix=0.03,
                    priority_rank=1,
                ),
                BondClass(
                    class_id="IO1",
                    class_type=BondClassType.IO,
                    original_balance=750_000.0,
                    current_balance=0.0,
                    coupon_type=CouponType.FIX,
                    coupon_fix=0.0,
                    priority_rank=0,
                ),
                BondClass(
                    class_id="IO2",
                    class_type=BondClassType.IO,
                    original_balance=250_000.0,
                    current_balance=0.0,
                    coupon_type=CouponType.FIX,
                    coupon_fix=0.0,
                    priority_rank=0,
                ),
            ],
            fee_rate=0.0,
        )

        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        result = run_waterfall(cfs, structure, [LOAN])

        for i in range(len(result["IO1"])):
            if result["IO1"][i].month == 0:
                continue
            io1 = result["IO1"][i].interest_paid
            io2 = result["IO2"][i].interest_paid
            if io1 + io2 > 0.01:
                # 3:1 ratio
                assert io1 == pytest.approx(io2 * 3.0, rel=0.01), \
                    f"Month {result['IO1'][i].month}: IO1={io1} should be 3x IO2={io2}"


class TestMultiIOPenalty:
    """Penalty income must not duplicate across multiple IOs."""

    def test_penalty_not_duplicated(self):
        """Total penalty allocated must not exceed penalty generated."""
        from app.engines.cashflow_engine import apply_cpj_overlay

        loan = LOAN.model_copy()
        loan.prepayment_penalty = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
        loan.lockout_months = 0

        cfs = generate_contractual_cashflows(loan, SETTLE)
        cpj = CPJInput(
            enabled=True,
            cpj_speed=15.0,
            lockout_months=0,
            pld_curve=DEFAULT_PLD_CURVE,
        )
        bond_cfs = apply_cpj_overlay(cfs, loan, cpj)

        structure = DealStructure(
            classes=[
                BondClass(
                    class_id="A",
                    class_type=BondClassType.SEQ,
                    original_balance=800_000.0,
                    current_balance=800_000.0,
                    coupon_type=CouponType.FIX,
                    coupon_fix=0.03,
                    priority_rank=1,
                ),
                BondClass(
                    class_id="IO1",
                    class_type=BondClassType.IO,
                    original_balance=500_000.0,
                    current_balance=0.0,
                    priority_rank=0,
                ),
                BondClass(
                    class_id="IO2",
                    class_type=BondClassType.IO,
                    original_balance=500_000.0,
                    current_balance=0.0,
                    priority_rank=0,
                ),
            ],
            fee_rate=0.0,
        )
        result = run_waterfall(bond_cfs, structure, [loan], per_loan_bond_cfs=[bond_cfs])

        for i in range(len(result["IO1"])):
            io1_pen = result["IO1"][i].penalty_income
            io2_pen = result["IO2"][i].penalty_income
            # Each IO should get half, not the full amount
            if io1_pen > 0.01:
                assert io1_pen == pytest.approx(io2_pen, rel=0.01), \
                    f"Month {result['IO1'][i].month}: penalty IO1={io1_pen} != IO2={io2_pen}"


class TestPenaltyOverrideNormalization:
    """Penalty overrides must be normalized for cash conservation."""

    def test_overrides_summing_over_100(self):
        """Overrides summing to >100% should be normalized."""
        from app.engines.cashflow_engine import apply_cpj_overlay

        loan = LOAN.model_copy()
        loan.prepayment_penalty = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]
        loan.lockout_months = 0

        cfs = generate_contractual_cashflows(loan, SETTLE)
        cpj = CPJInput(
            enabled=True,
            cpj_speed=15.0,
            lockout_months=0,
            pld_curve=DEFAULT_PLD_CURVE,
        )
        bond_cfs = apply_cpj_overlay(cfs, loan, cpj)

        structure = DealStructure(
            classes=[
                BondClass(
                    class_id="A",
                    class_type=BondClassType.SEQ,
                    original_balance=800_000.0,
                    current_balance=800_000.0,
                    coupon_type=CouponType.FIX,
                    coupon_fix=0.03,
                    priority_rank=1,
                    penalty_pct=80.0,  # 80%
                ),
                BondClass(
                    class_id="B",
                    class_type=BondClassType.SEQ,
                    original_balance=200_000.0,
                    current_balance=200_000.0,
                    coupon_type=CouponType.FIX,
                    coupon_fix=0.04,
                    priority_rank=2,
                    penalty_pct=80.0,  # 80% — total=160%, should normalize
                ),
            ],
            fee_rate=0.0,
        )
        result = run_waterfall(bond_cfs, structure, [loan], per_loan_bond_cfs=[bond_cfs])

        # Verify total allocated penalty never exceeds generated penalty
        for i in range(len(result["A"])):
            a_pen = result["A"][i].penalty_income
            b_pen = result["B"][i].penalty_income
            if a_pen + b_pen > 0.01:
                # Should be 50/50 after normalization (both had 80%)
                assert a_pen == pytest.approx(b_pen, rel=0.01), \
                    f"Month {result['A'][i].month}: normalized split should be equal"


class TestPVIncludesPenalty:
    """Bond PV should include penalty income in cashflows."""

    def test_pv_with_penalty_greater(self):
        """PV with penalty income should be >= PV without."""
        from app.engines.waterfall_engine import _bond_pv
        from app.models.loan import BondCashflowRow

        # Create synthetic bond cashflows with penalty
        bond_cfs = [
            BondCashflowRow(month=0, beg_bal=100.0, end_bal=100.0),
            BondCashflowRow(
                month=1,
                beg_bal=100.0,
                interest_paid=0.5,
                principal_paid=10.0,
                penalty_income=2.0,
                end_bal=90.0,
            ),
        ]
        bond_cfs_no_pen = [
            BondCashflowRow(month=0, beg_bal=100.0, end_bal=100.0),
            BondCashflowRow(
                month=1,
                beg_bal=100.0,
                interest_paid=0.5,
                principal_paid=10.0,
                penalty_income=0.0,
                end_bal=90.0,
            ),
        ]

        # Use real collateral cashflows for year-fraction lookup
        cfs = generate_contractual_cashflows(LOAN, SETTLE)

        pv_with = _bond_pv(bond_cfs, cfs[0].date_serial, cfs, 5.0)
        pv_without = _bond_pv(bond_cfs_no_pen, cfs[0].date_serial, cfs, 5.0)

        assert pv_with > pv_without, \
            f"PV with penalty ({pv_with}) should exceed PV without ({pv_without})"


class TestScenarioGrid:
    """Scenario grid should not crash and return valid results."""

    def test_scenario_grid_runs(self):
        """run_scenario_grid should execute without errors."""
        from app.engines.deal_runner import run_scenario_grid
        from app.models.loan import (
            Deal,
            PricingInput,
            DealStructure,
            PricingType,
            PrepaymentAssumption,
            PrepaymentType,
        )

        deal = Deal(
            loans=[LOAN],
            pricing=PricingInput(
                settle_date=SETTLE,
                curve_date=SETTLE,
                pricing_type=PricingType.PRICE,
                pricing_input=100.0,
            ),
            structure=DealStructure(
                classes=[
                    BondClass(
                        class_id="A",
                        class_type=BondClassType.SEQ,
                        original_balance=1_000_000.0,
                        current_balance=1_000_000.0,
                        coupon_type=CouponType.FIX,
                        coupon_fix=0.04,
                        priority_rank=1,
                    ),
                ],
                fee_rate=0.0,
                prepay=PrepaymentAssumption(prepay_type=PrepaymentType.NONE),
            ),
            cpj=CPJInput(
                enabled=False,
                cpj_speed=0,
                lockout_months=0,
                pld_curve=DEFAULT_PLD_CURVE,
            ),
        )

        grid = run_scenario_grid(deal, rate_shocks_bps=[0, 50], cpj_multipliers=[1.0])
        assert 0 in grid
        assert 50 in grid
        assert 1.0 in grid[0]
        assert "A" in grid[0][1.0]
        assert "price" in grid[0][1.0]["A"]


class TestAccrued30360:
    """Accrued interest should use 30/360 convention."""

    def test_accrued_uses_30_360(self):
        """Verify accrued uses 30/360, not actual/360."""
        from app.engines.analytics_engine import compute_accrued, _yf_30_360
        from app.engines.cashflow_engine import _date_to_serial
        from datetime import date

        # Use dates where 30/360 differs from actual: e.g. Feb
        # Feb has 28 actual days but 30/360 treats it as 30
        dated = date(2026, 2, 1)
        settle = date(2026, 3, 1)  # 28 actual days, but 30 in 30/360

        dated_serial = _date_to_serial(dated)
        settle_serial = _date_to_serial(settle)

        accrued = compute_accrued(settle_serial, dated_serial, 0.06, 1_000_000.0)

        # 30/360: 30 days / 360 * 0.06 * 1M = 5000.0
        expected_30_360 = (30 / 360.0) * 0.06 * 1_000_000.0
        # actual/360: 28 days / 360 * 0.06 * 1M = 4666.67
        wrong_actual = (28 / 360.0) * 0.06 * 1_000_000.0

        assert accrued == pytest.approx(expected_30_360, abs=1.0), \
            f"Accrued {accrued} should match 30/360 ({expected_30_360}), not actual ({wrong_actual})"
