"""
Spreadsheet parity tests: validate contractual cashflows against Excel golden outputs.

Golden data extracted from Ginnie_Project_Loan_Maker.xlsm.

Excel inputs:
    Dated Date: 2026-03-01 (serial 46082)
    1st Settle: 2026-03-01 (serial 46082)
    Delay: 44
    Original Face: 1,000,000
    Coupon (Net): 5.00%
    WAC (Gross): 5.25%
    WAM: 480
    Amort WAM: 480
    IO Period: 0
    Balloon: 120
    Seasoning: 0
    Settle Date: 2026-03-03 (serial 46084)

Tolerances:
    Cashflows: abs 0.01
    Rates: abs 1e-6
    Dates (serials): exact
"""

import json
import os
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.models.loan import LoanInput, PricingInput, PricingType, TreasuryCurve, TreasuryCurvePoint
from app.engines.cashflow_engine import generate_contractual_cashflows, _date_to_serial
from app.engines.analytics_engine import compute_full_analytics, compute_wal

# Load golden data
GOLDEN_PATH = Path(__file__).parent.parent.parent / "golden_cashflows.json"


def load_golden():
    with open(GOLDEN_PATH) as f:
        return json.load(f)


GOLDEN = load_golden()

# Default loan matching Excel
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

TSY_CURVE = TreasuryCurve(points=[
    TreasuryCurvePoint(term=1/12, rate=3.564),
    TreasuryCurvePoint(term=2/12, rate=3.698),
    TreasuryCurvePoint(term=3/12, rate=3.682),
    TreasuryCurvePoint(term=4/12, rate=3.673),
    TreasuryCurvePoint(term=6/12, rate=3.633),
    TreasuryCurvePoint(term=1, rate=3.564),
    TreasuryCurvePoint(term=2, rate=3.513),
    TreasuryCurvePoint(term=3, rate=3.521),
    TreasuryCurvePoint(term=5, rate=3.649),
    TreasuryCurvePoint(term=7, rate=3.846),
    TreasuryCurvePoint(term=10, rate=4.07),
    TreasuryCurvePoint(term=20, rate=4.665),
    TreasuryCurvePoint(term=30, rate=4.716),
])


class TestCashflowRowCount:
    def test_row_count(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        # Excel has 121 rows (month 0 to 120)
        assert len(cfs) == 121
        assert len(GOLDEN) == 121


class TestMonth0:
    def test_month_0(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        cf = cfs[0]
        g = GOLDEN[0]
        assert cf.month == 0
        assert cf.beg_bal == pytest.approx(float(g["Beg_Bal"]), abs=0.01)
        assert cf.end_bal == pytest.approx(float(g["End_Bal"]), abs=0.01)
        assert cf.net_prn == 0.0
        assert cf.net_flow == 0.0


class TestCashflowParity:
    """Test each month's cashflow values against Excel golden outputs."""

    def test_beg_bal_all_months(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        for i, (cf, g) in enumerate(zip(cfs, GOLDEN)):
            expected = float(g["Beg_Bal"])
            assert cf.beg_bal == pytest.approx(expected, abs=0.01), \
                f"Month {cf.month}: Beg Bal {cf.beg_bal} != {expected}"

    def test_end_bal_all_months(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        for cf, g in zip(cfs, GOLDEN):
            expected = float(g["End_Bal"])
            assert cf.end_bal == pytest.approx(expected, abs=0.01), \
                f"Month {cf.month}: End Bal {cf.end_bal} != {expected}"

    def test_pmt_to_agy_all_months(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        for cf, g in zip(cfs, GOLDEN):
            expected = float(g["Pmt_to_Agy"])
            assert cf.pmt_to_agy == pytest.approx(expected, abs=0.01), \
                f"Month {cf.month}: Pmt to Agy {cf.pmt_to_agy} != {expected}"

    def test_int_to_inv_all_months(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        for cf, g in zip(cfs, GOLDEN):
            expected = float(g["Int_to_Inv"])
            assert cf.int_to_inv == pytest.approx(expected, abs=0.01), \
                f"Month {cf.month}: Int to Inv {cf.int_to_inv} != {expected}"

    def test_int_to_agy_all_months(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        for cf, g in zip(cfs, GOLDEN):
            expected = float(g["Int_to_Agy"])
            assert cf.int_to_agy == pytest.approx(expected, abs=0.01), \
                f"Month {cf.month}: Int to Agy {cf.int_to_agy} != {expected}"

    def test_reg_prn_all_months(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        for cf, g in zip(cfs, GOLDEN):
            expected = float(g["Reg_Prn"])
            assert cf.reg_prn == pytest.approx(expected, abs=0.01), \
                f"Month {cf.month}: Reg Prn {cf.reg_prn} != {expected}"

    def test_balloon_all_months(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        for cf, g in zip(cfs, GOLDEN):
            expected = float(g["Balloon"])
            assert cf.balloon_pay == pytest.approx(expected, abs=0.01), \
                f"Month {cf.month}: Balloon {cf.balloon_pay} != {expected}"

    def test_net_prn_all_months(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        for cf, g in zip(cfs, GOLDEN):
            expected = float(g["Net_Prn"])
            assert cf.net_prn == pytest.approx(expected, abs=0.01), \
                f"Month {cf.month}: Net Prn {cf.net_prn} != {expected}"

    def test_net_flow_all_months(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        for cf, g in zip(cfs, GOLDEN):
            expected = float(g["Net_Flow"])
            assert cf.net_flow == pytest.approx(expected, abs=0.01), \
                f"Month {cf.month}: Net Flow {cf.net_flow} != {expected}"


class TestDateParity:
    def test_date_serial_all_months(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        for cf, g in zip(cfs, GOLDEN):
            expected = int(g["Date"])
            assert cf.date_serial == expected, \
                f"Month {cf.month}: Date serial {cf.date_serial} != {expected}"

    def test_cf_date_serial_all_months(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        for cf, g in zip(cfs, GOLDEN):
            expected = int(g["CF_Date"])
            assert cf.cf_date_serial == expected, \
                f"Month {cf.month}: CF Date serial {cf.cf_date_serial} != {expected}"

    def test_year_frac_all_months(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        for cf, g in zip(cfs, GOLDEN):
            expected = float(g["Year_Frac"])
            assert cf.year_frac == pytest.approx(expected, abs=1e-10), \
                f"Month {cf.month}: Year Frac {cf.year_frac} != {expected}"


class TestSummaryTotals:
    """Validate summary row (row 30) totals from Excel."""

    def test_total_int_to_inv(self):
        """Excel J30 = 598644.40473580698 (sum of Pmt to Agy? Actually checking K30)."""
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        total = sum(cf.int_to_inv for cf in cfs)
        assert total == pytest.approx(478153.93490312854, abs=0.01)

    def test_total_int_to_agy(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        total = sum(cf.int_to_agy for cf in cfs)
        assert total == pytest.approx(502061.63164828508, abs=0.01)

    def test_total_reg_prn(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        total = sum(cf.reg_prn for cf in cfs)
        assert total == pytest.approx(96582.773087521215, abs=0.01)

    def test_total_balloon(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        total = sum(cf.balloon_pay for cf in cfs)
        assert total == pytest.approx(903417.22691247659, abs=0.01)

    def test_total_net_prn(self):
        """Net principal should equal original face."""
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        total = sum(cf.net_prn for cf in cfs)
        assert total == pytest.approx(999999.99999999779, abs=0.01)

    def test_total_net_flow(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        total = sum(cf.net_flow for cf in cfs)
        assert total == pytest.approx(1478153.9349031262, abs=0.01)

    def test_total_pmt_to_agy(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        total = sum(cf.pmt_to_agy for cf in cfs)
        assert total == pytest.approx(598644.40473580698, abs=0.01)


class TestBalloonMonth:
    def test_balloon_at_month_120(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        cf120 = cfs[120]
        assert cf120.month == 120
        assert cf120.balloon_pay == pytest.approx(903417.22691247659, abs=0.01)
        assert cf120.end_bal == pytest.approx(0.0, abs=0.01)

    def test_no_balloon_before_120(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        for cf in cfs[:120]:
            assert cf.balloon_pay == 0.0


class TestAnalyticsParity:
    """Test analytics outputs match Excel workbook."""

    def test_wal(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        settle_serial = _date_to_serial(SETTLE)
        wal = compute_wal(cfs, settle_serial)
        assert wal == pytest.approx(9.5964120313959143, abs=0.0001)

    def test_yield_from_par(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        settle_serial = _date_to_serial(SETTLE)
        dated_serial = _date_to_serial(date(2026, 3, 1))

        analytics = compute_full_analytics(
            cashflows=cfs,
            settle_serial=settle_serial,
            dated_date_serial=dated_serial,
            coupon_net=0.05,
            original_face=1_000_000.0,
            pricing_type="Price",
            pricing_input=100.0,
            curve=TSY_CURVE,
        )
        # Excel yield = 5.0262282776780243
        assert analytics.yield_pct == pytest.approx(5.0262282776780243, abs=0.01)

    def test_j_spread(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        settle_serial = _date_to_serial(SETTLE)
        dated_serial = _date_to_serial(date(2026, 3, 1))

        analytics = compute_full_analytics(
            cashflows=cfs,
            settle_serial=settle_serial,
            dated_date_serial=dated_serial,
            coupon_net=0.05,
            original_face=1_000_000.0,
            pricing_type="Price",
            pricing_input=100.0,
            curve=TSY_CURVE,
        )
        # Excel J-Spread = 98.636284600046224 bps
        assert analytics.j_spread == pytest.approx(98.636284600046224, abs=1.0)

    def test_modified_duration(self):
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        settle_serial = _date_to_serial(SETTLE)
        dated_serial = _date_to_serial(date(2026, 3, 1))

        analytics = compute_full_analytics(
            cashflows=cfs,
            settle_serial=settle_serial,
            dated_date_serial=dated_serial,
            coupon_net=0.05,
            original_face=1_000_000.0,
            pricing_type="Price",
            pricing_input=100.0,
            curve=TSY_CURVE,
        )
        # Excel Modified Duration = 7.4254997403846348
        assert analytics.modified_duration == pytest.approx(7.4254997403846348, abs=0.1)


class TestKeyFormulas:
    """Test specific formula implementations against known values."""

    def test_pmt_function(self):
        """PMT(0.0525/12, 480, -1000000) should give monthly payment."""
        from app.engines.cashflow_engine import _excel_pmt
        pmt = _excel_pmt(0.0525 / 12, 480, 1_000_000.0)
        assert pmt == pytest.approx(4988.7033727983862, abs=0.01)

    def test_date_serial_conversion(self):
        from app.engines.cashflow_engine import _date_to_serial
        assert _date_to_serial(date(2026, 3, 1)) == 46082
        assert _date_to_serial(date(2026, 3, 3)) == 46084

    def test_specific_month_1(self):
        """Verify month 1 exactly."""
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        cf = cfs[1]
        assert cf.month == 1
        assert cf.beg_bal == pytest.approx(1_000_000.0, abs=0.01)
        assert cf.pmt_to_agy == pytest.approx(4988.7033727983862, abs=0.01)
        assert cf.int_to_inv == pytest.approx(4166.666666666667, abs=0.01)
        assert cf.int_to_agy == pytest.approx(4375.0, abs=0.01)
        assert cf.reg_prn == pytest.approx(613.70337279838623, abs=0.01)

    def test_specific_month_120(self):
        """Verify last month (balloon)."""
        cfs = generate_contractual_cashflows(LOAN, SETTLE)
        cf = cfs[120]
        assert cf.month == 120
        assert cf.beg_bal == pytest.approx(904448.96605876787, abs=0.01)
        assert cf.balloon_pay == pytest.approx(903417.22691247659, abs=0.01)
        assert cf.end_bal == pytest.approx(0.0, abs=0.01)
        assert cf.net_prn == pytest.approx(904448.96605876787, abs=0.01)
