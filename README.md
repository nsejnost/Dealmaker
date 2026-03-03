# GNR Deal Maker

Deal structuring and analytics tool for Ginnie Mae Multifamily / Project Loan Agency CMBS (GNR REMIC).

## Features

- **Spreadsheet Parity**: Contractual loan cashflows match the Excel workbook (`Ginnie_Project_Loan_Maker.xlsm`) within sub-penny tolerances
- **CPJ Prepayment Convention**: Market-standard GNPL prepayment model (PLD + voluntary CPR with lockout)
- **Dual Valuation**: Independent loan pricing (market convention) and bond pricing (contractual + CPJ) streams
- **Bond Structuring**: SEQ, PT, and IO classes with FIX and WAC coupon types
- **Waterfall Engine**: Sequential and pro-rata principal allocation with IO excess interest
- **Analytics**: Price, yield (BEY), WAL, modified duration, convexity, J-spread, scenario grids
- **Visualization**: Cashflow charts, capital stack diagram, waterfall logic display

## Quick Start

### Backend (Python FastAPI)

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

API available at `http://localhost:8000`. Swagger docs at `http://localhost:8000/docs`.

### Frontend (React + TypeScript)

```bash
cd frontend
npm install
npm run dev
```

UI available at `http://localhost:3000`.

### Run Tests

```bash
cd backend
python -m pytest tests/ -v
```

All 65 tests should pass, covering:
- Spreadsheet parity (cashflows, dates, totals, analytics)
- CPJ overlay (lockout, rate construction, SMM, invariants)
- WAC coupon (pool WAC computation, monthly reset)
- Waterfall (SEQ, PT, IO, reconciliation)
- Dual valuation modes

## Project Structure

```
GNR_Deal_Maker/
├── backend/
│   ├── app/
│   │   ├── engines/
│   │   │   ├── cashflow_engine.py    # Contractual + CPJ cashflows
│   │   │   ├── analytics_engine.py   # PV, yield, WAL, duration
│   │   │   ├── waterfall_engine.py   # Bond waterfall (SEQ/PT/IO)
│   │   │   └── deal_runner.py        # Orchestrator
│   │   ├── models/
│   │   │   └── loan.py               # Pydantic data models
│   │   ├── routers/
│   │   │   └── deals.py              # API endpoints
│   │   ├── data/
│   │   │   └── defaults.py           # Default data (PLD, TSY curves)
│   │   └── main.py                   # FastAPI app
│   ├── tests/
│   │   ├── test_spreadsheet_parity.py
│   │   ├── test_cpj.py
│   │   └── test_wac_and_waterfall.py
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── components/               # React components
│   │   ├── types/                     # TypeScript types
│   │   ├── api/                       # API client
│   │   ├── App.tsx                    # Main app
│   │   └── main.tsx                   # Entry point
│   ├── package.json
│   └── vite.config.ts
├── docs/
│   └── PARITY_AND_CONVENTIONS_REPORT.md
├── sample_deals/
│   ├── 01_contractual_parity.json
│   ├── 02_bond_15cpj.json
│   └── 03_fix_vs_wac_coupons.json
├── golden_cashflows.json              # Excel golden outputs for testing
└── Ginnie_Project_Loan_Maker.xlsm     # Source Excel workbook
```

## Documentation

- [Parity & Conventions Report](docs/PARITY_AND_CONVENTIONS_REPORT.md) — Excel mapping, CPJ definition, PLD curve, WAC formula, tolerance policy

## Sample Deals

1. **Contractual Parity** — Default deal matching Excel exactly, CPJ OFF
2. **Bond with 15 CPJ** — Two SEQ classes + IO, 24-month lockout
3. **FIX vs WAC Coupons** — Demonstrates constant vs floating bond coupons

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/deals/defaults` | Default deal parameters |
| POST | `/api/deals/create` | Create a deal |
| GET | `/api/deals/list` | List saved deals |
| GET | `/api/deals/{id}` | Get deal by ID |
| PUT | `/api/deals/{id}` | Update deal |
| POST | `/api/deals/{id}/run` | Run deal computation |
| POST | `/api/deals/run-inline` | Run without saving |
| POST | `/api/deals/{id}/scenarios` | Scenario grid |
| GET | `/api/deals/{id}/export/cashflows` | Export cashflows |
| POST | `/api/deals/{id}/clone` | Clone deal |
| DELETE | `/api/deals/{id}` | Delete deal |
| GET | `/api/deals/pld-curve` | Default PLD curve |
| GET | `/api/deals/tsy-curve` | Default treasury curve |
