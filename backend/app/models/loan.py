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
    JSPREAD = "JSpread"


class PrepaymentType(str, Enum):
    NONE = "None"
    CPJ = "CPJ"
    CPR = "CPR"


class LoanInput(BaseModel):
    """Loan-level input with per-loan pricing and override fields."""

    dated_date: date = Field(description="Dated date (Excel F8)")
    first_settle: date = Field(description="First settlement date (Excel F9)")
    delay: int = Field(default=44, description="Payment delay days (Excel F10)")
    original_face: float = Field(default=1_000_000.0, description="Original face (Excel F11)")
    coupon_net: float = Field(default=0.05, description="Net coupon rate (Excel F13)")
    wac_gross: float = Field(default=0.0525, description="Gross WAC rate (Excel F14)")
    wam: int = Field(default=480, description="Weighted average maturity months (Excel F15)")
    amort_wam: int = Field(default=480, description="Amortization WAM months (Excel F16)")
    io_period: Optional[int] = Field(default=None, description="Interest-only period months (None = no IO)")
    balloon: Optional[int] = Field(default=None, description="Balloon month (None = no balloon, fully amortizing)")
    seasoning: int = Field(default=0, description="Seasoning months (Excel F19)")
    lockout_months: Optional[int] = Field(default=None, description="Lockout months for CPJ (None = no lockout)")
    prepayment_penalty: list[float] = Field(
        default_factory=list,
        description="Declining annual penalty schedule, e.g. [10,9,8,7,6,5,4,3,2,1]",
    )

    # Per-loan pricing assumptions (for collateral analytics)
    pricing_type: PricingType = PricingType.PRICE
    pricing_input: float = Field(default=100.0, description="Price or yield input")
    settle_date: Optional[date] = Field(None, description="Settlement date (per-loan)")

    # Per-loan pricing overrides (for loan pricing analytics, not waterfall)
    lp_amort_wam: Optional[int] = Field(None, description="Loan pricing: override amort WAM")
    lp_balloon: Optional[int] = Field(None, description="Loan pricing: override balloon")
    lp_io_period: Optional[int] = Field(None, description="Loan pricing: override IO period")
    lp_wam: Optional[int] = Field(None, description="Loan pricing: override WAM")


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


class PrepaymentAssumption(BaseModel):
    """Prepayment assumption for bond waterfall cashflow generation."""

    prepay_type: PrepaymentType = PrepaymentType.NONE
    speed: float = Field(default=15.0, description="CPJ speed or CPR in %")
    lockout_months: int = Field(default=0, description="Lockout months (CPJ only)")
    pld_curve: list[PLDCurveEntry] = Field(default_factory=list)
    pld_multiplier: float = Field(default=1.0, description="PLD curve multiplier (CPJ only)")


class BondClass(BaseModel):
    class_id: str
    class_type: BondClassType
    original_balance: float = 0.0
    current_balance: float = 0.0
    coupon_type: CouponType = CouponType.FIX
    coupon_fix: float = 0.0
    priority_rank: int = 0
    pt_group_id: Optional[str] = None
    pricing_type: PricingType = PricingType.PRICE
    pricing_input: float = 100.0
    penalty_pct: Optional[float] = None


class DealStructure(BaseModel):
    classes: list[BondClass] = []
    fee_rate: float = Field(default=0.0, description="Annual fee rate on collateral balance")
    prepay: PrepaymentAssumption = PrepaymentAssumption()


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
    unsched_prn_vol: float = 0.0  # Voluntary prepayment (CPR component)
    unsched_prn_inv: float = 0.0  # Involuntary prepayment (PLD/default component)
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
    sched_prn: float = 0.0
    prepaid_prn: float = 0.0
    default_prn: float = 0.0
    end_bal: float = 0.0
    coupon_rate: float = 0.0
    penalty_income: float = 0.0


class DealResult(BaseModel):
    collateral_cashflows: list[CashflowRow] = []
    collateral_analytics: Optional[AnalyticsOutput] = None
    per_loan_analytics: list[Optional[AnalyticsOutput]] = []
    per_loan_current_faces: list[float] = []
    loan_pricing_cashflows: list[CashflowRow] = []
    loan_pricing_analytics: Optional[AnalyticsOutput] = None
    per_loan_pricing_analytics: list[Optional[AnalyticsOutput]] = []
    bond_collateral_cashflows: list[CashflowRow] = []
    bond_cashflows: dict[str, list[BondCashflowRow]] = {}
    bond_analytics: dict[str, AnalyticsOutput] = {}
    io_cashflows: list[BondCashflowRow] = []


class Deal(BaseModel):
    deal_id: str = ""
    deal_name: str = ""
    loans: list[LoanInput] = []
    loan: Optional[LoanInput] = None  # backward compat
    pricing: PricingInput
    treasury_curve: TreasuryCurve = TreasuryCurve()
    loan_pricing_profile: Optional[LoanPricingProfile] = None  # backward compat
    cpj: CPJInput = CPJInput()
    structure: DealStructure = DealStructure()
    result: Optional[DealResult] = None

    def get_loans(self) -> list[LoanInput]:
        """Resolve loans list with backward compatibility."""
        if self.loans:
            return self.loans
        if self.loan:
            return [self.loan]
        return []
