import React, { useState, useEffect, useCallback } from 'react';
import type { Deal, DealResult, BondClass, PLDCurveEntry, PrepaymentType, LoanInput, CashflowRow, BondCashflowRow, AnalyticsOutput } from './types/deal';
import { dealApi } from './api/dealApi';
import { CashflowChart } from './components/CashflowChart';
import { BondCashflowChart } from './components/BondCashflowChart';
import * as XLSX from 'xlsx';

/* ── helpers ─────────────────────────────────────────────────── */

const EXCEL_EPOCH = Date.UTC(1899, 11, 30); // Excel 1900 date system

function serialToDate(serial: number): string {
  if (!serial || serial < 1) return '';
  const d = new Date(EXCEL_EPOCH + serial * 86400000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${mm}-${dd}-${yyyy}`;
}

const fmt = (n: number, dec = 2) => n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fmtPct = (n: number, dec = 4) => (n * 100).toFixed(dec) + '%';

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function normalizeDate(s: string): string {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return s;
}

function parsePenaltyString(s: string): number[] {
  if (!s.trim()) return [];
  return s.split('-').map(v => parseFloat(v.trim())).filter(v => !isNaN(v));
}

function penaltyToString(arr: number[]): string {
  if (!arr || arr.length === 0) return '';
  return arr.join('-');
}

function termLabel(term: number): string {
  if (term < 1) return `${(term * 12).toFixed(0)}m`;
  return `${term}y`;
}

function fmtComma(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function parseComma(s: string): number {
  return parseFloat(s.replace(/,/g, '')) || 0;
}

function parseTenor(s: string): number | null {
  const t = s.trim().toUpperCase();
  const mMatch = t.match(/^(\d+(?:\.\d+)?)\s*M$/);
  if (mMatch) return parseFloat(mMatch[1]) / 12;
  const yMatch = t.match(/^(\d+(?:\.\d+)?)\s*Y$/);
  if (yMatch) return parseFloat(yMatch[1]);
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

function BlurInput({ value, format, parse, ...props }: {
  value: any; format: (v: any) => string; parse: (s: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'>) {
  const [local, setLocal] = React.useState<string | null>(null);
  return <input {...props}
    value={local !== null ? local : format(value)}
    onChange={e => setLocal(e.target.value)}
    onBlur={() => { if (local !== null) { parse(local); setLocal(null); } }}
    onFocus={e => setLocal(e.target.value)} />;
}

/* ── defaults ────────────────────────────────────────────────── */

const defaultPLD: PLDCurveEntry[] = [
  { start_month: 1, end_month: 12, annual_rate: 0.0130 },
  { start_month: 13, end_month: 24, annual_rate: 0.0247 },
  { start_month: 25, end_month: 36, annual_rate: 0.0251 },
  { start_month: 37, end_month: 48, annual_rate: 0.0220 },
  { start_month: 49, end_month: 60, annual_rate: 0.0213 },
  { start_month: 61, end_month: 72, annual_rate: 0.0146 },
  { start_month: 73, end_month: 84, annual_rate: 0.0126 },
  { start_month: 85, end_month: 96, annual_rate: 0.0080 },
  { start_month: 97, end_month: 108, annual_rate: 0.0057 },
  { start_month: 109, end_month: 168, annual_rate: 0.0050 },
  { start_month: 169, end_month: 240, annual_rate: 0.0025 },
  { start_month: 241, end_month: 9999, annual_rate: 0.0000 },
];

function makeDefaultLoan(): LoanInput {
  return {
    dated_date: '2026-03-01',
    first_settle: '2026-03-01',
    delay: 44,
    original_face: 1000000,
    coupon_net: 0.05,
    wac_gross: 0.0525,
    wam: 480,
    amort_wam: 480,
    io_period: null,
    balloon: null,
    seasoning: 0,
    lockout_months: null,
    prepayment_penalty: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    pricing_type: 'Price',
    pricing_input: 100,
    settle_date: '2026-03-03',
    lp_amort_wam: 480,
    lp_balloon: 120,
    lp_io_period: null,
    lp_wam: 480,
  };
}

function makeDefaultDeal(): Deal {
  const loan = makeDefaultLoan();
  return {
    deal_id: '',
    deal_name: 'New Deal',
    loans: [loan],
    loan: loan,
    pricing: {
      pricing_type: 'Price',
      pricing_input: 100,
      settle_date: '2026-03-03',
      curve_date: '2026-03-03',
    },
    treasury_curve: { points: [
      { term: 0.0833, rate: 3.564 }, { term: 0.1667, rate: 3.698 },
      { term: 0.25, rate: 3.682 }, { term: 0.3333, rate: 3.673 },
      { term: 0.5, rate: 3.633 }, { term: 1, rate: 3.564 },
      { term: 2, rate: 3.513 }, { term: 3, rate: 3.521 },
      { term: 5, rate: 3.649 }, { term: 7, rate: 3.846 },
      { term: 10, rate: 4.07 }, { term: 20, rate: 4.665 },
      { term: 30, rate: 4.716 },
    ]},
    loan_pricing_profile: null,
    cpj: {
      enabled: false,
      cpj_speed: 15,
      lockout_months: 0,
      pld_curve: defaultPLD,
      pld_multiplier: 1.0,
    },
    structure: {
      classes: [],
      fee_rate: 0,
      prepay: {
        prepay_type: 'None',
        speed: 15,
        lockout_months: 0,
        pld_curve: defaultPLD,
        pld_multiplier: 1.0,
      },
    },
    result: null,
  };
}

/* ── main component ──────────────────────────────────────────── */

export default function App() {
  const [deal, setDeal] = useState<Deal>(makeDefaultDeal());
  const [result, setResult] = useState<DealResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedDeals, setSavedDeals] = useState<{deal_id: string; deal_name: string}[]>([]);
  const [showPLD, setShowPLD] = useState(false);
  const [showCharts, setShowCharts] = useState(false);
  const [showCashflows, setShowCashflows] = useState(false);
  const [showDealCashflows, setShowDealCashflows] = useState(false);
  const [showCollateral, setShowCollateral] = useState(true);
  const [activeTab, setActiveTab] = useState<'deal' | 'curve'>('deal');
  const [pasteText, setPasteText] = useState('');
  const [currentFaces, setCurrentFaces] = useState<{ original_face: number; current_face: number; factor: number }[]>([]);
  const [loadingFaces, setLoadingFaces] = useState(false);

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Track if prepay is active (new or legacy)
  const prepayActive = deal.structure.prepay.prepay_type !== 'None' || deal.cpj.enabled;

  useEffect(() => {
    dealApi.listDeals().then(setSavedDeals).catch(() => {});
  }, []);

  const CSV_HEADERS = [
    'dated_date','first_settle','delay','original_face','coupon_net','wac_gross',
    'wam','amort_wam','io_period','balloon','seasoning','lockout_months',
    'pricing_type','pricing_input','settle_date',
    'prepayment_penalty',
    'lp_amort_wam','lp_balloon','lp_io_period','lp_wam',
  ] as const;

  const downloadCsvTemplate = useCallback(() => {
    const dl = makeDefaultLoan();
    const row = [
      dl.dated_date, dl.first_settle, dl.delay, dl.original_face, dl.coupon_net * 100, dl.wac_gross * 100,
      dl.wam, dl.amort_wam, dl.io_period ?? '', dl.balloon ?? '', dl.seasoning, dl.lockout_months ?? '',
      dl.pricing_type, dl.pricing_input, dl.settle_date ?? '',
      penaltyToString(dl.prepayment_penalty),
      dl.lp_amort_wam ?? '', dl.lp_balloon ?? '', dl.lp_io_period ?? '', dl.lp_wam ?? '',
    ];
    const csv = [CSV_HEADERS.join(','), row.join(',')].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'loan_template.csv'; a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleCsvImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string;
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row.');
        const headers = parseCsvLine(lines[0]);
        const required = ['dated_date','first_settle','original_face','coupon_net','wac_gross','wam'];
        const missing = required.filter(r => !headers.includes(r));
        if (missing.length > 0) throw new Error(`Missing required columns: ${missing.join(', ')}`);
        const colIdx = Object.fromEntries(headers.map((h, i) => [h, i]));
        const get = (row: string[], col: string) => {
          const idx = colIdx[col];
          return idx !== undefined && idx < row.length ? row[idx].trim() : '';
        };
        const dl = makeDefaultLoan();
        const loans: LoanInput[] = [];
        for (let r = 1; r < lines.length; r++) {
          const vals = parseCsvLine(lines[r]);
          const str = (col: string, def: string) => get(vals, col) || def;
          const int = (col: string, def: number) => { const v = get(vals, col); return v ? parseInt(v) : def; };
          const flt = (col: string, def: number) => { const v = get(vals, col); return v ? parseFloat(v) : def; };
          const nullInt = (col: string) => { const v = get(vals, col); return v ? parseInt(v) : null; };
          const pctToDecimal = (col: string, def: number) => {
            const v = get(vals, col);
            if (!v) return def;
            const n = parseFloat(v);
            if (isNaN(n)) return def;
            return n > 0.5 ? n / 100 : n;
          };
          let pxType = str('pricing_type', 'Price');
          if (pxType === 'J-Spread' || pxType === 'J-Sprd') pxType = 'JSpread';
          loans.push({
            dated_date: normalizeDate(str('dated_date', dl.dated_date)),
            first_settle: normalizeDate(str('first_settle', dl.first_settle)),
            delay: int('delay', dl.delay),
            original_face: parseFloat((get(vals, 'original_face') || '').replace(/,/g, '')) || dl.original_face,
            coupon_net: pctToDecimal('coupon_net', dl.coupon_net),
            wac_gross: pctToDecimal('wac_gross', dl.wac_gross),
            wam: int('wam', dl.wam),
            amort_wam: int('amort_wam', dl.amort_wam),
            io_period: nullInt('io_period'),
            balloon: nullInt('balloon'),
            seasoning: int('seasoning', dl.seasoning),
            lockout_months: nullInt('lockout_months'),
            prepayment_penalty: parsePenaltyString(get(vals, 'prepayment_penalty')),
            pricing_type: (['Price','Yield','JSpread'].includes(pxType) ? pxType : 'Price') as LoanInput['pricing_type'],
            pricing_input: flt('pricing_input', dl.pricing_input),
            settle_date: get(vals, 'settle_date') ? normalizeDate(get(vals, 'settle_date')) : null,
            lp_amort_wam: nullInt('lp_amort_wam') ?? dl.lp_amort_wam,
            lp_balloon: nullInt('lp_balloon') ?? dl.lp_balloon,
            lp_io_period: nullInt('lp_io_period') ?? dl.lp_io_period,
            lp_wam: nullInt('lp_wam') ?? dl.lp_wam,
          });
        }
        if (loans.length === 0) throw new Error('No loan rows found in CSV.');
        setDeal(d => ({ ...d, loans, loan: loans[0] }));
        setResult(null);
      } catch (err: any) {
        setError(err.message);
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const runDeal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Sync backward compat fields
      const dealToRun = { ...deal, loan: deal.loans[0] || deal.loan };
      if (deal.structure.prepay.prepay_type === 'CPJ') {
        dealToRun.cpj = {
          enabled: true,
          cpj_speed: deal.structure.prepay.speed,
          lockout_months: deal.structure.prepay.lockout_months,
          pld_curve: deal.structure.prepay.pld_curve,
          pld_multiplier: deal.structure.prepay.pld_multiplier,
        };
      }
      const res = await dealApi.runInline(dealToRun);
      setResult(res);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [deal]);

  const computeCurrentFace = useCallback(async () => {
    setLoadingFaces(true);
    try {
      const dealToSend = { ...deal, loan: deal.loans[0] || deal.loan };
      const faces = await dealApi.computeCurrentFace(dealToSend);
      setCurrentFaces(faces);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingFaces(false);
    }
  }, [deal]);

  const saveDeal = useCallback(async () => {
    try {
      const saved = await dealApi.createDeal(deal);
      setDeal(saved);
      const list = await dealApi.listDeals();
      setSavedDeals(list);
    } catch (e: any) {
      setError(e.message);
    }
  }, [deal]);

  const loadDeal = useCallback(async (id: string) => {
    try {
      const d = await dealApi.getDeal(id);
      // Ensure new fields exist for backward compat
      if (!d.structure.prepay) {
        d.structure.prepay = {
          prepay_type: d.cpj?.enabled ? 'CPJ' : 'None',
          speed: d.cpj?.cpj_speed ?? 15,
          lockout_months: d.cpj?.lockout_months ?? 0,
          pld_curve: d.cpj?.pld_curve ?? defaultPLD,
          pld_multiplier: d.cpj?.pld_multiplier ?? 1.0,
        };
      }
      // Migrate single loan to loans array
      if (!d.loans || d.loans.length === 0) {
        const baseLoan = d.loan || makeDefaultLoan();
        if (!baseLoan.prepayment_penalty) baseLoan.prepayment_penalty = [];
        if (!baseLoan.pricing_type) baseLoan.pricing_type = d.pricing?.pricing_type ?? 'Price';
        if (baseLoan.pricing_input === undefined) baseLoan.pricing_input = d.pricing?.pricing_input ?? 100;
        if (!baseLoan.settle_date) baseLoan.settle_date = d.pricing?.settle_date ?? '2026-03-03';
        if (baseLoan.lp_amort_wam === undefined) baseLoan.lp_amort_wam = d.loan_pricing_profile?.amort_wam_override ?? null;
        if (baseLoan.lp_balloon === undefined) baseLoan.lp_balloon = d.loan_pricing_profile?.balloon_override ?? null;
        if (baseLoan.lp_io_period === undefined) baseLoan.lp_io_period = d.loan_pricing_profile?.io_period_override ?? null;
        if (baseLoan.lp_wam === undefined) baseLoan.lp_wam = d.loan_pricing_profile?.wam_override ?? null;
        d.loans = [baseLoan];
        d.loan = baseLoan;
      } else {
        // Ensure per-loan fields exist
        d.loans = d.loans.map((l: any) => ({
          ...makeDefaultLoan(),
          ...l,
          prepayment_penalty: l.prepayment_penalty || [],
        }));
        d.loan = d.loans[0];
      }
      setDeal(d);
      setResult(d.result || null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const exportCSV = useCallback((rows: any[], filename: string) => {
    if (!rows.length) return;
    const keys = Object.keys(rows[0]);
    const csv = [keys.join(','), ...rows.map(r => keys.map(k => r[k]).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }, []);

  const exportWorkbook = useCallback(() => {
    const wb = XLSX.utils.book_new();

    // Tab 1: Loan Collateral
    const loanRows = deal.loans.map((l, i) => ({
      'Dated Date': l.dated_date,
      '1st Settle': l.first_settle,
      'Delay': l.delay,
      'Original Face': l.original_face,
      'Current Face': result?.per_loan_current_faces?.[i] ?? currentFaces[i]?.current_face ?? '',
      'Factor': currentFaces[i]?.factor ?? '',
      'Net Coupon': l.coupon_net,
      'WAC Gross': l.wac_gross,
      'WAM': l.wam,
      'Amort WAM': l.amort_wam,
      'IO Period': l.io_period ?? '',
      'Balloon': l.balloon ?? '',
      'Seasoning': l.seasoning,
      'Lockout': l.lockout_months ?? '',
      'Pricing Type': l.pricing_type,
      'Pricing Input': l.pricing_input,
      'Settle Date': l.settle_date ?? '',
      'Penalty Schedule': l.prepayment_penalty.join('-'),
      'LP Amort': l.lp_amort_wam ?? '',
      'LP Balloon': l.lp_balloon ?? '',
      'LP IO': l.lp_io_period ?? '',
      'LP WAM': l.lp_wam ?? '',
      ...(result?.per_loan_analytics?.[i] ? {
        'Price': result.per_loan_analytics[i]!.price,
        'Yield': result.per_loan_analytics[i]!.yield_pct,
        'J-Spread': result.per_loan_analytics[i]!.j_spread,
        'WAL': result.per_loan_analytics[i]!.wal,
        'Duration': result.per_loan_analytics[i]!.modified_duration,
        'Convexity': result.per_loan_analytics[i]!.convexity,
        'Risk': result.per_loan_analytics[i]!.risk_dpdy,
        'Tsy Rate': result.per_loan_analytics[i]!.tsy_rate_at_wal,
      } : {}),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(loanRows), 'Loans');

    // Tab 2: Bond Structure
    const bondRows = deal.structure.classes.map(cls => {
      const ba = result?.bond_analytics[cls.class_id];
      return {
        'Class ID': cls.class_id,
        'Type': cls.class_type,
        'Balance': cls.original_balance,
        'Coupon Type': cls.coupon_type,
        'Rate': cls.coupon_fix,
        'Priority': cls.priority_rank,
        'Pricing Type': cls.pricing_type,
        'Pricing Input': cls.pricing_input,
        'Penalty %': cls.penalty_pct ?? '',
        ...(ba ? {
          'Price': ba.price,
          'Yield': ba.yield_pct,
          'J-Spread': ba.j_spread,
          'WAL': ba.wal,
          'Duration': ba.modified_duration,
          'Convexity': ba.convexity,
          'Risk': ba.risk_dpdy,
        } : {}),
      };
    });
    if (bondRows.length > 0) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bondRows), 'Bonds');

    // Tab 3: Deal Settings
    const settingsRows = [
      { Setting: 'Deal Name', Value: deal.deal_name },
      { Setting: 'Settle Date', Value: deal.pricing.settle_date },
      { Setting: 'Curve Date', Value: deal.pricing.curve_date },
      { Setting: 'Pricing Type', Value: deal.pricing.pricing_type },
      { Setting: 'Pricing Input', Value: deal.pricing.pricing_input },
      { Setting: 'Fee Rate', Value: deal.structure.fee_rate },
      { Setting: 'Prepay Type', Value: deal.structure.prepay.prepay_type },
      { Setting: 'Prepay Speed', Value: deal.structure.prepay.speed },
      { Setting: 'Lockout Months', Value: deal.structure.prepay.lockout_months },
      { Setting: 'PLD Multiplier', Value: deal.structure.prepay.pld_multiplier },
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(settingsRows), 'Settings');

    // Tab 4: Treasury Curve
    const tsyRows = deal.treasury_curve.points.map(p => ({ Term: p.term, Rate: p.rate }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tsyRows), 'Treasury Curve');

    // Tab 5: PLD Curve
    if (deal.structure.prepay.prepay_type === 'CPJ') {
      const pldRows = deal.structure.prepay.pld_curve.map(e => ({
        'Start Month': e.start_month,
        'End Month': e.end_month,
        'Annual Rate': e.annual_rate,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pldRows), 'PLD Curve');
    }

    // Tab 6: Collateral Cashflows
    if (result && result.collateral_cashflows.length > 0) {
      const cfRows = result.collateral_cashflows.map(cf => ({
        Month: cf.month,
        Date: serialToDate(cf.date_serial),
        'CF Date': serialToDate(cf.cf_date_serial),
        'Yr Frac': cf.year_frac,
        'Beg Bal': cf.beg_bal,
        'Pmt Agy': cf.pmt_to_agy,
        'Int Inv': cf.int_to_inv,
        'Int Agy': cf.int_to_agy,
        'Sched Prn': cf.reg_prn + cf.balloon_pay,
        'Prepaid': cf.unsched_prn_vol,
        'Defaulted': cf.unsched_prn_inv,
        'Total Prn': cf.net_prn,
        'End Bal': cf.end_bal,
        'Net Flow': cf.net_flow,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(cfRows), 'Collateral CFs');
    }

    // Tab 7: Bond Collateral Cashflows (with prepay)
    if (result && result.bond_collateral_cashflows.length > 0) {
      const bcfRows = result.bond_collateral_cashflows.map(cf => ({
        Month: cf.month,
        Date: serialToDate(cf.date_serial),
        'Beg Bal': cf.beg_bal,
        'Int Inv': cf.int_to_inv,
        'Sched Prn': cf.reg_prn + cf.balloon_pay,
        'Prepaid Vol': cf.unsched_prn_vol,
        'Prepaid Inv': cf.unsched_prn_inv,
        'Total Prn': cf.net_prn,
        'End Bal': cf.end_bal,
        SMM: cf.smm,
        'Annual Prepay Rate': cf.annual_prepay_rate,
      }));
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(bcfRows), 'Bond Collateral CFs');
    }

    // Tabs 8+: Per bond class cashflows
    if (result) {
      for (const cls of deal.structure.classes) {
        const bcfs = result.bond_cashflows[cls.class_id];
        if (!bcfs || bcfs.length === 0) continue;
        const rows = bcfs.map(b => ({
          Month: b.month,
          'Beg Bal': b.beg_bal,
          'Int Due': b.interest_due,
          'Int Paid': b.interest_paid,
          'Sched Prn': b.sched_prn,
          'Prepaid Prn': b.prepaid_prn,
          'Default Prn': b.default_prn,
          'Total Prn': b.principal_paid,
          'End Bal': b.end_bal,
          'Coupon Rate': b.coupon_rate,
          'Penalty Income': b.penalty_income,
        }));
        const sheetName = cls.class_id.substring(0, 31); // Excel 31 char limit
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName);
      }
    }

    XLSX.writeFile(wb, `${deal.deal_name || 'deal'}_export.xlsx`);
  }, [deal, result, currentFaces]);

  const updateLoan = (idx: number, field: string, value: any) => {
    setDeal(d => {
      const loans = [...d.loans];
      loans[idx] = { ...loans[idx], [field]: value };
      return { ...d, loans, loan: loans[0] };
    });
  };
  const addLoan = () => {
    setDeal(d => {
      const newLoan = makeDefaultLoan();
      return { ...d, loans: [...d.loans, newLoan] };
    });
  };
  const removeLoan = (idx: number) => {
    setDeal(d => {
      if (d.loans.length <= 1) return d;
      const loans = d.loans.filter((_, i) => i !== idx);
      return { ...d, loans, loan: loans[0] };
    });
  };
  const updatePricing = (field: string, value: any) => {
    setDeal(d => ({ ...d, pricing: { ...d.pricing, [field]: value } }));
  };
  const updatePrepay = (field: string, value: any) => {
    setDeal(d => ({
      ...d,
      structure: { ...d.structure, prepay: { ...d.structure.prepay, [field]: value } },
    }));
  };

  const addClass = (type: 'SEQ' | 'PT' | 'IO') => {
    const id = `${type}-${deal.structure.classes.length + 1}`;
    const cls: BondClass = {
      class_id: id,
      class_type: type,
      original_balance: type === 'IO' ? 0 : 500000,
      current_balance: type === 'IO' ? 0 : 500000,
      coupon_type: 'FIX',
      coupon_fix: 0.04,
      priority_rank: deal.structure.classes.filter(c => c.class_type === 'SEQ').length + 1,
      pt_group_id: null,
      pricing_type: 'Price',
      pricing_input: 100,
      penalty_pct: null,
    };
    setDeal(d => ({
      ...d,
      structure: { ...d.structure, classes: [...d.structure.classes, cls] },
    }));
  };

  const updateClass = (idx: number, field: string, value: any) => {
    setDeal(d => {
      const classes = [...d.structure.classes];
      classes[idx] = { ...classes[idx], [field]: value };
      return { ...d, structure: { ...d.structure, classes } };
    });
  };

  const removeClass = (idx: number) => {
    setDeal(d => ({
      ...d,
      structure: { ...d.structure, classes: d.structure.classes.filter((_, i) => i !== idx) },
    }));
  };

  const moveClass = (idx: number, dir: -1 | 1) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= deal.structure.classes.length) return;
    setDeal(d => {
      const classes = [...d.structure.classes];
      [classes[idx], classes[newIdx]] = [classes[newIdx], classes[idx]];
      let rank = 1;
      classes.forEach(c => { if (c.class_type === 'SEQ') c.priority_rank = rank++; });
      return { ...d, structure: { ...d.structure, classes } };
    });
  };

  const handlePasteCurve = () => {
    if (!pasteText.trim()) return;
    const lines = pasteText.trim().split('\n');
    const points = lines.map(line => {
      const parts = line.split('\t');
      if (parts.length < 2) return null;
      const term = parseTenor(parts[0]);
      const rate = parseFloat(parts[1].trim());
      if (term === null || isNaN(rate)) return null;
      return { term, rate };
    }).filter((p): p is { term: number; rate: number } => p !== null);
    if (points.length > 0) {
      setDeal(d => ({ ...d, treasury_curve: { points } }));
      setPasteText('');
    }
  };

  // Deal Arb computation
  const totalFace = deal.loans.reduce((s, l) => s + l.original_face, 0);
  const dealArb = React.useMemo(() => {
    if (!result || !result.collateral_analytics) return null;
    const anyOvr = deal.loans.some(l => l.lp_amort_wam != null || l.lp_balloon != null || l.lp_io_period != null || l.lp_wam != null);
    const collat = (anyOvr ? result.loan_pricing_analytics : result.collateral_analytics) || result.collateral_analytics!;
    const classes = deal.structure.classes.filter(c => c.class_type !== 'IO');
    if (classes.length === 0) return null;

    // Collateral proceeds = sum of per-loan (clean_mv + accrued) using current face
    let collatCleanMV = 0;
    let collatAccrued = 0;
    for (let li = 0; li < deal.loans.length; li++) {
      const hasOvr = deal.loans[li].lp_amort_wam != null || deal.loans[li].lp_balloon != null || deal.loans[li].lp_io_period != null || deal.loans[li].lp_wam != null;
      const la = (hasOvr ? result.per_loan_pricing_analytics?.[li] : result.per_loan_analytics[li]) || result.per_loan_analytics[li];
      const cf = result.per_loan_current_faces?.[li] ?? deal.loans[li].original_face;
      if (la) {
        collatCleanMV += (la.price / 100) * cf;
        collatAccrued += (la.accrued / 100) * cf;
      }
    }
    const collatProceeds = collatCleanMV + collatAccrued;

    let bondProceeds = 0;
    let weightedYield = 0;
    let totalBondBalance = 0;

    for (const cls of classes) {
      const ba = result.bond_analytics[cls.class_id];
      if (!ba) continue;
      bondProceeds += (ba.price / 100) * cls.original_balance;
      weightedYield += ba.yield_pct * cls.original_balance;
      totalBondBalance += cls.original_balance;
    }

    const arbDollar = bondProceeds - collatProceeds;
    const arbPer100 = totalBondBalance > 0 ? (arbDollar / totalFace) * 100 : 0;
    const avgBondYield = totalBondBalance > 0 ? weightedYield / totalBondBalance : 0;
    const yieldSpread = collat.yield_pct - avgBondYield;

    return { arbDollar, arbPer100, collatYield: collat.yield_pct, avgBondYield, yieldSpread, bondProceeds, collatProceeds, collatCleanMV, collatAccrued };
  }, [result, deal.loans, deal.structure.classes, totalFace]);

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', background: '#0f172a', color: '#e2e8f0', minHeight: '100vh' }}>
      {/* Header */}
      <header style={{ background: '#1e293b', borderBottom: '1px solid #334155', padding: '8px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <h1 style={{ margin: 0, fontSize: 18, color: '#38bdf8' }}>GNR Deal Maker</h1>
          <span style={{ color: '#94a3b8', fontSize: 12 }}>Ginnie Mae Project Loan REMIC</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={deal.deal_name}
            onChange={e => setDeal(d => ({ ...d, deal_name: e.target.value }))}
            style={{ ...inputStyle, width: 160 }}
          />
          <button onClick={downloadCsvTemplate} style={btnSecondary}>Download Template</button>
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleCsvImport} style={{ display: 'none' }} />
          <button onClick={() => fileInputRef.current?.click()} style={btnSecondary}>Import Loans (CSV)</button>
          <button onClick={saveDeal} style={btnSecondary}>Save</button>
          <button onClick={runDeal} disabled={loading} style={btnPrimary}>
            {loading ? 'Running...' : 'Run Deal'}
          </button>
          <button onClick={exportWorkbook} style={btnSecondary}>Export Excel</button>
        </div>
      </header>

      {error && <div style={{ background: '#7f1d1d', color: '#fca5a5', padding: '6px 24px', fontSize: 12 }}>{error}</div>}

      {savedDeals.length > 0 && (
        <div style={{ padding: '4px 24px', background: '#1e293b', borderBottom: '1px solid #334155', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ color: '#94a3b8', fontSize: 12, lineHeight: '24px' }}>Saved:</span>
          {savedDeals.map(d => (
            <button key={d.deal_id} onClick={() => loadDeal(d.deal_id)} style={{ ...btnSmall, background: deal.deal_id === d.deal_id ? '#2563eb' : '#334155' }}>
              {d.deal_name}
            </button>
          ))}
        </div>
      )}

      {/* Tab Navigation */}
      <div style={{ display: 'flex', gap: 0, padding: '0 24px', background: '#1e293b', borderBottom: '1px solid #334155' }}>
        <button
          onClick={() => setActiveTab('deal')}
          style={{
            ...tabStyle,
            borderBottom: activeTab === 'deal' ? '2px solid #38bdf8' : '2px solid transparent',
            color: activeTab === 'deal' ? '#38bdf8' : '#94a3b8',
          }}
        >Deal</button>
        <button
          onClick={() => setActiveTab('curve')}
          style={{
            ...tabStyle,
            borderBottom: activeTab === 'curve' ? '2px solid #38bdf8' : '2px solid transparent',
            color: activeTab === 'curve' ? '#38bdf8' : '#94a3b8',
          }}
        >Curve Data</button>
      </div>

      {/* ════════════════════ DEAL TAB ════════════════════ */}
      {activeTab === 'deal' && (
        <div style={{ padding: '12px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* ── COLLATERAL SECTION ── */}
          <Section title="Collateral" collapsible collapsed={!showCollateral} onToggle={() => setShowCollateral(!showCollateral)}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <button onClick={addLoan} style={btnSecondary}>+ Add Loan</button>
              <button onClick={computeCurrentFace} disabled={loadingFaces} style={btnSecondary}>
                {loadingFaces ? 'Computing...' : 'Current Face'}
              </button>
              <span style={{ fontSize: 11, color: '#64748b', lineHeight: '28px' }}>
                {deal.loans.length} loan{deal.loans.length > 1 ? 's' : ''} &bull; Total Face: {fmt(totalFace, 0)}
                {currentFaces.length > 0 && <> &bull; Total Current: {fmt(currentFaces.reduce((s, f) => s + f.current_face, 0), 0)}</>}
              </span>
            </div>
            <div style={{ overflow: 'auto', maxHeight: 500 }}>
              <table style={scrollTableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}></th>
                    <th style={thStyle} colSpan={13}>Loan Details</th>
                    <th style={{...thStyle, borderLeft: '2px solid #475569'}} colSpan={3}>Pricing</th>
                    <th style={{...thStyle, borderLeft: '2px solid #475569'}}>Penalty</th>
                    <th style={{...thStyle, borderLeft: '2px solid #475569'}} colSpan={4}>LP Override</th>
                    {result && result.per_loan_analytics && result.per_loan_analytics.length > 0 && (
                      <th style={{...thStyle, borderLeft: '2px solid #475569'}} colSpan={10}>Analytics</th>
                    )}
                  </tr>
                  <tr>
                    <th style={thStyle2}></th>
                    <th style={thStyle2}>Dated</th>
                    <th style={thStyle2}>1st Settle</th>
                    <th style={thStyle2}>Delay</th>
                    <th style={thStyle2}>Orig Face</th>
                    <th style={thStyle2}>Cur Face</th>
                    <th style={thStyle2}>Net Cpn</th>
                    <th style={thStyle2}>WAC</th>
                    <th style={thStyle2}>WAM</th>
                    <th style={thStyle2}>Amort</th>
                    <th style={thStyle2}>IO</th>
                    <th style={thStyle2}>Balloon</th>
                    <th style={thStyle2}>Season</th>
                    <th style={thStyle2}>Lock</th>
                    <th style={{...thStyle2, borderLeft: '2px solid #475569'}}>Type</th>
                    <th style={thStyle2}>Input</th>
                    <th style={thStyle2}>Settle</th>
                    <th style={{...thStyle2, borderLeft: '2px solid #475569'}}>Schedule</th>
                    <th style={{...thStyle2, borderLeft: '2px solid #475569'}}>Amort</th>
                    <th style={thStyle2}>Blln</th>
                    <th style={thStyle2}>IO</th>
                    <th style={thStyle2}>WAM</th>
                    {result && result.per_loan_analytics && result.per_loan_analytics.length > 0 && <>
                      <th style={{...thStyle2, borderLeft: '2px solid #475569'}}>Price (Cln)</th>
                      <th style={thStyle2}>Yield</th>
                      <th style={thStyle2}>J-Sprd</th>
                      <th style={thStyle2}>WAL</th>
                      <th style={thStyle2}>Dur</th>
                      <th style={thStyle2}>Cvx</th>
                      <th style={thStyle2}>Risk</th>
                      <th style={thStyle2}>Tsy</th>
                      <th style={{...thStyle2, borderLeft: '2px solid #475569'}}>Accrued ($)</th>
                      <th style={thStyle2}>Mkt Value</th>
                    </>}
                  </tr>
                </thead>
                <tbody>
                  {deal.loans.map((loan, i) => {
                    const contractual = result?.per_loan_analytics?.[i];
                    const hasOverrides = loan.lp_amort_wam != null || loan.lp_balloon != null || loan.lp_io_period != null || loan.lp_wam != null;
                    const lp = hasOverrides ? result?.per_loan_pricing_analytics?.[i] : null;
                    const a = lp || contractual;
                    return (
                      <React.Fragment key={i}>
                      <tr>
                        <td style={tdStyle}>
                          {deal.loans.length > 1 && <button onClick={() => removeLoan(i)} style={{...btnMini, color: '#f87171'}}>x</button>}
                        </td>
                        <td style={tdStyle}><input type="date" value={loan.dated_date} onChange={e => updateLoan(i, 'dated_date', e.target.value)} style={{...inputStyle, width: 120}} /></td>
                        <td style={tdStyle}><input type="date" value={loan.first_settle} onChange={e => updateLoan(i, 'first_settle', e.target.value)} style={{...inputStyle, width: 120}} /></td>
                        <td style={tdStyle}><input type="number" value={loan.delay} onChange={e => updateLoan(i, 'delay', parseInt(e.target.value))} style={{...inputStyle, width: 45}} /></td>
                        <td style={tdStyle}><BlurInput type="text" value={loan.original_face} format={fmtComma} parse={s => updateLoan(i, 'original_face', parseComma(s))} style={{...inputStyle, width: 100}} /></td>
                        <td style={{...tdStyleR, fontSize: 11, color: (result?.per_loan_current_faces?.[i] ?? currentFaces[i]?.current_face) ? '#e2e8f0' : '#475569'}}>{
                          result?.per_loan_current_faces?.[i] != null
                            ? fmt(result.per_loan_current_faces[i], 2)
                            : (currentFaces[i] ? fmt(currentFaces[i].current_face, 2) : '-')
                        }</td>
                        <td style={tdStyle}><BlurInput type="text" value={loan.coupon_net} format={v => (v * 100).toFixed(4)} parse={s => updateLoan(i, 'coupon_net', parseFloat(s) / 100)} style={{...inputStyle, width: 65}} /></td>
                        <td style={tdStyle}><BlurInput type="text" value={loan.wac_gross} format={v => (v * 100).toFixed(4)} parse={s => updateLoan(i, 'wac_gross', parseFloat(s) / 100)} style={{...inputStyle, width: 65}} /></td>
                        <td style={tdStyle}><input type="number" value={loan.wam} onChange={e => updateLoan(i, 'wam', parseInt(e.target.value))} style={{...inputStyle, width: 45}} /></td>
                        <td style={tdStyle}><input type="number" value={loan.amort_wam} onChange={e => updateLoan(i, 'amort_wam', parseInt(e.target.value))} style={{...inputStyle, width: 45}} /></td>
                        <td style={tdStyle}><input type="number" value={loan.io_period ?? ''} onChange={e => updateLoan(i, 'io_period', e.target.value ? parseInt(e.target.value) : null)} style={{...inputStyle, width: 40}} placeholder="None" /></td>
                        <td style={tdStyle}><input type="number" value={loan.balloon ?? ''} onChange={e => updateLoan(i, 'balloon', e.target.value ? parseInt(e.target.value) : null)} style={{...inputStyle, width: 45}} placeholder="None" /></td>
                        <td style={tdStyle}><input type="number" value={loan.seasoning} onChange={e => updateLoan(i, 'seasoning', parseInt(e.target.value))} style={{...inputStyle, width: 40}} /></td>
                        <td style={tdStyle}><input type="number" value={loan.lockout_months ?? ''} onChange={e => updateLoan(i, 'lockout_months', e.target.value ? parseInt(e.target.value) : null)} style={{...inputStyle, width: 40}} placeholder="None" /></td>
                        {/* Pricing */}
                        <td style={{...tdStyle, borderLeft: '2px solid #475569'}}>
                          <select value={loan.pricing_type} onChange={e => updateLoan(i, 'pricing_type', e.target.value)} style={{...inputStyle, width: 70}}>
                            <option value="Price">Price</option>
                            <option value="Yield">Yield</option>
                            <option value="JSpread">J-Sprd</option>
                          </select>
                        </td>
                        <td style={tdStyle}><input type="number" step="0.01" value={loan.pricing_input} onChange={e => updateLoan(i, 'pricing_input', parseFloat(e.target.value))} style={{...inputStyle, width: 65}} /></td>
                        <td style={tdStyle}><input type="date" value={loan.settle_date || ''} onChange={e => updateLoan(i, 'settle_date', e.target.value)} style={{...inputStyle, width: 120}} /></td>
                        {/* Penalty */}
                        <td style={{...tdStyle, borderLeft: '2px solid #475569'}}>
                          <BlurInput type="text" placeholder="10-9-8..." value={loan.prepayment_penalty} format={penaltyToString} parse={s => updateLoan(i, 'prepayment_penalty', parsePenaltyString(s))} style={{...inputStyle, width: 100}} title={loan.prepayment_penalty.length > 0 ? `${loan.prepayment_penalty.length}-yr schedule` : 'No penalty'} />
                        </td>
                        {/* LP Override */}
                        <td style={{...tdStyle, borderLeft: '2px solid #475569'}}><input type="number" value={loan.lp_amort_wam ?? ''} onChange={e => updateLoan(i, 'lp_amort_wam', e.target.value ? parseInt(e.target.value) : null)} style={{...inputStyle, width: 45}} placeholder="-" /></td>
                        <td style={tdStyle}><input type="number" value={loan.lp_balloon ?? ''} onChange={e => updateLoan(i, 'lp_balloon', e.target.value ? parseInt(e.target.value) : null)} style={{...inputStyle, width: 45}} placeholder="-" /></td>
                        <td style={tdStyle}><input type="number" value={loan.lp_io_period ?? ''} onChange={e => updateLoan(i, 'lp_io_period', e.target.value ? parseInt(e.target.value) : null)} style={{...inputStyle, width: 40}} placeholder="-" /></td>
                        <td style={tdStyle}><input type="number" value={loan.lp_wam ?? ''} onChange={e => updateLoan(i, 'lp_wam', e.target.value ? parseInt(e.target.value) : null)} style={{...inputStyle, width: 45}} placeholder="-" /></td>
                        {/* Analytics - show LP override when set, otherwise contractual */}
                        {result && result.per_loan_analytics && result.per_loan_analytics.length > 0 && (() => {
                          if (!a) return <td colSpan={10} style={tdStyle}>-</td>;
                          const cf = result.per_loan_current_faces?.[i] ?? loan.original_face;
                          const accruedDollars = (a.accrued / 100) * cf;
                          const cleanMV = (a.price / 100) * cf;
                          return <>
                            <td style={{...tdStyleR, borderLeft: '2px solid #475569'}}>{a.price.toFixed(4)}</td>
                            <td style={tdStyleR}>{a.yield_pct.toFixed(4)}</td>
                            <td style={tdStyleR}>{a.j_spread.toFixed(1)}</td>
                            <td style={tdStyleR}>{a.wal.toFixed(4)}</td>
                            <td style={tdStyleR}>{a.modified_duration.toFixed(4)}</td>
                            <td style={tdStyleR}>{a.convexity.toFixed(4)}</td>
                            <td style={tdStyleR}>{a.risk_dpdy.toFixed(4)}</td>
                            <td style={tdStyleR}>{a.tsy_rate_at_wal.toFixed(4)}</td>
                            <td style={{...tdStyleR, borderLeft: '2px solid #475569'}}>{fmt(accruedDollars)}</td>
                            <td style={tdStyleR}>{fmt(cleanMV)}</td>
                          </>;
                        })()}
                      </tr>
                      </React.Fragment>
                    );
                  })}
                  {/* Aggregated total row */}
                  {deal.loans.length > 1 && (
                    <tr style={{ background: '#0f172a', fontWeight: 600 }}>
                      <td style={tdStyle}></td>
                      <td colSpan={3} style={{...tdStyle, color: '#38bdf8', fontSize: 11}}>TOTAL / WEIGHTED</td>
                      <td style={tdStyleR}>{fmt(totalFace, 0)}</td>
                      <td style={{...tdStyleR, color: (result?.per_loan_current_faces?.length ?? 0) > 0 ? '#38bdf8' : (currentFaces.length > 0 ? '#38bdf8' : '#475569')}}>{
                        (result?.per_loan_current_faces?.length ?? 0) > 0
                          ? fmt(result!.per_loan_current_faces.reduce((s, f) => s + f, 0), 0)
                          : (currentFaces.length > 0 ? fmt(currentFaces.reduce((s, f) => s + f.current_face, 0), 0) : '-')
                      }</td>
                      <td style={tdStyleR}>{totalFace > 0 ? (deal.loans.reduce((s, l) => s + l.original_face * l.coupon_net, 0) / totalFace * 100).toFixed(4) : '-'}</td>
                      <td style={tdStyleR}>{totalFace > 0 ? (deal.loans.reduce((s, l) => s + l.original_face * l.wac_gross, 0) / totalFace * 100).toFixed(4) : '-'}</td>
                      <td colSpan={6} style={tdStyle}></td>
                      <td style={{...tdStyle, borderLeft: '2px solid #475569'}} colSpan={3}></td>
                      <td style={{...tdStyle, borderLeft: '2px solid #475569'}}></td>
                      <td style={{...tdStyle, borderLeft: '2px solid #475569'}} colSpan={4}></td>
                      {result && result.per_loan_analytics && result.per_loan_analytics.length > 0 && (() => {
                        const anyOvr = deal.loans.some(l => l.lp_amort_wam != null || l.lp_balloon != null || l.lp_io_period != null || l.lp_wam != null);
                        const aggA = (anyOvr ? result.loan_pricing_analytics : result.collateral_analytics) || result.collateral_analytics;
                        // Compute aggregate price weighted by current face from per-loan data
                        let totalCF = 0, totalCleanMV = 0, totalAccrued = 0;
                        for (let li = 0; li < deal.loans.length; li++) {
                          const hasOvr = deal.loans[li].lp_amort_wam != null || deal.loans[li].lp_balloon != null || deal.loans[li].lp_io_period != null || deal.loans[li].lp_wam != null;
                          const la = (hasOvr ? result.per_loan_pricing_analytics?.[li] : result.per_loan_analytics[li]) || result.per_loan_analytics[li];
                          const cf = result.per_loan_current_faces?.[li] ?? deal.loans[li].original_face;
                          if (la) {
                            totalCF += cf;
                            totalCleanMV += (la.price / 100) * cf;
                            totalAccrued += (la.accrued / 100) * cf;
                          }
                        }
                        const aggPrice = totalCF > 0 ? (totalCleanMV / totalCF) * 100 : 0;
                        return <>
                          <td style={{...tdStyleR, borderLeft: '2px solid #475569', color: '#38bdf8'}}>{aggPrice.toFixed(4)}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{aggA?.yield_pct.toFixed(4) ?? '-'}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{aggA?.j_spread.toFixed(1) ?? '-'}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{aggA?.wal.toFixed(4) ?? '-'}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{aggA?.modified_duration.toFixed(4) ?? '-'}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{aggA?.convexity.toFixed(4) ?? '-'}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{aggA?.risk_dpdy.toFixed(4) ?? '-'}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{aggA?.tsy_rate_at_wal.toFixed(4) ?? '-'}</td>
                          <td style={{...tdStyleR, borderLeft: '2px solid #475569', color: '#38bdf8'}}>{fmt(totalAccrued)}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{fmt(totalCleanMV)}</td>
                        </>;
                      })()}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
              {deal.loans.length === 1 && <>
                Fee = {((deal.loans[0].wac_gross - deal.loans[0].coupon_net) * 10000).toFixed(0)} bp
                &nbsp;|&nbsp; Term = {Math.floor(deal.loans[0].wam / 12)}yr {deal.loans[0].wam % 12}mo
              </>}
              {deal.loans.length > 1 && <>
                Loans: {deal.loans.length} &bull; Wtd Cpn: {totalFace > 0 ? ((deal.loans.reduce((s, l) => s + l.original_face * l.coupon_net, 0) / totalFace) * 100).toFixed(2) : '0'}%
              </>}
            </div>
          </Section>

          {/* ── BOND STRUCTURE ── */}
          <Section title="Bond Structure">
            {/* Prepayment Assumption for Waterfall */}
            <div style={{ marginBottom: 10, padding: '8px 10px', background: '#0f172a', borderRadius: 6, border: '1px solid #334155' }}>
              <div style={{ fontSize: 10, color: '#64748b', marginBottom: 6, fontStyle: 'italic' }}>
                Prepayment Assumption (drives bond waterfall cashflow generation)
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={labelStyle}>Prepay Type</label>
                <select
                  value={deal.structure.prepay.prepay_type}
                  onChange={e => updatePrepay('prepay_type', e.target.value as PrepaymentType)}
                  style={{...inputStyle, width: 80}}
                >
                  <option value="None">None</option>
                  <option value="CPJ">CPJ</option>
                  <option value="CPR">CPR</option>
                </select>
                {deal.structure.prepay.prepay_type !== 'None' && <>
                  <label style={labelStyle}>Speed</label>
                  <input type="number" value={deal.structure.prepay.speed} onChange={e => updatePrepay('speed', parseFloat(e.target.value))} style={{...inputStyle, width: 60}} />
                </>}
                {deal.structure.prepay.prepay_type === 'CPJ' && <>
                  <label style={labelStyle}>PLD Mult</label>
                  <input type="number" step="0.1" value={deal.structure.prepay.pld_multiplier} onChange={e => updatePrepay('pld_multiplier', parseFloat(e.target.value))} style={{...inputStyle, width: 50}} />
                  <button onClick={() => setShowPLD(!showPLD)} style={btnSmall}>{showPLD ? 'Hide PLD' : 'PLD Curve'}</button>
                </>}
              </div>
              {deal.structure.prepay.prepay_type === 'CPJ' && showPLD && (
                <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {deal.structure.prepay.pld_curve.map((entry, i) => (
                    <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <span style={{ fontSize: 9, color: '#64748b' }}>{entry.start_month}-{entry.end_month}</span>
                      <input type="number" step="0.001" value={entry.annual_rate}
                        onChange={ev => {
                          const curve = [...deal.structure.prepay.pld_curve];
                          curve[i] = { ...curve[i], annual_rate: parseFloat(ev.target.value) };
                          updatePrepay('pld_curve', curve);
                        }}
                        style={{ ...inputStyle, width: 60, fontSize: 10, padding: '2px 3px' }} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              <button onClick={() => addClass('SEQ')} style={btnSecondary}>+ SEQ</button>
              <button onClick={() => addClass('PT')} style={btnSecondary}>+ PT</button>
              <button onClick={() => addClass('IO')} style={btnSecondary}>+ IO</button>
              <span style={{ marginLeft: 16, fontSize: 12, color: '#94a3b8' }}>
                Fee Rate: <input type="number" step="0.001" value={deal.structure.fee_rate} onChange={e => setDeal(d => ({ ...d, structure: { ...d.structure, fee_rate: parseFloat(e.target.value) } }))} style={{...inputStyle, width: 60}} />
              </span>
            </div>
            {deal.structure.classes.length > 0 && (
              <div style={{ overflow: 'auto', maxHeight: 400 }}>
                <table style={scrollTableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}></th>
                      <th style={thStyle}>ID</th>
                      <th style={thStyle}>Type</th>
                      <th style={thStyle}>Balance</th>
                      <th style={thStyle}>Cpn Type</th>
                      <th style={thStyle}>Rate</th>
                      <th style={thStyle}>Rank</th>
                      <th style={thStyle}>Pricing</th>
                      <th style={thStyle}>Px Input</th>
                      <th style={thStyle}>Penalty %</th>
                      {result && Object.keys(result.bond_analytics).length > 0 && <>
                        <th style={{...thStyle, borderLeft: '2px solid #475569'}}>Price</th>
                        <th style={thStyle}>Yield</th>
                        <th style={thStyle}>J-Sprd</th>
                        <th style={thStyle}>WAL</th>
                        <th style={thStyle}>Mod Dur</th>
                        <th style={thStyle}>Convx</th>
                        <th style={thStyle}>Risk</th>
                      </>}
                    </tr>
                  </thead>
                  <tbody>
                    {deal.structure.classes.map((cls, i) => {
                      const ba = result?.bond_analytics[cls.class_id];
                      const isIO = cls.class_type === 'IO';
                      // IO coupon = WAC - weighted avg coupon of non-IO bonds (by balance)
                      let ioCouponDisplay = '';
                      if (isIO) {
                        const nonIO = deal.structure.classes.filter(c => c.class_type !== 'IO');
                        const totalNonIOBal = nonIO.reduce((s, c) => s + c.original_balance, 0);
                        const wtdCpn = totalNonIOBal > 0 ? nonIO.reduce((s, c) => s + c.original_balance * (c.coupon_type === 'WAC' ? (totalFace > 0 ? deal.loans.reduce((a, l) => a + l.original_face * l.wac_gross, 0) / totalFace : 0) : c.coupon_fix), 0) / totalNonIOBal : 0;
                        const wac = totalFace > 0 ? deal.loans.reduce((s, l) => s + l.original_face * l.wac_gross, 0) / totalFace : 0;
                        const ioCpn = wac - wtdCpn;
                        ioCouponDisplay = (ioCpn * 100).toFixed(4);
                      }
                      return (
                        <tr key={i}>
                          <td style={tdStyle}>
                            <button onClick={() => moveClass(i, -1)} style={btnMini}>^</button>
                            <button onClick={() => moveClass(i, 1)} style={btnMini}>v</button>
                            <button onClick={() => removeClass(i)} style={{...btnMini, color: '#f87171'}}>x</button>
                          </td>
                          <td style={tdStyle}><input value={cls.class_id} onChange={e => updateClass(i, 'class_id', e.target.value)} style={{...inputStyle, width: 70}} /></td>
                          <td style={tdStyle}><span style={{ color: cls.class_type === 'SEQ' ? '#38bdf8' : cls.class_type === 'PT' ? '#a78bfa' : '#fbbf24', fontWeight: 600, fontSize: 11 }}>{cls.class_type}</span></td>
                          <td style={tdStyle}>
                            {!isIO && <BlurInput type="text" value={cls.original_balance} format={fmtComma} parse={s => updateClass(i, 'original_balance', parseComma(s))} style={{...inputStyle, width: 100}} />}
                            {isIO && <span style={{ color: '#94a3b8', fontSize: 11 }}>{fmtComma(totalFace)}</span>}
                          </td>
                          <td style={tdStyle}>
                            {!isIO && <select value={cls.coupon_type} onChange={e => updateClass(i, 'coupon_type', e.target.value)} style={{...inputStyle, width: 55}}><option value="FIX">FIX</option><option value="WAC">WAC</option></select>}
                            {isIO && <span style={{ color: '#94a3b8', fontSize: 11 }}>IO</span>}
                          </td>
                          <td style={tdStyle}>
                            {!isIO && cls.coupon_type === 'FIX' && <BlurInput type="text" value={cls.coupon_fix} format={v => (v * 100).toFixed(4)} parse={s => updateClass(i, 'coupon_fix', parseFloat(s) / 100)} style={{...inputStyle, width: 70}} />}
                            {!isIO && cls.coupon_type === 'WAC' && <span style={{ color: '#a78bfa', fontSize: 11 }}>WAC</span>}
                            {isIO && <span style={{ color: '#94a3b8', fontSize: 11 }}>{ioCouponDisplay}</span>}
                          </td>
                          <td style={tdStyle}>{cls.class_type === 'SEQ' ? cls.priority_rank : '-'}</td>
                          <td style={tdStyle}>
                            <select value={cls.pricing_type} onChange={e => updateClass(i, 'pricing_type', e.target.value)} style={{...inputStyle, width: 75}}><option value="Price">Price</option><option value="Yield">Yield</option><option value="JSpread">J-Sprd</option></select>
                          </td>
                          <td style={tdStyle}>
                            <input type="number" step="0.01" value={cls.pricing_input} onChange={e => updateClass(i, 'pricing_input', parseFloat(e.target.value))} style={{...inputStyle, width: 70}} />
                          </td>
                          <td style={tdStyle}>
                            <input type="number" step="1" min="0" max="100" value={cls.penalty_pct ?? ''} onChange={e => updateClass(i, 'penalty_pct', e.target.value ? parseFloat(e.target.value) : null)} style={{...inputStyle, width: 50}} placeholder="Auto" />
                          </td>
                          {result && Object.keys(result.bond_analytics).length > 0 && (() => {
                            if (!ba) return <td colSpan={7} style={tdStyle}>-</td>;
                            return <>
                              <td style={{...tdStyleR, borderLeft: '2px solid #475569'}}>{ba.price.toFixed(4)}</td>
                              <td style={tdStyleR}>{ba.yield_pct.toFixed(4)}</td>
                              <td style={tdStyleR}>{ba.j_spread.toFixed(1)}</td>
                              <td style={tdStyleR}>{ba.wal.toFixed(4)}</td>
                              <td style={tdStyleR}>{ba.modified_duration.toFixed(4)}</td>
                              <td style={tdStyleR}>{ba.convexity.toFixed(4)}</td>
                              <td style={tdStyleR}>{ba.risk_dpdy.toFixed(4)}</td>
                            </>;
                          })()}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {deal.structure.classes.length === 0 && <p style={{ color: '#64748b', fontSize: 12, margin: 0 }}>No bonds. Add SEQ, PT, or IO classes above.</p>}
          </Section>

          {/* ── DEAL ARB SUMMARY ── */}
          {dealArb && (
            <Section title="Deal Arb / PnL Summary">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                <MetricCard label="Collateral Proceeds" value={`$${fmt(dealArb.collatProceeds, 0)}`} />
                <MetricCard label="Bond Proceeds" value={`$${fmt(dealArb.bondProceeds, 0)}`} />
                <MetricCard label="Deal Arb ($)" value={`$${fmt(dealArb.arbDollar, 0)}`} highlight={dealArb.arbDollar >= 0} />
                <MetricCard label="Deal Arb (per 100)" value={dealArb.arbPer100.toFixed(4)} highlight={dealArb.arbPer100 >= 0} />
                <MetricCard label="Collateral Yield" value={`${dealArb.collatYield.toFixed(4)}%`} />
                <MetricCard label="Wtd Avg Bond Yield" value={`${dealArb.avgBondYield.toFixed(4)}%`} />
                <MetricCard label="Yield Spread" value={`${(dealArb.yieldSpread * 100).toFixed(1)} bp`} highlight={dealArb.yieldSpread >= 0} />
              </div>
            </Section>
          )}

          {/* ── CHARTS (collapsible) ── */}
          {result && (
            <Section title="Charts" collapsible collapsed={!showCharts} onToggle={() => setShowCharts(!showCharts)}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#94a3b8' }}>Contractual Cashflows</h4>
                  <CashflowChart data={result.collateral_cashflows} />
                </div>
                {prepayActive && (
                  <div>
                    <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#94a3b8' }}>Bond Collateral (with Prepay)</h4>
                    <CashflowChart data={result.bond_collateral_cashflows} />
                  </div>
                )}
              </div>
              {Object.keys(result.bond_cashflows).length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#94a3b8' }}>Bond Cashflows</h4>
                  <BondCashflowChart data={result.bond_cashflows} />
                </div>
              )}
            </Section>
          )}

          {/* ── COLLATERAL CASHFLOW TABLE (collapsible) ── */}
          {result && (
            <Section title="Collateral Cashflow Table" collapsible collapsed={!showCashflows} onToggle={() => setShowCashflows(!showCashflows)}>
              <div style={{ maxHeight: 400, overflow: 'auto' }}>
                <table style={scrollTableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Mo</th><th style={thStyle}>Date</th><th style={thStyle}>CF Date</th>
                      <th style={thStyle}>YrFrac</th><th style={thStyle}>Beg Bal</th><th style={thStyle}>Pmt Agy</th>
                      <th style={thStyle}>Int Inv</th><th style={thStyle}>Int Agy</th>
                      <th style={thStyle}>Sched Prn</th><th style={thStyle}>Prepaid</th><th style={thStyle}>Defaulted</th><th style={thStyle}>Total Prn</th>
                      <th style={thStyle}>End Bal</th><th style={thStyle}>Net Flow</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.collateral_cashflows.map(cf => (
                      <tr key={cf.month}>
                        <td style={tdStyle}>{cf.month}</td>
                        <td style={tdStyle}>{serialToDate(cf.date_serial)}</td>
                        <td style={tdStyle}>{serialToDate(cf.cf_date_serial)}</td>
                        <td style={tdStyle}>{cf.year_frac.toFixed(4)}</td>
                        <td style={tdStyleR}>{fmt(cf.beg_bal)}</td>
                        <td style={tdStyleR}>{fmt(cf.pmt_to_agy)}</td>
                        <td style={tdStyleR}>{fmt(cf.int_to_inv)}</td>
                        <td style={tdStyleR}>{fmt(cf.int_to_agy)}</td>
                        <td style={tdStyleR}>{fmt(cf.reg_prn + cf.balloon_pay)}</td>
                        <td style={tdStyleR}>{fmt(cf.unsched_prn_vol)}</td>
                        <td style={tdStyleR}>{fmt(cf.unsched_prn_inv)}</td>
                        <td style={tdStyleR}>{fmt(cf.net_prn)}</td>
                        <td style={tdStyleR}>{fmt(cf.end_bal)}</td>
                        <td style={tdStyleR}>{fmt(cf.net_flow)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button onClick={() => exportCSV(result.collateral_cashflows, 'collateral_cashflows.csv')} style={{ ...btnSmall, marginTop: 8 }}>Export CSV</button>
            </Section>
          )}

          {/* ── DEAL CASHFLOW TABLE ── */}
          {result && Object.keys(result.bond_cashflows).length > 0 && (
            <Section title="Deal Cashflows (Collateral + Bonds)" collapsible collapsed={!showDealCashflows} onToggle={() => setShowDealCashflows(!showDealCashflows)}>
              <DealCashflowTable result={result} classes={deal.structure.classes} exportCSV={exportCSV} />
            </Section>
          )}
        </div>
      )}

      {/* ════════════════════ CURVE DATA TAB ════════════════════ */}
      {activeTab === 'curve' && (
        <div style={{ padding: '12px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Section title="Curve Data">
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <label style={labelStyle}>Curve Date</label>
              <input type="date" value={deal.pricing.curve_date} onChange={e => updatePricing('curve_date', e.target.value)} style={{...inputStyle, width: 130}} />
            </div>

            {/* Treasury Curve Grid */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <h4 style={{ margin: 0, fontSize: 13, color: '#94a3b8' }}>Treasury Curve</h4>
                <button
                  onClick={() => {
                    const pts = [...deal.treasury_curve.points, { term: 0, rate: 0 }];
                    setDeal(d => ({ ...d, treasury_curve: { points: pts } }));
                  }}
                  style={btnSmall}
                >+ Add Point</button>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Tenor (yrs)</th>
                      <th style={thStyle}>Label</th>
                      <th style={thStyle}>Rate (%)</th>
                      <th style={thStyle}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {deal.treasury_curve.points.map((p, i) => (
                      <tr key={i}>
                        <td style={tdStyle}>
                          <input
                            type="number"
                            step="0.0833"
                            value={p.term}
                            onChange={e => {
                              const pts = [...deal.treasury_curve.points];
                              pts[i] = { ...pts[i], term: parseFloat(e.target.value) };
                              setDeal(d => ({ ...d, treasury_curve: { points: pts } }));
                            }}
                            style={{...inputStyle, width: 80}}
                          />
                        </td>
                        <td style={{...tdStyle, color: '#64748b', fontSize: 10}}>{termLabel(p.term)}</td>
                        <td style={tdStyle}>
                          <input
                            type="number"
                            step="0.001"
                            value={p.rate}
                            onChange={e => {
                              const pts = [...deal.treasury_curve.points];
                              pts[i] = { ...pts[i], rate: parseFloat(e.target.value) };
                              setDeal(d => ({ ...d, treasury_curve: { points: pts } }));
                            }}
                            style={{...inputStyle, width: 80}}
                          />
                        </td>
                        <td style={tdStyle}>
                          <button
                            onClick={() => {
                              const pts = deal.treasury_curve.points.filter((_, j) => j !== i);
                              setDeal(d => ({ ...d, treasury_curve: { points: pts } }));
                            }}
                            style={{...btnMini, color: '#f87171'}}
                          >x</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Paste Curve Data */}
            <div style={{ padding: '10px', background: '#0f172a', borderRadius: 6, border: '1px solid #334155' }}>
              <h4 style={{ margin: '0 0 6px', fontSize: 13, color: '#94a3b8' }}>Paste Curve Data</h4>
              <div style={{ fontSize: 10, color: '#64748b', marginBottom: 6 }}>
                Paste tab-separated data: Tenor&#9;Rate(%) — one point per line. Tenor accepts years (e.g. 0.5), or M/Y format (e.g. 1M, 3M, 1Y, 10Y)
              </div>
              <textarea
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                placeholder={"1M\t3.564\n3M\t3.682\n1Y\t3.564\n2Y\t3.513\n5Y\t3.649\n10Y\t4.07\n30Y\t4.716"}
                style={{
                  ...inputStyle,
                  width: '100%',
                  height: 120,
                  resize: 'vertical' as const,
                  fontFamily: 'monospace',
                  fontSize: 11,
                  whiteSpace: 'pre' as const,
                }}
              />
              <button onClick={handlePasteCurve} style={{...btnSecondary, marginTop: 6}}>
                Apply Pasted Data
              </button>
            </div>
          </Section>
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────────────── */

function Section({ title, children, collapsible, collapsed, onToggle }: {
  title: string; children: React.ReactNode; collapsible?: boolean; collapsed?: boolean; onToggle?: () => void;
}) {
  return (
    <div style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: collapsed ? 0 : 8, cursor: collapsible ? 'pointer' : 'default' }}
        onClick={collapsible ? onToggle : undefined}>
        {collapsible && <span style={{ color: '#64748b', fontSize: 11 }}>{collapsed ? '+ ' : '- '}</span>}
        <h3 style={{ ...panelHeader, margin: 0 }}>{title}</h3>
      </div>
      {!collapsed && children}
    </div>
  );
}

function MetricCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ background: '#0f172a', borderRadius: 6, padding: '8px 12px', border: '1px solid #334155' }}>
      <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'monospace', color: highlight === undefined ? '#e2e8f0' : highlight ? '#4ade80' : '#f87171' }}>{value}</div>
    </div>
  );
}

function DealCashflowTable({ result, classes, exportCSV }: {
  result: DealResult; classes: BondClass[]; exportCSV: (rows: any[], filename: string) => void;
}) {
  const bondIds = classes.map(c => c.class_id).filter(id => id in result.bond_cashflows);
  const collatCfs = result.bond_collateral_cashflows.length > 0 ? result.bond_collateral_cashflows : result.collateral_cashflows;

  const rows = collatCfs.map(cf => {
    const row: any = {
      month: cf.month,
      date: serialToDate(cf.cf_date_serial),
      collat_beg_bal: cf.beg_bal,
      collat_interest: cf.int_to_inv,
      collat_sched: cf.reg_prn + cf.balloon_pay,
      collat_prepaid: cf.unsched_prn_vol,
      collat_default: cf.unsched_prn_inv,
      collat_total_prn: cf.net_prn,
      collat_end_bal: cf.end_bal,
    };
    for (const bid of bondIds) {
      const bcf = result.bond_cashflows[bid]?.find(b => b.month === cf.month);
      row[`${bid}_beg`] = bcf?.beg_bal ?? 0;
      row[`${bid}_int`] = bcf?.interest_paid ?? 0;
      row[`${bid}_sched`] = bcf?.sched_prn ?? 0;
      row[`${bid}_prepaid`] = bcf?.prepaid_prn ?? 0;
      row[`${bid}_default`] = bcf?.default_prn ?? 0;
      row[`${bid}_prn`] = bcf?.principal_paid ?? 0;
      row[`${bid}_end`] = bcf?.end_bal ?? 0;
      row[`${bid}_penalty`] = bcf?.penalty_income ?? 0;
    }
    return row;
  });

  return (
    <>
      <div style={{ maxHeight: 400, overflow: 'auto' }}>
        <table style={scrollTableStyle}>
          <thead>
            <tr>
              <th style={thStyle} rowSpan={2}>Mo</th>
              <th style={thStyle} rowSpan={2}>Date</th>
              <th style={{...thStyle, borderLeft: '2px solid #475569'}} colSpan={7}>Collateral</th>
              {bondIds.map(bid => (
                <th key={bid} style={{...thStyle, borderLeft: '2px solid #475569'}} colSpan={8}>{bid}</th>
              ))}
            </tr>
            <tr>
              <th style={{...thStyle2, borderLeft: '2px solid #475569'}}>Beg Bal</th><th style={thStyle2}>Interest</th><th style={thStyle2}>Sched</th><th style={thStyle2}>Prepaid</th><th style={thStyle2}>Default</th><th style={thStyle2}>Total Prn</th><th style={thStyle2}>End Bal</th>
              {bondIds.map(bid => (
                <React.Fragment key={bid}>
                  <th style={{...thStyle2, borderLeft: '2px solid #475569'}}>Beg Bal</th><th style={thStyle2}>Int Paid</th><th style={thStyle2}>Sched</th><th style={thStyle2}>Prepaid</th><th style={thStyle2}>Default</th><th style={thStyle2}>Total Prn</th><th style={thStyle2}>End Bal</th><th style={thStyle2}>Penalty</th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.month}>
                <td style={tdStyle}>{r.month}</td>
                <td style={tdStyle}>{r.date}</td>
                <td style={{...tdStyleR, borderLeft: '2px solid #475569'}}>{fmt(r.collat_beg_bal)}</td>
                <td style={tdStyleR}>{fmt(r.collat_interest)}</td>
                <td style={tdStyleR}>{fmt(r.collat_sched)}</td>
                <td style={tdStyleR}>{fmt(r.collat_prepaid)}</td>
                <td style={tdStyleR}>{fmt(r.collat_default)}</td>
                <td style={tdStyleR}>{fmt(r.collat_total_prn)}</td>
                <td style={tdStyleR}>{fmt(r.collat_end_bal)}</td>
                {bondIds.map(bid => (
                  <React.Fragment key={bid}>
                    <td style={{...tdStyleR, borderLeft: '2px solid #475569'}}>{fmt(r[`${bid}_beg`])}</td>
                    <td style={tdStyleR}>{fmt(r[`${bid}_int`])}</td>
                    <td style={tdStyleR}>{fmt(r[`${bid}_sched`])}</td>
                    <td style={tdStyleR}>{fmt(r[`${bid}_prepaid`])}</td>
                    <td style={tdStyleR}>{fmt(r[`${bid}_default`])}</td>
                    <td style={tdStyleR}>{fmt(r[`${bid}_prn`])}</td>
                    <td style={tdStyleR}>{fmt(r[`${bid}_end`])}</td>
                    <td style={tdStyleR}>{fmt(r[`${bid}_penalty`])}</td>
                  </React.Fragment>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={() => exportCSV(rows, 'deal_cashflows.csv')} style={{ ...btnSmall, marginTop: 8 }}>Export CSV</button>
    </>
  );
}

/* ── Styles ──────────────────────────────────────────────────── */

const inputStyle: React.CSSProperties = {
  background: '#1e293b', border: '1px solid #475569', borderRadius: 4, color: '#e2e8f0',
  padding: '3px 6px', fontSize: 12,
};
const labelStyle: React.CSSProperties = { fontSize: 11, color: '#94a3b8' };
const panelStyle: React.CSSProperties = {
  background: '#1e293b', borderRadius: 8, padding: 12, border: '1px solid #334155',
};
const panelHeader: React.CSSProperties = {
  margin: '0 0 8px 0', fontSize: 14, color: '#38bdf8', fontWeight: 600,
};
const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 11,
};
const scrollTableStyle: React.CSSProperties = {
  minWidth: 'max-content', borderCollapse: 'separate', borderSpacing: 0, fontSize: 11,
};
const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid #475569', color: '#94a3b8', fontWeight: 500, whiteSpace: 'nowrap',
  position: 'sticky', top: 0, background: '#1e293b', zIndex: 2,
};
const thStyle2: React.CSSProperties = {
  ...thStyle, top: 24,
};
const tdStyle: React.CSSProperties = {
  padding: '3px 6px', borderBottom: '1px solid #1e293b', whiteSpace: 'nowrap',
};
const tdStyleR: React.CSSProperties = {
  ...tdStyle, textAlign: 'right', fontFamily: 'monospace',
};
const btnPrimary: React.CSSProperties = {
  background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 16px',
  cursor: 'pointer', fontSize: 13, fontWeight: 500,
};
const btnSecondary: React.CSSProperties = {
  background: '#334155', color: '#e2e8f0', border: '1px solid #475569', borderRadius: 6,
  padding: '4px 12px', cursor: 'pointer', fontSize: 12,
};
const btnSmall: React.CSSProperties = {
  background: '#334155', color: '#e2e8f0', border: '1px solid #475569', borderRadius: 4,
  padding: '2px 8px', cursor: 'pointer', fontSize: 10,
};
const btnMini: React.CSSProperties = {
  background: 'transparent', color: '#94a3b8', border: 'none', cursor: 'pointer', fontSize: 10, padding: '0 2px',
};
const tabStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', color: '#94a3b8', padding: '8px 16px',
  cursor: 'pointer', fontSize: 13, fontWeight: 500,
};
