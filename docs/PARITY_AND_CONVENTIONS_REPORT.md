# GNR Deal Maker — Model Parity & Conventions Report

## 1. Excel Workbook Mapping

### Source: `Ginnie_Project_Loan_Maker.xlsm` — Sheet: "CL Model"

### Input Mapping

| Web Input | Excel Cell | Named Range | Default Value |
|---|---|---|---|
| `loan.dated_date` | F8 | `_xlpm.settle` (input) | 2026-03-01 (serial 46082) |
| `loan.first_settle` | F9 | `_xlpm.settle` | 2026-03-01 (serial 46082) |
| `loan.delay` | F10 | `_xlpm.delay` | 44 |
| `loan.original_face` | F11 | `_xlpm.origbal` | 1,000,000 |
| `loan.coupon_net` | F13 | `_xlpm.nwac` | 0.05 (5.00%) |
| `loan.wac_gross` | F14 | `_xlpm.gwac` | 0.0525 (5.25%) |
| `loan.wam` | F15 | `_xlpm.wam` | 480 |
| `loan.amort_wam` | F16 | `_xlpm.amortwam` | 480 |
| `loan.io_period` | F17 | `_xlpm.io` | 0 |
| `loan.balloon` | F18 | `_xlpm.balloon` | 120 |
| `loan.seasoning` | F19 | `_xlpm.seas` | 0 |
| `pricing.pricing_type` | I9 | — | "Price" |
| `pricing.pricing_input` | I8 | — | 100 |
| `pricing.settle_date` | I10 | — | 2026-03-03 (serial 46084) |
| `pricing.curve_date` | I11 | — | 2026-03-03 (serial 46084) |

### Output Mapping

| Web Output | Excel Cell/Table | Formula Source |
|---|---|---|
| Cashflow Table (121 rows) | Rows 32–152, Columns E–R | `LoanAmortTbl` LAMBDA |
| Price | I13 | Pricing engine |
| Accrued Interest | I14 | 2-day accrued at net coupon |
| Yield (%) | I15 | Newton-Raphson solver (BEY) |
| J-Spread (bp) | I16 | Yield – TSY interpolation at WAL |
| WAL | I17 | Sum(NetPrn × YF_30/360) / Sum(NetPrn) |
| Modified Duration | I18 | Finite difference: ±1bp |
| Convexity | I19 | Finite difference: ±1bp |
| Risk (dP/dY) | I20 | Dollar duration |
| Tsy Rate @ WAL | I21 | Linear interpolation of curve at WAL |

### Cashflow Column Mapping

| Web Field | Excel Column | Header | LAMBDA Variable |
|---|---|---|---|
| `month` | E | Month | `_xlpm.mo` |
| `date_serial` | F | Date | `_xlpm.dt` |
| `cf_date_serial` | G | CF Date | `_xlpm.cfdt` |
| `year_frac` | H | Year Frac | `_xlpm.yrfrac` |
| `beg_bal` | I | Beg Bal | `_xlpm.begbal` |
| `pmt_to_agy` | J | Pmt to Agy | `_xlpm.pmtagy` |
| `int_to_inv` | K | Int to Inv | `_xlpm.intinv` |
| `int_to_agy` | L | Int to Agy | `_xlpm.intagy` |
| `reg_prn` | M | Reg Prn | `_xlpm.regprn` |
| `rem_prn` | N | Rem Prn | `_xlpm.remprn` |
| `balloon_pay` | O | Balloon | `_xlpm.balloonpay` |
| `end_bal` | P | End Bal | `_xlpm.endbal` |
| `net_prn` | Q | Net Prn | `_xlpm.netprn` |
| `net_flow` | R | Net Flow | `_xlpm.netflow` |

### Key Intermediate Calculations

| Calculation | Excel Location | Formula |
|---|---|---|
| Monthly gross rate | LAMBDA | `gr = gwac / 12` |
| Monthly net rate | LAMBDA | `nr = nwac / 12` |
| Remaining balloon periods | LAMBDA | `rembal = max(0, balloon - seas)` |
| Payment amount | LAMBDA | `pmt = PMT(gr, amortwam, -origbal)` |
| Total months from issue | LAMBDA | `totmo = seas + mo` |
| Amortization periods elapsed | LAMBDA | `k = max(0, totmo - io - 1)` |
| Balance tolerance | LAMBDA | `tol = 0.000001` |

### Beginning Balance Formula

```
if totmo <= io:        begbal = origbal               (IO period)
elif k == 0:           begbal = origbal               (first amort month)
else:                  begbal = origbal*(1+gr)^k - pmt*((1+gr)^k - 1)/gr
```

### Date Formulas

```
dt   = EDATE(settle, mo)                              (payment date)
cfdt = EOMONTH(settle, mo-1) + delay - 29             (cashflow date with Ginnie delay)
```

## 2. CPJ Definition and Formulas

### What is CPJ?

CPJ (Constant Prepayment Joint) is the market-standard prepayment convention for Ginnie Mae Project Loan (GNPL) securities. It combines:

1. **PLD curve** (involuntary prepayments/defaults) — always active
2. **Constant CPR** (voluntary prepayments) — active only AFTER lockout

### Formal Definition

For each loan ℓ at month t:

```
AgeMonths(ℓ,t) = months since loan issue at period t
PLD_ann(ℓ,t)   = PLD annual rate for AgeMonths(ℓ,t)
CPR_ann         = voluntary CPR (e.g., 0.15 for 15 CPJ)
```

**Annual prepay rate:**
```
if AgeMonths(ℓ,t) ≤ LockoutMonths:
    AnnualPrepayRate(ℓ,t) = PLD_ann(ℓ,t)
else:
    AnnualPrepayRate(ℓ,t) = PLD_ann(ℓ,t) + CPR_ann
```

**Monthly SMM:**
```
SMM(ℓ,t) = 1 - (1 - AnnualPrepayRate(ℓ,t))^(1/12)
```

**Application to balance:**
```
PrepayableBal(ℓ,t)   = max(0, BegBal(ℓ,t) - ScheduledPrin(ℓ,t))
UnscheduledPrin(ℓ,t)  = PrepayableBal(ℓ,t) × SMM(ℓ,t)
TotalPrin(ℓ,t)        = min(BegBal(ℓ,t), ScheduledPrin(ℓ,t) + UnscheduledPrin(ℓ,t))
EndBal(ℓ,t)           = BegBal(ℓ,t) - TotalPrin(ℓ,t)
```

**Example — 15 CPJ with 24-month lockout:**
- Months 1–24: Only PLD applies (e.g., 1.30% annual in months 1–12)
- Months 25+: PLD + 15% CPR (e.g., 2.51% + 15% = 17.51% annual in months 25–36)

### Parity Safeguard

When CPJ is OFF (disabled), `UnscheduledPrin = 0` for all months, producing identical cashflows to the Excel workbook contractual schedule.

## 3. PLD Curve Table

| Age Bucket (Months) | Annual Rate |
|---|---|
| 1–12 | 1.30% |
| 13–24 | 2.47% |
| 25–36 | 2.51% |
| 37–48 | 2.20% |
| 49–60 | 2.13% |
| 61–72 | 1.46% |
| 73–84 | 1.26% |
| 85–96 | 0.80% |
| 97–108 | 0.57% |
| 109–168 | 0.50% |
| 169–240 | 0.25% |
| 241–maturity | 0.00% |

- **Mortgage Loan Age** = months since loan issue date
- PLD curve applies at 100% by default (multiplier = 1.0)
- Multiplier is editable in the UI
- PLD rates are editable row-by-row in the UI

## 4. WAC Coupon Definition

### Formula

For each month t, the pool Weighted Average Coupon is:

```
PoolWAC(t) = Σ(BegBal(ℓ,t) × LoanCoupon(ℓ)) / Σ(BegBal(ℓ,t))
```

Where:
- `BegBal(ℓ,t)` = beginning balance of loan ℓ at month t
- `LoanCoupon(ℓ)` = contractual net coupon rate of loan ℓ
- Sum is over all loans ℓ with `BegBal(ℓ,t) > 0`

### Bond Coupon Application

| Coupon Type | Rate Used |
|---|---|
| FIX | `r(k,t) = coupon_fix(k)` — constant |
| WAC | `r(k,t) = PoolWAC(t)` — resets monthly |

### Interest Due Calculation

```
InterestDue(k,t) = BegBondBal(k,t) × r(k,t) / 12
```

### Validation

For WAC classes, unit tests verify that `r(k,t) == PoolWAC(t)` within tolerance at every month.

## 5. Tolerance Policy

| Metric | Tolerance | Basis |
|---|---|---|
| Cashflow amounts (balance, principal, interest) | abs ≤ 0.01 | Sub-penny |
| Rates (coupon, yield) | abs ≤ 1e-6 | Sub-basis-point |
| Date serials | Exact match | Integer |
| Year fractions | abs ≤ 1e-10 | Floating point |
| WAL | abs ≤ 0.001 | 30/360 day count matching |
| Yield (from par price) | abs ≤ 0.01 | BEY convention |
| J-Spread | abs ≤ 1.0 bp | Depends on yield accuracy |
| Duration | abs ≤ 0.1 | Finite difference method |

### Summary Total Tolerances (from Row 30)

| Total | Excel Value | Tolerance |
|---|---|---|
| Sum(Pmt to Agy) | 598,644.40 | ±0.01 |
| Sum(Int to Inv) | 478,153.93 | ±0.01 |
| Sum(Int to Agy) | 502,061.63 | ±0.01 |
| Sum(Reg Prn) | 96,582.77 | ±0.01 |
| Sum(Balloon) | 903,417.23 | ±0.01 |
| Sum(Net Prn) | 1,000,000.00 | ±0.01 |
| Sum(Net Flow) | 1,478,153.93 | ±0.01 |

## 6. Discounting Convention

- **Day count**: 30/360 for WAL; Actual/365.25 for PV discounting
- **Compounding**: Semi-annual (Bond Equivalent Yield convention)
- **Discount factor**: `DF(t) = (1 + y/2)^(2 × yf)` where `yf = (cfdt - settle) / 365.25`
- **Accrued**: `(days / 360) × coupon × face` using actual days from dated date

## 7. Treasury Curve (Default)

| Term | Rate (%) |
|---|---|
| 1 month | 3.564 |
| 2 months | 3.698 |
| 3 months | 3.682 |
| 4 months | 3.673 |
| 6 months | 3.633 |
| 1 year | 3.564 |
| 2 years | 3.513 |
| 3 years | 3.521 |
| 5 years | 3.649 |
| 7 years | 3.846 |
| 10 years | 4.070 |
| 20 years | 4.665 |
| 30 years | 4.716 |

Interpolation: linear between points.
