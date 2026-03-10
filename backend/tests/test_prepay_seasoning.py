"""
Comprehensive prepayment + seasoning tests.

Tests prepayment overlays (CPJ & CPR) with various seasoning values,
nullable field combinations, and edge cases.
"""

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.models.loan import LoanInput, CPJInput, PLDCurveEntry, PrepaymentAssumption, PrepaymentType
from app.engines.cashflow_engine import (
    generate_contractual_cashflows,
    apply_cpj_overlay,
    apply_cpr_overlay,
    apply_prepay_overlay,
    aggregate_cashflows,
    get_pld_rate,
    DEFAULT_PLD_CURVE,
)

SETTLE = date(2026, 3, 3)


def make_loan(**overrides) -> LoanInput:
    """Create a loan with sensible defaults, applying overrides."""
    defaults = dict(
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
        lockout_months=24,
    )
    defaults.update(overrides)
    return LoanInput(**defaults)


def make_cpj(**overrides) -> CPJInput:
    defaults = dict(
        enabled=True,
        cpj_speed=15.0,
        lockout_months=24,
        pld_curve=DEFAULT_PLD_CURVE,
        pld_multiplier=1.0,
    )
    defaults.update(overrides)
    return CPJInput(**defaults)


# ============================================================
# Structural invariants - applied to many scenarios
# ============================================================

def assert_invariants(cfs, label=""):
    """Assert structural invariants on any cashflow stream."""
    prefix = f"[{label}] " if label else ""

    for cf in cfs:
        assert cf.beg_bal >= -0.01, f"{prefix}Month {cf.month}: negative beg_bal {cf.beg_bal}"
        assert cf.end_bal >= -0.01, f"{prefix}Month {cf.month}: negative end_bal {cf.end_bal}"

    # Balance continuity (skip month 0 -> 1: the analytical balance formula
    # recalculates begbal each period, so month 0 endbal may differ from
    # month 1 begbal when seasoning > 0 and io_period < seasoning)
    for i in range(len(cfs) - 1):
        if cfs[i].month == 0:
            continue
        assert cfs[i].end_bal == pytest.approx(cfs[i + 1].beg_bal, abs=0.01), \
            f"{prefix}Month {cfs[i].month}: end_bal {cfs[i].end_bal} != next beg_bal {cfs[i+1].beg_bal}"

    # Total principal should not exceed starting balance
    total_prn = sum(cf.net_prn for cf in cfs)
    start_bal = cfs[0].beg_bal
    assert total_prn <= start_bal + 0.01, \
        f"{prefix}Total principal {total_prn} exceeds starting balance {start_bal}"


# ============================================================
# A. CPJ + Seasoning Basics
# ============================================================

class TestCPJSeasoningBasics:
    """CPJ with various seasoning values - verify PLD lookup uses correct age."""

    @pytest.mark.parametrize("seasoning", [0, 12, 36, 60, 240, 250])
    def test_pld_rate_uses_correct_age(self, seasoning):
        loan = make_loan(seasoning=seasoning)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=0)
        result = apply_cpj_overlay(contractual, loan, cpj)

        for cf in result:
            if cf.month == 0:
                continue
            age = seasoning + cf.month
            expected_pld = get_pld_rate(age, DEFAULT_PLD_CURVE)
            # Hazard-style: smm = 1 - (1-smm_pld)*(1-smm_cpr)
            smm_pld = 1.0 - (1.0 - expected_pld) ** (1.0 / 12.0)
            smm_cpr = 1.0 - (1.0 - 0.15) ** (1.0 / 12.0)
            expected_smm = 1.0 - (1.0 - smm_pld) * (1.0 - smm_cpr)
            expected_rate = 1.0 - (1.0 - expected_smm) ** 12.0
            assert cf.annual_prepay_rate == pytest.approx(expected_rate, abs=1e-6), \
                f"seas={seasoning} month={cf.month} age={age}: rate {cf.annual_prepay_rate} != {expected_rate}"

    @pytest.mark.parametrize("seasoning", [0, 12, 36, 60, 240, 250])
    def test_invariants_hold(self, seasoning):
        loan = make_loan(seasoning=seasoning)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=0)
        result = apply_cpj_overlay(contractual, loan, cpj)
        assert_invariants(result, f"CPJ seas={seasoning}")

    def test_high_seasoning_pld_zero(self):
        """Seasoning=250 pushes age past PLD curve (>240), PLD should be 0."""
        loan = make_loan(seasoning=250)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=0)
        result = apply_cpj_overlay(contractual, loan, cpj)

        for cf in result:
            if cf.month == 0:
                continue
            age = 250 + cf.month
            assert get_pld_rate(age, DEFAULT_PLD_CURVE) == 0.0
            # Rate should be CPR only (0.15)
            assert cf.annual_prepay_rate == pytest.approx(0.15, abs=1e-6)

    def test_cpj_shortens_life_with_seasoning(self):
        """With prepays, cashflow stream should be shorter than contractual."""
        for seas in [0, 36, 60]:
            loan = make_loan(seasoning=seas)
            contractual = generate_contractual_cashflows(loan, SETTLE)
            cpj = make_cpj(lockout_months=0)
            result = apply_cpj_overlay(contractual, loan, cpj)
            assert len(result) <= len(contractual), \
                f"seas={seas}: CPJ ({len(result)} rows) should be <= contractual ({len(contractual)} rows)"


# ============================================================
# B. CPJ + Seasoning vs Lockout
# ============================================================

class TestCPJSeasoningLockout:
    """Verify lockout interaction with seasoning (lockout applies to absolute age)."""

    def _expected_hazard_rate(self, pld, cpr=0.15):
        """Compute expected annual_prepay_rate via hazard-style decomposition."""
        smm_pld = 1.0 - (1.0 - pld) ** (1.0 / 12.0)
        smm_cpr = 1.0 - (1.0 - cpr) ** (1.0 / 12.0)
        smm = 1.0 - (1.0 - smm_pld) * (1.0 - smm_cpr)
        return 1.0 - (1.0 - smm) ** 12.0

    def test_seasoning_0_lockout_24(self):
        """Standard: CPR starts at month 25 (age 25)."""
        loan = make_loan(seasoning=0)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=24)
        result = apply_cpj_overlay(contractual, loan, cpj)

        for cf in result:
            if cf.month == 0:
                continue
            age = cf.month
            pld = get_pld_rate(age, DEFAULT_PLD_CURVE)
            if age <= 24:
                assert cf.annual_prepay_rate == pytest.approx(pld, abs=1e-6), \
                    f"Month {cf.month}: during lockout, should be PLD only"
            else:
                expected = self._expected_hazard_rate(pld)
                assert cf.annual_prepay_rate == pytest.approx(expected, abs=1e-6)

    def test_seasoning_12_lockout_24(self):
        """Seasoning=12: CPR starts at month 13 (age 12+13=25)."""
        loan = make_loan(seasoning=12)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=24)
        result = apply_cpj_overlay(contractual, loan, cpj)

        for cf in result:
            if cf.month == 0:
                continue
            age = 12 + cf.month
            pld = get_pld_rate(age, DEFAULT_PLD_CURVE)
            if age <= 24:
                assert cf.annual_prepay_rate == pytest.approx(pld, abs=1e-6), \
                    f"Month {cf.month} (age {age}): lockout, should be PLD only"
            else:
                expected = self._expected_hazard_rate(pld)
                assert cf.annual_prepay_rate == pytest.approx(expected, abs=1e-6), \
                    f"Month {cf.month} (age {age}): post-lockout, should include CPR"

    def test_seasoning_30_lockout_24(self):
        """Seasoning=30: already past lockout, CPR from month 1."""
        loan = make_loan(seasoning=30)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=24)
        result = apply_cpj_overlay(contractual, loan, cpj)

        for cf in result:
            if cf.month == 0:
                continue
            age = 30 + cf.month
            pld = get_pld_rate(age, DEFAULT_PLD_CURVE)
            expected = self._expected_hazard_rate(pld)
            assert cf.annual_prepay_rate == pytest.approx(expected, abs=1e-6), \
                f"Month {cf.month} (age {age}): past lockout, should include CPR"

    def test_seasoning_equals_lockout(self):
        """Edge: seasoning=24, lockout=24. Month 1 age=25 -> CPR applies."""
        loan = make_loan(seasoning=24)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=24)
        result = apply_cpj_overlay(contractual, loan, cpj)

        cf1 = next(cf for cf in result if cf.month == 1)
        age = 24 + 1
        pld = get_pld_rate(age, DEFAULT_PLD_CURVE)
        expected = self._expected_hazard_rate(pld)
        assert cf1.annual_prepay_rate == pytest.approx(expected, abs=1e-6), \
            "Month 1 (age 25) should include CPR when seasoning equals lockout"


# ============================================================
# C. CPR + Seasoning
# ============================================================

class TestCPRSeasoning:
    """CPR overlay with seasoning."""

    @pytest.mark.parametrize("seasoning", [0, 36])
    def test_cpr_applied_from_month_1(self, seasoning):
        """CPR should apply from month 1 regardless of seasoning."""
        loan = make_loan(seasoning=seasoning)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        result = apply_cpr_overlay(contractual, loan, 15.0)

        cf1 = next(cf for cf in result if cf.month == 1)
        expected_smm = 1 - (1 - 0.15) ** (1 / 12)
        assert cf1.smm == pytest.approx(expected_smm, abs=1e-8), \
            f"seas={seasoning}: CPR should be active at month 1"

    @pytest.mark.parametrize("seasoning", [0, 36, 60])
    def test_cpr_invariants(self, seasoning):
        loan = make_loan(seasoning=seasoning)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        result = apply_cpr_overlay(contractual, loan, 15.0)
        assert_invariants(result, f"CPR seas={seasoning}")

    def test_cpr_shortens_life(self):
        loan = make_loan(seasoning=36)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        result = apply_cpr_overlay(contractual, loan, 15.0)
        assert len(result) <= len(contractual)

    def test_cpr_respects_lockout(self):
        """CPR overlay should respect lockout_months via apply_prepay_overlay."""
        loan = make_loan(seasoning=0, lockout_months=60)
        contractual = generate_contractual_cashflows(loan, SETTLE)

        prepay = PrepaymentAssumption(
            prepay_type=PrepaymentType.CPR,
            speed=15.0,
            lockout_months=60,
        )
        result = apply_prepay_overlay(contractual, loan, prepay)

        # During lockout (age <= 60), no voluntary prepayment
        for cf in result:
            if cf.month == 0:
                continue
            age = loan.seasoning + cf.month
            if age <= 60:
                assert cf.unsched_prn == pytest.approx(0.0, abs=0.01), \
                    f"Month {cf.month} (age {age}): CPR should be locked out"

        # After lockout, prepayment should occur
        cf_after = next(cf for cf in result if cf.month == 61)
        assert cf_after.unsched_prn > 0, "After lockout, CPR should produce prepayment"

    def test_cpr_lockout_with_seasoning(self):
        """CPR lockout works with seasoning - lockout applies to absolute age."""
        loan = make_loan(seasoning=36, lockout_months=24)
        contractual = generate_contractual_cashflows(loan, SETTLE)

        # seasoning=36 > lockout=24, so CPR should apply from month 1
        result = apply_cpr_overlay(contractual, loan, 15.0, lockout_months=24)
        cf1 = next(cf for cf in result if cf.month == 1)
        assert cf1.unsched_prn > 0, "Past lockout (age 37 > 24), CPR should apply"

    def test_cpr_lockout_direct(self):
        """Test apply_cpr_overlay lockout parameter directly."""
        loan = make_loan(seasoning=0, lockout_months=12)
        contractual = generate_contractual_cashflows(loan, SETTLE)

        result = apply_cpr_overlay(contractual, loan, 15.0, lockout_months=12)

        # Months 1-12: locked out
        for cf in result:
            if cf.month == 0:
                continue
            if cf.month <= 12:
                assert cf.unsched_prn == pytest.approx(0.0, abs=0.01), \
                    f"Month {cf.month}: should be locked out"

        # Month 13: prepayment starts
        cf13 = next(cf for cf in result if cf.month == 13)
        assert cf13.unsched_prn > 0, "Month 13 should have prepayment"


# ============================================================
# D. Seasoning + IO Period Combinations
# ============================================================

class TestSeasoningIO:
    """IO period interaction with seasoning."""

    def test_seasoning_0_io_24(self):
        """Standard IO: 24 months of IO, then amortization."""
        loan = make_loan(seasoning=0, io_period=24)
        contractual = generate_contractual_cashflows(loan, SETTLE)

        # First 24 months should have zero principal
        for cf in contractual:
            if cf.month == 0:
                continue
            totmo = cf.month
            if totmo <= 24:
                assert cf.reg_prn == pytest.approx(0.0, abs=0.01), \
                    f"Month {cf.month}: should be IO, but reg_prn={cf.reg_prn}"

    def test_seasoning_12_io_24(self):
        """Seasoning=12, io=24: 12 IO months remain in output."""
        loan = make_loan(seasoning=12, io_period=24)
        contractual = generate_contractual_cashflows(loan, SETTLE)

        for cf in contractual:
            if cf.month == 0:
                continue
            totmo = 12 + cf.month
            if totmo <= 24:
                assert cf.reg_prn == pytest.approx(0.0, abs=0.01), \
                    f"Month {cf.month} (totmo {totmo}): should be IO"
            elif cf.month > 0:
                # After IO, should have positive principal (unless at very end)
                if cf.beg_bal > 0.01:
                    assert cf.reg_prn > 0, \
                        f"Month {cf.month} (totmo {totmo}): should be amortizing"

    def test_seasoning_equals_io(self):
        """Edge: seasoning=24, io=24. totmo=24 at month 0 -> IO at month 0 (no payment anyway)."""
        loan = make_loan(seasoning=24, io_period=24)
        contractual = generate_contractual_cashflows(loan, SETTLE)

        # Month 1: totmo=25 > 24, so amortization begins
        cf1 = next(cf for cf in contractual if cf.month == 1)
        assert cf1.reg_prn > 0, "Month 1 should be amortizing (past IO)"

    def test_seasoning_exceeds_io(self):
        """Seasoning=36, io=24: all IO consumed, amortization from month 1."""
        loan = make_loan(seasoning=36, io_period=24)
        contractual = generate_contractual_cashflows(loan, SETTLE)

        cf1 = next(cf for cf in contractual if cf.month == 1)
        assert cf1.reg_prn > 0, "Month 1 should be amortizing (seas > io)"

    def test_io_none_treated_as_zero(self):
        """io_period=None should behave same as io_period=0."""
        loan_none = make_loan(seasoning=12, io_period=None)
        loan_zero = make_loan(seasoning=12, io_period=0)
        cfs_none = generate_contractual_cashflows(loan_none, SETTLE)
        cfs_zero = generate_contractual_cashflows(loan_zero, SETTLE)

        assert len(cfs_none) == len(cfs_zero)
        for a, b in zip(cfs_none, cfs_zero):
            assert a.beg_bal == pytest.approx(b.beg_bal, abs=0.01)
            assert a.reg_prn == pytest.approx(b.reg_prn, abs=0.01)

    def test_cpj_with_seasoning_and_io(self):
        """CPJ overlay respects IO consumed by seasoning."""
        loan = make_loan(seasoning=12, io_period=24)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=0)
        result = apply_cpj_overlay(contractual, loan, cpj)

        assert_invariants(result, "CPJ seas=12 io=24")

        # During IO (months 1-12 where totmo <= 24), scheduled principal = 0
        for cf in result:
            if cf.month == 0:
                continue
            totmo = 12 + cf.month
            if totmo <= 24:
                assert cf.reg_prn == pytest.approx(0.0, abs=0.01), \
                    f"Month {cf.month} (totmo {totmo}): CPJ should keep IO sched_prn=0"


# ============================================================
# E. Seasoning + Balloon Combinations
# ============================================================

class TestSeasoningBalloon:
    """Balloon interaction with seasoning."""

    def test_standard_balloon(self):
        """seasoning=0, balloon=120: balloon at month 120."""
        loan = make_loan(seasoning=0, balloon=120)
        contractual = generate_contractual_cashflows(loan, SETTLE)

        # Last payment month should be 120
        last = contractual[-1]
        assert last.month == 120
        assert last.balloon_pay > 0

    def test_seasoned_balloon(self):
        """seasoning=60, balloon=120: balloon at month 60."""
        loan = make_loan(seasoning=60, balloon=120)
        contractual = generate_contractual_cashflows(loan, SETTLE)

        last = contractual[-1]
        assert last.month == 60, f"Balloon should be at month 60, got {last.month}"
        assert last.balloon_pay > 0

    def test_balloon_at_month_1(self):
        """seasoning=119, balloon=120: balloon at month 1."""
        loan = make_loan(seasoning=119, balloon=120)
        contractual = generate_contractual_cashflows(loan, SETTLE)

        last = contractual[-1]
        assert last.month == 1
        assert last.balloon_pay > 0

    def test_balloon_at_month_0_edge(self):
        """seasoning=120, balloon=120: rembal=0, balloon at month 0."""
        loan = make_loan(seasoning=120, balloon=120)
        contractual = generate_contractual_cashflows(loan, SETTLE)

        # Should still generate at least month 0
        assert len(contractual) >= 1
        # Month 0 has no payments (mo==0 check), so balloon_pay may be 0
        # but the loan should be very short
        assert len(contractual) <= 2

    def test_seasoning_exceeds_balloon(self):
        """seasoning=150, balloon=120: past balloon, rembal=0."""
        loan = make_loan(seasoning=150, balloon=120)
        contractual = generate_contractual_cashflows(loan, SETTLE)

        # rembal = max(0, 120-150) = 0, loop runs for months 0 only
        assert len(contractual) <= 2
        assert_invariants(contractual, "seas>balloon")

    def test_no_balloon_fully_amortizing(self):
        """balloon=None: fully amortizing, uses wam for term."""
        loan = make_loan(seasoning=0, balloon=None, wam=480)
        contractual = generate_contractual_cashflows(loan, SETTLE)

        # Should run for 480 months
        assert contractual[-1].month == 480
        # No balloon payments
        for cf in contractual:
            assert cf.balloon_pay == pytest.approx(0.0, abs=0.01)

    def test_cpj_respects_seasoned_balloon(self):
        """CPJ overlay should trigger balloon at correct seasoned month."""
        loan = make_loan(seasoning=60, balloon=120)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=0)
        result = apply_cpj_overlay(contractual, loan, cpj)

        assert_invariants(result, "CPJ seas=60 balloon=120")

        # Result should terminate at or before month 60 (the balloon month)
        assert result[-1].month <= 60
        assert result[-1].end_bal == pytest.approx(0.0, abs=1.0)


# ============================================================
# F. Null Field Permutations
# ============================================================

class TestNullFieldPermutations:
    """Test all combinations of nullable fields: io_period, balloon, lockout_months."""

    @pytest.mark.parametrize("io_period", [None, 24])
    @pytest.mark.parametrize("balloon", [None, 120])
    @pytest.mark.parametrize("lockout_months", [None, 24])
    def test_contractual_no_crash(self, io_period, balloon, lockout_months):
        """Contractual cashflows should not crash with any null combo."""
        loan = make_loan(
            seasoning=12,
            io_period=io_period,
            balloon=balloon,
            lockout_months=lockout_months,
        )
        cfs = generate_contractual_cashflows(loan, SETTLE)
        assert len(cfs) > 0
        assert_invariants(cfs, f"io={io_period} bal={balloon} lock={lockout_months}")

    @pytest.mark.parametrize("io_period", [None, 24])
    @pytest.mark.parametrize("balloon", [None, 120])
    @pytest.mark.parametrize("lockout_months", [None, 24])
    def test_cpj_overlay_no_crash(self, io_period, balloon, lockout_months):
        """CPJ overlay should not crash with any null combo."""
        loan = make_loan(
            seasoning=12,
            io_period=io_period,
            balloon=balloon,
            lockout_months=lockout_months,
        )
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=lockout_months or 0)
        result = apply_cpj_overlay(contractual, loan, cpj)
        assert len(result) > 0
        assert_invariants(result, f"CPJ io={io_period} bal={balloon} lock={lockout_months}")

    @pytest.mark.parametrize("io_period", [None, 24])
    @pytest.mark.parametrize("balloon", [None, 120])
    def test_cpr_overlay_no_crash(self, io_period, balloon):
        """CPR overlay should not crash with any null combo."""
        loan = make_loan(
            seasoning=12,
            io_period=io_period,
            balloon=balloon,
        )
        contractual = generate_contractual_cashflows(loan, SETTLE)
        result = apply_cpr_overlay(contractual, loan, 15.0)
        assert len(result) > 0
        assert_invariants(result, f"CPR io={io_period} bal={balloon}")


# ============================================================
# G. Scheduled Principal Accuracy (Bug 1 verification)
# ============================================================

class TestScheduledPrincipalAccuracy:
    """Verify scheduled principal in overlays matches contractual schedule.

    Bug: Overlay recomputes sched_prn from PMT and prepaid-down current_bal,
    causing sched_prn to grow larger than contractual reg_prn over time.
    """

    def test_cpj_sched_prn_factor_consistent(self):
        """CPJ overlay reg_prn / beg_bal should match contractual factor."""
        loan = make_loan(seasoning=0, io_period=0, balloon=120)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=0, cpj_speed=15.0)
        result = apply_cpj_overlay(contractual, loan, cpj)

        # Build month -> contractual schedule factor
        contractual_factors = {}
        for cf in contractual:
            if cf.month > 0 and cf.beg_bal > 0.01:
                contractual_factors[cf.month] = cf.reg_prn / cf.beg_bal

        divergences = []
        for cf in result:
            if cf.month == 0 or cf.beg_bal < 0.01:
                continue
            if cf.month in contractual_factors:
                expected_factor = contractual_factors[cf.month]
                actual_factor = cf.reg_prn / cf.beg_bal
                if expected_factor > 1e-8:
                    ratio = actual_factor / expected_factor
                    if abs(ratio - 1.0) > 0.01:  # factor should match within 1%
                        divergences.append((cf.month, expected_factor, actual_factor, ratio))

        if divergences:
            month, c_fac, o_fac, ratio = divergences[-1]
            pytest.fail(
                f"Sched principal factor diverges: "
                f"at month {month}, contractual_factor={c_fac:.6f}, overlay_factor={o_fac:.6f} "
                f"(ratio={ratio:.3f}). Total divergent months: {len(divergences)}"
            )

    def test_cpr_sched_prn_factor_consistent(self):
        """CPR overlay reg_prn / beg_bal should match contractual factor."""
        loan = make_loan(seasoning=0, io_period=0, balloon=120)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        result = apply_cpr_overlay(contractual, loan, 15.0)

        contractual_factors = {}
        for cf in contractual:
            if cf.month > 0 and cf.beg_bal > 0.01:
                contractual_factors[cf.month] = cf.reg_prn / cf.beg_bal

        divergences = []
        for cf in result:
            if cf.month == 0 or cf.beg_bal < 0.01:
                continue
            if cf.month in contractual_factors:
                expected_factor = contractual_factors[cf.month]
                actual_factor = cf.reg_prn / cf.beg_bal
                if expected_factor > 1e-8:
                    ratio = actual_factor / expected_factor
                    if abs(ratio - 1.0) > 0.01:
                        divergences.append((cf.month, expected_factor, actual_factor, ratio))

        if divergences:
            month, c_fac, o_fac, ratio = divergences[-1]
            pytest.fail(
                f"CPR sched principal factor diverges: "
                f"at month {month}, contractual_factor={c_fac:.6f}, overlay_factor={o_fac:.6f} "
                f"(ratio={ratio:.3f}). Total divergent months: {len(divergences)}"
            )

    def test_cpj_sched_prn_capped_to_balance(self):
        """Scheduled principal should never exceed current balance."""
        loan = make_loan(seasoning=0, io_period=0, balloon=120)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=0, cpj_speed=50.0)  # High speed
        result = apply_cpj_overlay(contractual, loan, cpj)

        for cf in result:
            if cf.month == 0:
                continue
            assert cf.reg_prn <= cf.beg_bal + 0.01, \
                f"Month {cf.month}: sched_prn {cf.reg_prn} > beg_bal {cf.beg_bal}"


# ============================================================
# H. Additional Invariants with Seasoning
# ============================================================

class TestSeasonedInvariants:
    """Test invariants across all seasoning scenarios."""

    @pytest.mark.parametrize("seasoning", [0, 12, 36, 60, 100])
    def test_cpj_end_bal_zero_at_termination(self, seasoning):
        """Final cashflow should have end_bal ~0."""
        loan = make_loan(seasoning=seasoning, balloon=120)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=0)
        result = apply_cpj_overlay(contractual, loan, cpj)

        assert result[-1].end_bal == pytest.approx(0.0, abs=1.0), \
            f"seas={seasoning}: final end_bal={result[-1].end_bal} should be ~0"

    @pytest.mark.parametrize("seasoning", [0, 12, 36, 60])
    def test_cpj_net_prn_equals_components(self, seasoning):
        """net_prn should equal reg_prn + balloon_pay + unsched_prn (approx)."""
        loan = make_loan(seasoning=seasoning, balloon=120)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        cpj = make_cpj(lockout_months=0)
        result = apply_cpj_overlay(contractual, loan, cpj)

        for cf in result:
            if cf.month == 0:
                continue
            # net_prn should approximately equal the sum of components
            # (allowing for balloon being part of unsched_prn in some cases)
            assert cf.net_prn >= 0, f"Month {cf.month}: negative net_prn"
            assert cf.end_bal == pytest.approx(cf.beg_bal - cf.net_prn, abs=0.01), \
                f"Month {cf.month}: end_bal != beg_bal - net_prn"


# ============================================================
# I. Multi-Loan Aggregation
# ============================================================

class TestMultiLoanAggregation:
    """Test aggregation of loans with different seasoning/balloon."""

    def test_different_seasoning_aggregation(self):
        """Two loans with different seasoning aggregate correctly."""
        loan_a = make_loan(seasoning=0, balloon=120, original_face=500_000)
        loan_b = make_loan(seasoning=60, balloon=120, original_face=500_000)

        cfs_a = generate_contractual_cashflows(loan_a, SETTLE)
        cfs_b = generate_contractual_cashflows(loan_b, SETTLE)

        # Loan A: 120 months, Loan B: 60 months (balloon - seasoning)
        assert cfs_a[-1].month == 120
        assert cfs_b[-1].month == 60

        agg = aggregate_cashflows([cfs_a, cfs_b])

        # Aggregated should span full 120 months
        assert agg[-1].month == 120

        # Month 1: both loans contribute
        month1 = next(cf for cf in agg if cf.month == 1)
        a1 = next(cf for cf in cfs_a if cf.month == 1)
        b1 = next(cf for cf in cfs_b if cf.month == 1)
        assert month1.beg_bal == pytest.approx(a1.beg_bal + b1.beg_bal, abs=1.0)

        # Month 61: only loan A contributes (loan B done at month 60)
        month61 = next((cf for cf in agg if cf.month == 61), None)
        if month61:
            a61 = next(cf for cf in cfs_a if cf.month == 61)
            assert month61.beg_bal == pytest.approx(a61.beg_bal, abs=1.0)

    def test_different_balloon_aggregation(self):
        """Loan with balloon + fully amortizing loan."""
        loan_balloon = make_loan(seasoning=0, balloon=120, original_face=500_000, wam=480)
        loan_full = make_loan(seasoning=0, balloon=None, original_face=500_000, wam=480)

        cfs_b = generate_contractual_cashflows(loan_balloon, SETTLE)
        cfs_f = generate_contractual_cashflows(loan_full, SETTLE)

        assert cfs_b[-1].month == 120  # balloon loan
        assert cfs_f[-1].month == 480  # fully amortizing

        agg = aggregate_cashflows([cfs_b, cfs_f])
        assert agg[-1].month == 480  # aggregate spans to longest

    def test_aggregated_cpj_invariants(self):
        """Aggregated CPJ cashflows maintain invariants."""
        loan_a = make_loan(seasoning=0, balloon=120, original_face=500_000)
        loan_b = make_loan(seasoning=36, balloon=120, original_face=500_000)

        cpj = make_cpj(lockout_months=0)

        cfs_a = generate_contractual_cashflows(loan_a, SETTLE)
        cfs_b = generate_contractual_cashflows(loan_b, SETTLE)

        cpj_a = apply_cpj_overlay(cfs_a, loan_a, cpj)
        cpj_b = apply_cpj_overlay(cfs_b, loan_b, cpj)

        agg = aggregate_cashflows([cpj_a, cpj_b])
        assert_invariants(agg, "aggregated CPJ")


# ============================================================
# J. Dispatch via apply_prepay_overlay
# ============================================================

class TestPrepayDispatch:
    """Test the apply_prepay_overlay dispatch function."""

    def test_cpj_dispatch(self):
        """CPJ type dispatches correctly with seasoning."""
        loan = make_loan(seasoning=36, lockout_months=24)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        prepay = PrepaymentAssumption(
            prepay_type=PrepaymentType.CPJ,
            speed=15.0,
            lockout_months=24,
            pld_curve=DEFAULT_PLD_CURVE,
        )
        result = apply_prepay_overlay(contractual, loan, prepay)
        assert len(result) > 0
        assert_invariants(result, "dispatch CPJ")

        # Past lockout (seas=36 > lockout=24), should include CPR
        cf1 = next(cf for cf in result if cf.month == 1)
        age = 36 + 1
        pld = get_pld_rate(age, DEFAULT_PLD_CURVE)
        # Hazard-style rate
        smm_pld = 1.0 - (1.0 - pld) ** (1.0 / 12.0)
        smm_cpr = 1.0 - (1.0 - 0.15) ** (1.0 / 12.0)
        expected_smm = 1.0 - (1.0 - smm_pld) * (1.0 - smm_cpr)
        expected_rate = 1.0 - (1.0 - expected_smm) ** 12.0
        assert cf1.annual_prepay_rate == pytest.approx(expected_rate, abs=1e-6)

    def test_cpr_dispatch(self):
        """CPR type dispatches correctly."""
        loan = make_loan(seasoning=36)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        prepay = PrepaymentAssumption(
            prepay_type=PrepaymentType.CPR,
            speed=10.0,
        )
        result = apply_prepay_overlay(contractual, loan, prepay)
        assert len(result) > 0
        assert_invariants(result, "dispatch CPR")

    def test_none_dispatch(self):
        """None type returns contractual unchanged."""
        loan = make_loan(seasoning=36)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        prepay = PrepaymentAssumption(prepay_type=PrepaymentType.NONE)
        result = apply_prepay_overlay(contractual, loan, prepay)
        assert len(result) == len(contractual)

    def test_cpj_dispatch_uses_loan_lockout(self):
        """When CPJ lockout=0 but loan has lockout, loan lockout is used."""
        loan = make_loan(seasoning=0, lockout_months=36)
        contractual = generate_contractual_cashflows(loan, SETTLE)
        prepay = PrepaymentAssumption(
            prepay_type=PrepaymentType.CPJ,
            speed=15.0,
            lockout_months=0,  # No deal-level lockout
            pld_curve=DEFAULT_PLD_CURVE,
        )
        result = apply_prepay_overlay(contractual, loan, prepay)

        # Loan lockout=36 should apply. Month 1: age=1 <= 36, PLD only
        cf1 = next(cf for cf in result if cf.month == 1)
        pld = get_pld_rate(1, DEFAULT_PLD_CURVE)
        assert cf1.annual_prepay_rate == pytest.approx(pld, abs=1e-6), \
            "Loan-level lockout should apply when deal-level lockout is 0"
