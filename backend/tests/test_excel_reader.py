"""Tests for the Excel reader module.

Reads the actual Ginnie_Project_Loan_Maker.xlsm workbook and validates
that extracted parameters match the known defaults documented in
PARITY_AND_CONVENTIONS_REPORT.md.
"""

from __future__ import annotations

import os
from datetime import date
from pathlib import Path

import pytest

from app.engines.excel_reader import (
    parse_workbook,
    read_cashflows,
    read_loan_inputs,
    read_pricing_inputs,
    read_analytics_outputs,
)

WORKBOOK_PATH = Path(__file__).resolve().parents[2] / "Ginnie_Project_Loan_Maker.xlsm"

# Skip all tests if the workbook is not present
pytestmark = pytest.mark.skipif(
    not WORKBOOK_PATH.exists(),
    reason="Ginnie_Project_Loan_Maker.xlsm not found",
)


@pytest.fixture(scope="module")
def workbook_bytes() -> bytes:
    return WORKBOOK_PATH.read_bytes()


@pytest.fixture(scope="module")
def parsed(workbook_bytes: bytes) -> dict:
    return parse_workbook(workbook_bytes)


class TestLoanInputs:
    def test_dated_date(self, parsed: dict):
        assert parsed["loan"]["dated_date"] == "2026-03-01"

    def test_first_settle(self, parsed: dict):
        assert parsed["loan"]["first_settle"] == "2026-03-01"

    def test_delay(self, parsed: dict):
        assert parsed["loan"]["delay"] == 44

    def test_original_face(self, parsed: dict):
        assert parsed["loan"]["original_face"] == 1_000_000.0

    def test_coupon_net(self, parsed: dict):
        assert abs(parsed["loan"]["coupon_net"] - 0.05) < 1e-6

    def test_wac_gross(self, parsed: dict):
        assert abs(parsed["loan"]["wac_gross"] - 0.0525) < 1e-6

    def test_wam(self, parsed: dict):
        assert parsed["loan"]["wam"] == 480

    def test_amort_wam(self, parsed: dict):
        assert parsed["loan"]["amort_wam"] == 480

    def test_io_period(self, parsed: dict):
        assert parsed["loan"]["io_period"] == 0

    def test_balloon(self, parsed: dict):
        assert parsed["loan"]["balloon"] == 120

    def test_seasoning(self, parsed: dict):
        assert parsed["loan"]["seasoning"] == 0


class TestPricingInputs:
    def test_pricing_type(self, parsed: dict):
        assert parsed["pricing"]["pricing_type"] == "Price"

    def test_pricing_input(self, parsed: dict):
        assert parsed["pricing"]["pricing_input"] == 100.0

    def test_settle_date(self, parsed: dict):
        assert parsed["pricing"]["settle_date"] == "2026-03-03"

    def test_curve_date(self, parsed: dict):
        assert parsed["pricing"]["curve_date"] == "2026-03-03"


class TestCashflows:
    def test_row_count(self, parsed: dict):
        assert len(parsed["cashflows"]) == 121

    def test_first_month(self, parsed: dict):
        assert parsed["cashflows"][0]["month"] == 0

    def test_last_month(self, parsed: dict):
        assert parsed["cashflows"][-1]["month"] == 120

    def test_first_beg_bal(self, parsed: dict):
        assert abs(parsed["cashflows"][0]["beg_bal"] - 1_000_000.0) < 0.01

    def test_last_end_bal(self, parsed: dict):
        assert abs(parsed["cashflows"][-1]["end_bal"]) < 0.01

    def test_sum_pmt_to_agy(self, parsed: dict):
        total = sum(cf["pmt_to_agy"] for cf in parsed["cashflows"])
        assert abs(total - 598_644.40) < 0.01

    def test_sum_int_to_inv(self, parsed: dict):
        total = sum(cf["int_to_inv"] for cf in parsed["cashflows"])
        assert abs(total - 478_153.93) < 0.01

    def test_sum_net_prn(self, parsed: dict):
        total = sum(cf["net_prn"] for cf in parsed["cashflows"])
        assert abs(total - 1_000_000.0) < 0.01

    def test_sum_net_flow(self, parsed: dict):
        total = sum(cf["net_flow"] for cf in parsed["cashflows"])
        assert abs(total - 1_478_153.93) < 0.01


class TestAnalytics:
    """Validate analytics outputs read from the workbook.

    Note: These may be 0 if the workbook was saved without recalculating
    (data_only=True reads cached values). The tests accept 0 in that case.
    """

    def test_has_expected_keys(self, parsed: dict):
        expected_keys = {
            "price", "accrued", "yield_pct", "j_spread", "wal",
            "modified_duration", "convexity", "risk_dpdy", "tsy_rate_at_wal",
        }
        assert set(parsed["analytics"].keys()) == expected_keys


class TestUploadEndpoint:
    """Test the upload endpoint via the FastAPI test client."""

    def test_upload_valid_file(self, workbook_bytes: bytes):
        from fastapi.testclient import TestClient
        from app.main import app

        client = TestClient(app)
        response = client.post(
            "/api/deals/upload-excel",
            files={"file": ("test.xlsm", workbook_bytes, "application/vnd.ms-excel.sheet.macroEnabled.12")},
        )
        assert response.status_code == 200
        data = response.json()
        assert "loan" in data
        assert "pricing" in data
        assert "cashflows" in data
        assert "analytics" in data
        assert data["loan"]["original_face"] == 1_000_000.0

    def test_upload_wrong_extension(self):
        from fastapi.testclient import TestClient
        from app.main import app

        client = TestClient(app)
        response = client.post(
            "/api/deals/upload-excel",
            files={"file": ("test.txt", b"not excel", "text/plain")},
        )
        assert response.status_code == 400

    def test_upload_invalid_content(self):
        from fastapi.testclient import TestClient
        from app.main import app

        client = TestClient(app)
        response = client.post(
            "/api/deals/upload-excel",
            files={"file": ("test.xlsm", b"not a real workbook", "application/vnd.ms-excel.sheet.macroEnabled.12")},
        )
        assert response.status_code == 500
