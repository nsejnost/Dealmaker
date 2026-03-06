"""API integration tests."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


class TestHealthAndRoot:
    def test_root(self):
        r = client.get("/")
        assert r.status_code == 200
        assert r.json()["app"] == "GNR Deal Maker"

    def test_health(self):
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


class TestDefaults:
    def test_get_defaults(self):
        r = client.get("/api/deals/defaults")
        assert r.status_code == 200
        data = r.json()
        assert data["loan"]["original_face"] == 1_000_000
        assert data["loan"]["coupon_net"] == 0.05
        assert data["loan"]["balloon"] == 120

    def test_get_pld_curve(self):
        r = client.get("/api/deals/pld-curve")
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 12
        assert data[0]["annual_rate"] == 0.013

    def test_get_tsy_curve(self):
        r = client.get("/api/deals/tsy-curve")
        assert r.status_code == 200
        data = r.json()
        assert len(data["points"]) == 13


class TestRunInline:
    def test_run_default_deal(self):
        defaults = client.get("/api/deals/defaults").json()
        r = client.post("/api/deals/run-inline", json=defaults)
        assert r.status_code == 200
        result = r.json()

        # Check cashflows
        assert len(result["collateral_cashflows"]) == 121

        # Check analytics
        analytics = result["collateral_analytics"]
        assert analytics["price"] == pytest.approx(100.0, abs=0.01)
        assert analytics["wal"] == pytest.approx(9.596, abs=0.01)
        assert analytics["yield_pct"] == pytest.approx(5.026, abs=0.1)

    def test_run_with_cpj(self):
        defaults = client.get("/api/deals/defaults").json()
        defaults["cpj"]["enabled"] = True
        defaults["cpj"]["cpj_speed"] = 15.0
        defaults["cpj"]["lockout_months"] = 24
        defaults["cpj"]["pld_curve"] = [
            {"start_month": 1, "end_month": 12, "annual_rate": 0.013},
            {"start_month": 13, "end_month": 24, "annual_rate": 0.0247},
            {"start_month": 25, "end_month": 36, "annual_rate": 0.0251},
            {"start_month": 37, "end_month": 48, "annual_rate": 0.022},
            {"start_month": 49, "end_month": 60, "annual_rate": 0.0213},
            {"start_month": 61, "end_month": 72, "annual_rate": 0.0146},
            {"start_month": 73, "end_month": 84, "annual_rate": 0.0126},
            {"start_month": 85, "end_month": 96, "annual_rate": 0.008},
            {"start_month": 97, "end_month": 108, "annual_rate": 0.0057},
            {"start_month": 109, "end_month": 168, "annual_rate": 0.005},
            {"start_month": 169, "end_month": 240, "annual_rate": 0.0025},
            {"start_month": 241, "end_month": 9999, "annual_rate": 0.0},
        ]

        r = client.post("/api/deals/run-inline", json=defaults)
        assert r.status_code == 200
        result = r.json()

        # Bond collateral should have prepayments
        bond_cfs = result["bond_collateral_cashflows"]
        assert len(bond_cfs) > 0
        # Should terminate at or before month 120
        last = bond_cfs[-1]
        assert last["end_bal"] == pytest.approx(0.0, abs=1.0)

    def test_run_with_bond_structure(self):
        defaults = client.get("/api/deals/defaults").json()
        defaults["cpj"]["enabled"] = True
        defaults["cpj"]["cpj_speed"] = 15.0
        defaults["cpj"]["lockout_months"] = 24
        defaults["cpj"]["pld_curve"] = [
            {"start_month": 1, "end_month": 12, "annual_rate": 0.013},
            {"start_month": 13, "end_month": 24, "annual_rate": 0.0247},
            {"start_month": 25, "end_month": 36, "annual_rate": 0.0251},
            {"start_month": 37, "end_month": 48, "annual_rate": 0.022},
            {"start_month": 49, "end_month": 60, "annual_rate": 0.0213},
            {"start_month": 61, "end_month": 72, "annual_rate": 0.0146},
            {"start_month": 73, "end_month": 84, "annual_rate": 0.0126},
            {"start_month": 85, "end_month": 96, "annual_rate": 0.008},
            {"start_month": 97, "end_month": 108, "annual_rate": 0.0057},
            {"start_month": 109, "end_month": 168, "annual_rate": 0.005},
            {"start_month": 169, "end_month": 240, "annual_rate": 0.0025},
            {"start_month": 241, "end_month": 9999, "annual_rate": 0.0},
        ]
        defaults["structure"] = {
            "classes": [
                {
                    "class_id": "A",
                    "class_type": "SEQ",
                    "original_balance": 600000,
                    "current_balance": 600000,
                    "coupon_type": "FIX",
                    "coupon_fix": 0.04,
                    "priority_rank": 1,
                    "pt_group_id": None,
                },
                {
                    "class_id": "B",
                    "class_type": "SEQ",
                    "original_balance": 400000,
                    "current_balance": 400000,
                    "coupon_type": "WAC",
                    "coupon_fix": 0.0,
                    "priority_rank": 2,
                    "pt_group_id": None,
                },
            ],
            "fee_rate": 0.0,
        }

        r = client.post("/api/deals/run-inline", json=defaults)
        assert r.status_code == 200
        result = r.json()

        # Should have bond cashflows for both classes
        assert "A" in result["bond_cashflows"]
        assert "B" in result["bond_cashflows"]
        assert len(result["bond_cashflows"]["A"]) > 0
        assert len(result["bond_cashflows"]["B"]) > 0

        # Class B should have WAC coupon
        for bcf in result["bond_cashflows"]["B"]:
            if bcf["month"] > 0 and bcf["beg_bal"] > 0:
                assert bcf["coupon_rate"] == pytest.approx(0.05, abs=1e-6)


class TestDealCRUD:
    def test_create_and_get(self):
        defaults = client.get("/api/deals/defaults").json()
        defaults["deal_name"] = "Test Deal"

        r = client.post("/api/deals/create", json=defaults)
        assert r.status_code == 200
        created = r.json()
        deal_id = created["deal_id"]
        assert deal_id

        r = client.get(f"/api/deals/{deal_id}")
        assert r.status_code == 200
        assert r.json()["deal_name"] == "Test Deal"

        # Clean up
        client.delete(f"/api/deals/{deal_id}")

    def test_list_deals(self):
        r = client.get("/api/deals/list")
        assert r.status_code == 200
        assert isinstance(r.json(), list)
