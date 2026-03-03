"""Loan and deal data models for GNR Deal Maker."""

from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class CouponType(str, Enum):
    FIX = "FIX"
    WAC = "WAC"


class BondClassType(str, Enum):
    SEQ = "SEQ"
    PT = "PT"
    IO = "IO"


class PricingType(str, Enum):
    PRICE = "Price"
    YIELD = "Yield"


class LoanInput(BaseModel):
    """Mirrors Excel workbook input cells exactly."""

    dated_date: date = Field(description="Dated date (Excel F8)")
    first_settle: date = Field(description="First settlement date (Excel F9)")
    delay: int = Field(default=44, description="Payment delay days (Excel F10)")
    original_face: float = Field(default=1_000_000.0, description="Original face (Excel F11)")
    coupon_net: float = Field(default=0.05, description="Net coupon rate (Excel F13)")
    wac_gross: float = Field(default=0.0525, description="Gross WAC rate (Excel F14)")
    wam: int = Field(default=480, description="Weighted average maturity months (Excel F15)")
    amort_wam: int = Field(default=480, description="Amortization WAM months (Excel F16)")
    io_period: int = Field(default=0, description="Interest-only period months (Excel F17)")
    balloon: int = Field(default=120, description="Balloon month (Excel F18)")
    seasoning: int = Field(default=0, description="Seasoning months (Excel F19)")
    lockout_months: int = Field(default=0, description="Lockout months for CPJ")


class LoanPricingProfile(BaseModel):
    """Override profile for loan pricing convention (market mode)."""

    amort_wam_override: Optional[int] = Field(None, description="Override amortization WAM")
    balloon_override: Optional[int] = Field(None, description="Override balloon month")
    io_period_override: Optional[int] = Field(None, description="Override IO period")
    wam_override: Optional[int] = Field(None, description="Override WAM")


class PricingInput(BaseModel):
    """Pricing parameters (Excel H8-I11)."""

    pricing_type: PricingType = PricingType.PRICE
    pricing_input: float = Field(default=100.0, description="Price or yield input")
    settle_date: date = Field(description="Settlement date (Excel I10)")
    curve_date: date = Field(description="Curve date (Excel I11)")


class TreasuryCurvePoint(BaseModel):
    term: float  # in years
    rate: float  # in percent (e.g., 3.564)


class TreasuryCurve(BaseModel):
    points: list[TreasuryCurvePoint] = []


class PLDCurveEntry(BaseModel):
    start_month: int
    end_month: int
    annual_rate: float


class CPJInput(BaseModel):
    """CPJ prepayment overlay specification."""

    enabled: bool = False
    cpj_speed: float = Field(default=15.0, description="CPJ speed (e.g., 15 means 15 CPJ)")
    lockout_months: int = Field(default=0, description="Lockout months for voluntary CPR")
    pld_curve: list[PLDCurveEntry] = Field(default_factory=list)
    pld_multiplier: float = Field(default=1.0, description="PLD curve multiplier")


class BondClass(BaseModel):
    class_id: str
    class_type: BondClassType
    original_balance: float = 0.0
    current_balance: float = 0.0
    coupon_type: CouponType = CouponType.FIX
    coupon_fix: float = 0.0
    priority_rank: int = 0
    pt_group_id: Optional[str] = None


class DealStructure(BaseModel):
    classes: list[BondClass] = []
    pt_share: float = Field(default=0.0, ge=0.0, le=1.0)
    fee_rate: float = Field(default=0.0, description="Annual fee rate on collateral balance")


class CashflowRow(BaseModel):
    month: int
    date_serial: int
    cf_date_serial: int
    year_frac: float
    beg_bal: float
    pmt_to_agy: float
    int_to_inv: float
    int_to_agy: float
    reg_prn: float
    rem_prn: float
    balloon_pay: float
    end_bal: float
    net_prn: float
    net_flow: float
    # CPJ fields (filled when CPJ active)
    unsched_prn: float = 0.0
    total_prn: float = 0.0
    smm: float = 0.0
    annual_prepay_rate: float = 0.0


class AnalyticsOutput(BaseModel):
    price: float = 0.0
    accrued: float = 0.0
    yield_pct: float = 0.0
    j_spread: float = 0.0
    wal: float = 0.0
    modified_duration: float = 0.0
    convexity: float = 0.0
    risk_dpdy: float = 0.0
    tsy_rate_at_wal: float = 0.0


class BondCashflowRow(BaseModel):
    month: int
    beg_bal: float = 0.0
    interest_due: float = 0.0
    interest_paid: float = 0.0
    principal_paid: float = 0.0
    end_bal: float = 0.0
    coupon_rate: float = 0.0


class DealResult(BaseModel):
    collateral_cashflows: list[CashflowRow] = []
    collateral_analytics: Optional[AnalyticsOutput] = None
    loan_pricing_cashflows: list[CashflowRow] = []
    loan_pricing_analytics: Optional[AnalyticsOutput] = None
    bond_collateral_cashflows: list[CashflowRow] = []
    bond_cashflows: dict[str, list[BondCashflowRow]] = {}
    bond_analytics: dict[str, AnalyticsOutput] = {}
    io_cashflows: list[BondCashflowRow] = []


class Deal(BaseModel):
    deal_id: str = ""
    deal_name: str = ""
    loan: LoanInput
    pricing: PricingInput
    treasury_curve: TreasuryCurve = TreasuryCurve()
    loan_pricing_profile: Optional[LoanPricingProfile] = None
    cpj: CPJInput = CPJInput()
    structure: DealStructure = DealStructure()
    result: Optional[DealResult] = None
