"""
CPJ prepayment overlay tests.

Tests:
1. CPJ OFF equals contractual (exact parity with Excel)
2. During lockout: AnnualPrepayRate = PLD only (no voluntary CPR)
3. After lockout: AnnualPrepayRate = PLD + CPR_ann
4. No negative balances
5. Total principal capped to balance
6. SMM computation
"""

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.models.loan import LoanInput, CPJInput, PLDCurveEntry
from app.engines.cashflow_engine import (
    generate_contractual_cashflows,
    apply_cpj_overlay,
    get_pld_rate,
    DEFAULT_PLD_CURVE,
)


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
    lockout_months=24,
)

SETTLE = date(2026, 3, 3)


class TestCPJOff:
    """CPJ OFF must produce identical results to contractual."""

    def test_cpj_off_equals_contractual(self):
        contractual = generate_contractual_cashflows(LOAN, SETTLE)
        cpj_off = CPJInput(enabled=False, cpj_speed=15, lockout_months=24, pld_curve=DEFAULT_PLD_CURVE)
        result = apply_cpj_overlay(contractual, LOAN, cpj_off)

        # Should be identical (same object returned)
        assert len(result) == len(contractual)
        for r, c in zip(result, contractual):
            assert r.beg_bal == c.beg_bal
            assert r.end_bal == c.end_bal
            assert r.net_prn == c.net_prn
            assert r.int_to_inv == c.int_to_inv


class TestPLDCurve:
    """Test PLD curve lookup."""

    def test_pld_month_1(self):
        rate = get_pld_rate(1, DEFAULT_PLD_CURVE)
        assert rate == pytest.approx(0.0130)

    def test_pld_month_12(self):
        rate = get_pld_rate(12, DEFAULT_PLD_CURVE)
        assert rate == pytest.approx(0.0130)

    def test_pld_month_13(self):
        rate = get_pld_rate(13, DEFAULT_PLD_CURVE)
        assert rate == pytest.approx(0.0247)

    def test_pld_month_100(self):
        rate = get_pld_rate(100, DEFAULT_PLD_CURVE)
        assert rate == pytest.approx(0.0057)

    def test_pld_month_200(self):
        rate = get_pld_rate(200, DEFAULT_PLD_CURVE)
        assert rate == pytest.approx(0.0025)

    def test_pld_month_300(self):
        rate = get_pld_rate(300, DEFAULT_PLD_CURVE)
        assert rate == pytest.approx(0.0)

    def test_pld_multiplier(self):
        rate = get_pld_rate(1, DEFAULT_PLD_CURVE, multiplier=0.5)
        assert rate == pytest.approx(0.0065)


class TestCPJLockout:
    """During lockout, voluntary CPR = 0, only PLD applies."""

    def test_lockout_no_voluntary_cpr(self):
        contractual = generate_contractual_cashflows(LOAN, SETTLE)
        cpj = CPJInput(
            enabled=True,
            cpj_speed=15.0,
            lockout_months=24,
            pld_curve=DEFAULT_PLD_CURVE,
        )
        result = apply_cpj_overlay(contractual, LOAN, cpj)

        for cf in result:
            if cf.month == 0:
                continue
            age = LOAN.seasoning + cf.month
            if age <= 24:
                # During lockout: rate should be PLD only
                expected_pld = get_pld_rate(age, DEFAULT_PLD_CURVE)
                assert cf.annual_prepay_rate == pytest.approx(expected_pld, abs=1e-6), \
                    f"Month {cf.month}: lockout rate {cf.annual_prepay_rate} != PLD {expected_pld}"

    def test_after_lockout_includes_cpr(self):
        contractual = generate_contractual_cashflows(LOAN, SETTLE)
        cpj = CPJInput(
            enabled=True,
            cpj_speed=15.0,
            lockout_months=24,
            pld_curve=DEFAULT_PLD_CURVE,
        )
        result = apply_cpj_overlay(contractual, LOAN, cpj)

        for cf in result:
            if cf.month == 0:
                continue
            age = LOAN.seasoning + cf.month
            if age > 24:
                expected_pld = get_pld_rate(age, DEFAULT_PLD_CURVE)
                expected_rate = expected_pld + 0.15
                assert cf.annual_prepay_rate == pytest.approx(expected_rate, abs=1e-6), \
                    f"Month {cf.month}: post-lockout rate {cf.annual_prepay_rate} != {expected_rate}"


class TestCPJSMM:
    """Test SMM computation."""

    def test_smm_from_annual_rate(self):
        """SMM = 1 - (1 - annual_rate)^(1/12)"""
        annual = 0.15 + 0.0130  # 15 CPJ + PLD month 25
        expected_smm = 1 - (1 - annual) ** (1 / 12)

        contractual = generate_contractual_cashflows(LOAN, SETTLE)
        cpj = CPJInput(
            enabled=True,
            cpj_speed=15.0,
            lockout_months=0,  # no lockout to simplify
            pld_curve=DEFAULT_PLD_CURVE,
        )
        result = apply_cpj_overlay(contractual, LOAN, cpj)

        # Month 1: age=1, PLD=0.013, CPR=0.15 => annual=0.163
        cf1 = result[1]
        expected_annual = 0.013 + 0.15
        expected_smm_1 = 1 - (1 - expected_annual) ** (1 / 12)
        assert cf1.smm == pytest.approx(expected_smm_1, abs=1e-8)


class TestCPJInvariants:
    """Test structural invariants of CPJ overlay."""

    def test_no_negative_balances(self):
        contractual = generate_contractual_cashflows(LOAN, SETTLE)
        cpj = CPJInput(
            enabled=True,
            cpj_speed=50.0,  # high speed
            lockout_months=0,
            pld_curve=DEFAULT_PLD_CURVE,
        )
        result = apply_cpj_overlay(contractual, LOAN, cpj)

        for cf in result:
            assert cf.beg_bal >= -0.001, f"Month {cf.month}: negative beg_bal {cf.beg_bal}"
            assert cf.end_bal >= -0.001, f"Month {cf.month}: negative end_bal {cf.end_bal}"

    def test_total_principal_capped(self):
        contractual = generate_contractual_cashflows(LOAN, SETTLE)
        cpj = CPJInput(
            enabled=True,
            cpj_speed=30.0,
            lockout_months=0,
            pld_curve=DEFAULT_PLD_CURVE,
        )
        result = apply_cpj_overlay(contractual, LOAN, cpj)

        for cf in result:
            if cf.month == 0:
                continue
            assert cf.net_prn <= cf.beg_bal + 0.001, \
                f"Month {cf.month}: net_prn {cf.net_prn} > beg_bal {cf.beg_bal}"

    def test_balance_continuity(self):
        """End balance of month t must equal begin balance of month t+1."""
        contractual = generate_contractual_cashflows(LOAN, SETTLE)
        cpj = CPJInput(
            enabled=True,
            cpj_speed=15.0,
            lockout_months=24,
            pld_curve=DEFAULT_PLD_CURVE,
        )
        result = apply_cpj_overlay(contractual, LOAN, cpj)

        for i in range(len(result) - 1):
            assert result[i].end_bal == pytest.approx(result[i + 1].beg_bal, abs=0.01), \
                f"Month {result[i].month}: end_bal {result[i].end_bal} != next beg_bal {result[i+1].beg_bal}"

    def test_cpj_pays_down_faster(self):
        """With prepayments, total life should be shorter or equal."""
        contractual = generate_contractual_cashflows(LOAN, SETTLE)
        cpj = CPJInput(
            enabled=True,
            cpj_speed=15.0,
            lockout_months=0,
            pld_curve=DEFAULT_PLD_CURVE,
        )
        result = apply_cpj_overlay(contractual, LOAN, cpj)

        # With prepays, final balance should hit 0 before or at month 120
        assert result[-1].end_bal == pytest.approx(0.0, abs=1.0)
        assert len(result) <= len(contractual)


class TestCPJZeroSpeed:
    """CPJ with speed=0 should be PLD-only."""

    def test_zero_speed_equals_pld_only(self):
        contractual = generate_contractual_cashflows(LOAN, SETTLE)
        cpj = CPJInput(
            enabled=True,
            cpj_speed=0.0,
            lockout_months=0,
            pld_curve=DEFAULT_PLD_CURVE,
        )
        result = apply_cpj_overlay(contractual, LOAN, cpj)

        for cf in result:
            if cf.month == 0:
                continue
            age = LOAN.seasoning + cf.month
            expected = get_pld_rate(age, DEFAULT_PLD_CURVE)
            assert cf.annual_prepay_rate == pytest.approx(expected, abs=1e-6)
