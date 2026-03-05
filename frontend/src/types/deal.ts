export interface LoanInput {
  dated_date: string;
  first_settle: string;
  delay: number;
  original_face: number;
  coupon_net: number;
  wac_gross: number;
  wam: number;
  amort_wam: number;
  io_period: number;
  balloon: number;
  seasoning: number;
  lockout_months: number;
  prepayment_penalty: number[];
}

export interface LoanPricingProfile {
  amort_wam_override: number | null;
  balloon_override: number | null;
  io_period_override: number | null;
  wam_override: number | null;
}

export interface PricingInput {
  pricing_type: 'Price' | 'Yield' | 'JSpread';
  pricing_input: number;
  settle_date: string;
  curve_date: string;
}

export interface TreasuryCurvePoint {
  term: number;
  rate: number;
}

export interface TreasuryCurve {
  points: TreasuryCurvePoint[];
}

export interface PLDCurveEntry {
  start_month: number;
  end_month: number;
  annual_rate: number;
}

export interface CPJInput {
  enabled: boolean;
  cpj_speed: number;
  lockout_months: number;
  pld_curve: PLDCurveEntry[];
  pld_multiplier: number;
}

export type PrepaymentType = 'None' | 'CPJ' | 'CPR';

export interface PrepaymentAssumption {
  prepay_type: PrepaymentType;
  speed: number;
  lockout_months: number;
  pld_curve: PLDCurveEntry[];
  pld_multiplier: number;
}

export interface BondClass {
  class_id: string;
  class_type: 'SEQ' | 'PT' | 'IO';
  original_balance: number;
  current_balance: number;
  coupon_type: 'FIX' | 'WAC';
  coupon_fix: number;
  priority_rank: number;
  pt_group_id: string | null;
  pricing_type: 'Price' | 'Yield' | 'JSpread';
  pricing_input: number;
}

export interface DealStructure {
  classes: BondClass[];
  pt_share: number;
  fee_rate: number;
  prepay: PrepaymentAssumption;
}

export interface CashflowRow {
  month: number;
  date_serial: number;
  cf_date_serial: number;
  year_frac: number;
  beg_bal: number;
  pmt_to_agy: number;
  int_to_inv: number;
  int_to_agy: number;
  reg_prn: number;
  rem_prn: number;
  balloon_pay: number;
  end_bal: number;
  net_prn: number;
  net_flow: number;
  unsched_prn: number;
  total_prn: number;
  smm: number;
  annual_prepay_rate: number;
}

export interface AnalyticsOutput {
  price: number;
  accrued: number;
  yield_pct: number;
  j_spread: number;
  wal: number;
  modified_duration: number;
  convexity: number;
  risk_dpdy: number;
  tsy_rate_at_wal: number;
}

export interface BondCashflowRow {
  month: number;
  beg_bal: number;
  interest_due: number;
  interest_paid: number;
  principal_paid: number;
  end_bal: number;
  coupon_rate: number;
  penalty_income: number;
}

export interface DealResult {
  collateral_cashflows: CashflowRow[];
  collateral_analytics: AnalyticsOutput | null;
  loan_pricing_cashflows: CashflowRow[];
  loan_pricing_analytics: AnalyticsOutput | null;
  bond_collateral_cashflows: CashflowRow[];
  bond_cashflows: Record<string, BondCashflowRow[]>;
  bond_analytics: Record<string, AnalyticsOutput>;
  io_cashflows: BondCashflowRow[];
}

export interface Deal {
  deal_id: string;
  deal_name: string;
  loan: LoanInput;
  pricing: PricingInput;
  treasury_curve: TreasuryCurve;
  loan_pricing_profile: LoanPricingProfile | null;
  cpj: CPJInput;
  structure: DealStructure;
  result: DealResult | null;
}
