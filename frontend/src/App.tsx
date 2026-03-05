import React, { useState, useEffect, useCallback } from 'react';
import type { Deal, DealResult, BondClass, PLDCurveEntry, PrepaymentType, LoanInput, CashflowRow, BondCashflowRow, AnalyticsOutput } from './types/deal';
import { dealApi } from './api/dealApi';
import { CashflowChart } from './components/CashflowChart';
import { BondCashflowChart } from './components/BondCashflowChart';

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
    prepayment_penalty: [],
    pricing_type: 'Price',
    pricing_input: 100,
    settle_date: '2026-03-03',
    lp_amort_wam: null,
    lp_balloon: null,
    lp_io_period: null,
    lp_wam: null,
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
      pt_share: 0,
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
  const [activeTab, setActiveTab] = useState<'deal' | 'curve'>('deal');
  const [pasteText, setPasteText] = useState('');

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
    'prepayment_penalty','pricing_type','pricing_input','settle_date',
    'lp_amort_wam','lp_balloon','lp_io_period','lp_wam',
  ] as const;

  const downloadCsvTemplate = useCallback(() => {
    const dl = makeDefaultLoan();
    const row = [
      dl.dated_date, dl.first_settle, dl.delay, dl.original_face, dl.coupon_net, dl.wac_gross,
      dl.wam, dl.amort_wam, dl.io_period ?? '', dl.balloon ?? '', dl.seasoning, dl.lockout_months ?? '',
      '', dl.pricing_type, dl.pricing_input, dl.settle_date ?? '',
      '', '', '', '',
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
        const headers = lines[0].split(',').map(h => h.trim());
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
          const vals = lines[r].split(',');
          const str = (col: string, def: string) => get(vals, col) || def;
          const int = (col: string, def: number) => { const v = get(vals, col); return v ? parseInt(v) : def; };
          const flt = (col: string, def: number) => { const v = get(vals, col); return v ? parseFloat(v) : def; };
          const nullInt = (col: string) => { const v = get(vals, col); return v ? parseInt(v) : null; };
          const pxType = str('pricing_type', 'Price');
          loans.push({
            dated_date: str('dated_date', dl.dated_date),
            first_settle: str('first_settle', dl.first_settle),
            delay: int('delay', dl.delay),
            original_face: flt('original_face', dl.original_face),
            coupon_net: flt('coupon_net', dl.coupon_net),
            wac_gross: flt('wac_gross', dl.wac_gross),
            wam: int('wam', dl.wam),
            amort_wam: int('amort_wam', dl.amort_wam),
            io_period: nullInt('io_period'),
            balloon: nullInt('balloon'),
            seasoning: int('seasoning', dl.seasoning),
            lockout_months: nullInt('lockout_months'),
            prepayment_penalty: parsePenaltyString(get(vals, 'prepayment_penalty')),
            pricing_type: (['Price','Yield','JSpread'].includes(pxType) ? pxType : 'Price') as LoanInput['pricing_type'],
            pricing_input: flt('pricing_input', dl.pricing_input),
            settle_date: get(vals, 'settle_date') || null,
            lp_amort_wam: nullInt('lp_amort_wam'),
            lp_balloon: nullInt('lp_balloon'),
            lp_io_period: nullInt('lp_io_period'),
            lp_wam: nullInt('lp_wam'),
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

    const collatProceeds = (collat.price / 100) * totalFace;
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

    return { arbDollar, arbPer100, collatYield: collat.yield_pct, avgBondYield, yieldSpread, bondProceeds, collatProceeds };
  }, [result, deal.structure.classes, totalFace]);

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
          <Section title="Collateral">
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button onClick={addLoan} style={btnSecondary}>+ Add Loan</button>
              <span style={{ fontSize: 11, color: '#64748b', lineHeight: '28px' }}>
                {deal.loans.length} loan{deal.loans.length > 1 ? 's' : ''} &bull; Total Face: {fmt(totalFace, 0)}
              </span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}></th>
                    <th style={thStyle} colSpan={12}>Loan Details</th>
                    <th style={{...thStyle, borderLeft: '2px solid #475569'}} colSpan={3}>Pricing</th>
                    <th style={{...thStyle, borderLeft: '2px solid #475569'}}>Penalty</th>
                    <th style={{...thStyle, borderLeft: '2px solid #475569'}} colSpan={4}>LP Override</th>
                    {result && result.per_loan_analytics && result.per_loan_analytics.length > 0 && (
                      <th style={{...thStyle, borderLeft: '2px solid #475569'}} colSpan={8}>Analytics</th>
                    )}
                  </tr>
                  <tr>
                    <th style={thStyle}></th>
                    <th style={thStyle}>Dated</th>
                    <th style={thStyle}>1st Settle</th>
                    <th style={thStyle}>Delay</th>
                    <th style={thStyle}>Orig Face</th>
                    <th style={thStyle}>Net Cpn</th>
                    <th style={thStyle}>WAC</th>
                    <th style={thStyle}>WAM</th>
                    <th style={thStyle}>Amort</th>
                    <th style={thStyle}>IO</th>
                    <th style={thStyle}>Balloon</th>
                    <th style={thStyle}>Season</th>
                    <th style={thStyle}>Lock</th>
                    <th style={{...thStyle, borderLeft: '2px solid #475569'}}>Type</th>
                    <th style={thStyle}>Input</th>
                    <th style={thStyle}>Settle</th>
                    <th style={{...thStyle, borderLeft: '2px solid #475569'}}>Schedule</th>
                    <th style={{...thStyle, borderLeft: '2px solid #475569'}}>Amort</th>
                    <th style={thStyle}>Blln</th>
                    <th style={thStyle}>IO</th>
                    <th style={thStyle}>WAM</th>
                    {result && result.per_loan_analytics && result.per_loan_analytics.length > 0 && <>
                      <th style={{...thStyle, borderLeft: '2px solid #475569'}}>Price</th>
                      <th style={thStyle}>Yield</th>
                      <th style={thStyle}>J-Sprd</th>
                      <th style={thStyle}>WAL</th>
                      <th style={thStyle}>Dur</th>
                      <th style={thStyle}>Cvx</th>
                      <th style={thStyle}>Risk</th>
                      <th style={thStyle}>Tsy</th>
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
                        <td style={tdStyle}><input type="text" value={fmtComma(loan.original_face)} onChange={e => updateLoan(i, 'original_face', parseComma(e.target.value))} style={{...inputStyle, width: 100}} /></td>
                        <td style={tdStyle}><input type="number" step="0.25" value={(loan.coupon_net * 100).toFixed(4)} onChange={e => updateLoan(i, 'coupon_net', parseFloat(e.target.value) / 100)} style={{...inputStyle, width: 65}} /></td>
                        <td style={tdStyle}><input type="number" step="0.25" value={(loan.wac_gross * 100).toFixed(4)} onChange={e => updateLoan(i, 'wac_gross', parseFloat(e.target.value) / 100)} style={{...inputStyle, width: 65}} /></td>
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
                          <input type="text" placeholder="10-9-8..." value={penaltyToString(loan.prepayment_penalty)} onChange={e => updateLoan(i, 'prepayment_penalty', parsePenaltyString(e.target.value))} style={{...inputStyle, width: 100}} title={loan.prepayment_penalty.length > 0 ? `${loan.prepayment_penalty.length}-yr schedule` : 'No penalty'} />
                        </td>
                        {/* LP Override */}
                        <td style={{...tdStyle, borderLeft: '2px solid #475569'}}><input type="number" value={loan.lp_amort_wam ?? ''} onChange={e => updateLoan(i, 'lp_amort_wam', e.target.value ? parseInt(e.target.value) : null)} style={{...inputStyle, width: 45}} placeholder="-" /></td>
                        <td style={tdStyle}><input type="number" value={loan.lp_balloon ?? ''} onChange={e => updateLoan(i, 'lp_balloon', e.target.value ? parseInt(e.target.value) : null)} style={{...inputStyle, width: 45}} placeholder="-" /></td>
                        <td style={tdStyle}><input type="number" value={loan.lp_io_period ?? ''} onChange={e => updateLoan(i, 'lp_io_period', e.target.value ? parseInt(e.target.value) : null)} style={{...inputStyle, width: 40}} placeholder="-" /></td>
                        <td style={tdStyle}><input type="number" value={loan.lp_wam ?? ''} onChange={e => updateLoan(i, 'lp_wam', e.target.value ? parseInt(e.target.value) : null)} style={{...inputStyle, width: 45}} placeholder="-" /></td>
                        {/* Analytics - show LP override when set, otherwise contractual */}
                        {result && result.per_loan_analytics && result.per_loan_analytics.length > 0 && (() => {
                          if (!a) return <td colSpan={8} style={tdStyle}>-</td>;
                          return <>
                            <td style={{...tdStyleR, borderLeft: '2px solid #475569'}}>{a.price.toFixed(4)}</td>
                            <td style={tdStyleR}>{a.yield_pct.toFixed(4)}</td>
                            <td style={tdStyleR}>{a.j_spread.toFixed(1)}</td>
                            <td style={tdStyleR}>{a.wal.toFixed(4)}</td>
                            <td style={tdStyleR}>{a.modified_duration.toFixed(4)}</td>
                            <td style={tdStyleR}>{a.convexity.toFixed(4)}</td>
                            <td style={tdStyleR}>{a.risk_dpdy.toFixed(4)}</td>
                            <td style={tdStyleR}>{a.tsy_rate_at_wal.toFixed(4)}</td>
                          </>;
                        })()}
                      </tr>
                      {/* Contractual analytics sub-row - shown when LP overrides differ from contractual */}
                      {lp && contractual && result && result.per_loan_analytics && result.per_loan_analytics.length > 0 && (
                        <tr style={{ background: '#1a1a2e' }}>
                          <td style={tdStyle}></td>
                          <td colSpan={12} style={{...tdStyle, color: '#64748b', fontSize: 10, fontStyle: 'italic'}}>Contractual</td>
                          <td style={{...tdStyle, borderLeft: '2px solid #475569'}} colSpan={3}></td>
                          <td style={{...tdStyle, borderLeft: '2px solid #475569'}}></td>
                          <td style={{...tdStyle, borderLeft: '2px solid #475569'}} colSpan={4}></td>
                          <td style={{...tdStyleR, borderLeft: '2px solid #475569', color: '#64748b'}}>{contractual.price.toFixed(4)}</td>
                          <td style={{...tdStyleR, color: '#64748b'}}>{contractual.yield_pct.toFixed(4)}</td>
                          <td style={{...tdStyleR, color: '#64748b'}}>{contractual.j_spread.toFixed(1)}</td>
                          <td style={{...tdStyleR, color: '#64748b'}}>{contractual.wal.toFixed(4)}</td>
                          <td style={{...tdStyleR, color: '#64748b'}}>{contractual.modified_duration.toFixed(4)}</td>
                          <td style={{...tdStyleR, color: '#64748b'}}>{contractual.convexity.toFixed(4)}</td>
                          <td style={{...tdStyleR, color: '#64748b'}}>{contractual.risk_dpdy.toFixed(4)}</td>
                          <td style={{...tdStyleR, color: '#64748b'}}>{contractual.tsy_rate_at_wal.toFixed(4)}</td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                  {/* Aggregated total row */}
                  {deal.loans.length > 1 && (
                    <tr style={{ background: '#0f172a', fontWeight: 600 }}>
                      <td style={tdStyle}></td>
                      <td colSpan={3} style={{...tdStyle, color: '#38bdf8', fontSize: 11}}>TOTAL / WEIGHTED</td>
                      <td style={tdStyleR}>{fmt(totalFace, 0)}</td>
                      <td style={tdStyleR}>{totalFace > 0 ? (deal.loans.reduce((s, l) => s + l.original_face * l.coupon_net, 0) / totalFace * 100).toFixed(4) : '-'}</td>
                      <td style={tdStyleR}>{totalFace > 0 ? (deal.loans.reduce((s, l) => s + l.original_face * l.wac_gross, 0) / totalFace * 100).toFixed(4) : '-'}</td>
                      <td colSpan={6} style={tdStyle}></td>
                      <td style={{...tdStyle, borderLeft: '2px solid #475569'}} colSpan={3}></td>
                      <td style={{...tdStyle, borderLeft: '2px solid #475569'}}></td>
                      <td style={{...tdStyle, borderLeft: '2px solid #475569'}} colSpan={4}></td>
                      {result && (result.loan_pricing_analytics || result.collateral_analytics) && (() => {
                        const anyOvr = deal.loans.some(l => l.lp_amort_wam != null || l.lp_balloon != null || l.lp_io_period != null || l.lp_wam != null);
                        const a = (anyOvr ? result.loan_pricing_analytics : result.collateral_analytics) || result.collateral_analytics;
                        if (!a) return null;
                        return <>
                          <td style={{...tdStyleR, borderLeft: '2px solid #475569', color: '#38bdf8'}}>{a.price.toFixed(4)}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{a.yield_pct.toFixed(4)}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{a.j_spread.toFixed(1)}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{a.wal.toFixed(4)}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{a.modified_duration.toFixed(4)}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{a.convexity.toFixed(4)}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{a.risk_dpdy.toFixed(4)}</td>
                          <td style={{...tdStyleR, color: '#38bdf8'}}>{a.tsy_rate_at_wal.toFixed(4)}</td>
                        </>;
                      })()}
                      {result && (!result.collateral_analytics) && result.per_loan_analytics && result.per_loan_analytics.length > 0 && (
                        <td colSpan={8} style={{...tdStyle, borderLeft: '2px solid #475569'}}>-</td>
                      )}
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
                  <label style={labelStyle}>Lockout</label>
                  <input type="number" value={deal.structure.prepay.lockout_months} onChange={e => updatePrepay('lockout_months', parseInt(e.target.value))} style={{...inputStyle, width: 50}} />
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
                PT Share: <input type="number" step="0.1" value={deal.structure.pt_share} onChange={e => setDeal(d => ({ ...d, structure: { ...d.structure, pt_share: parseFloat(e.target.value) } }))} style={{...inputStyle, width: 50}} />
                &nbsp; Fee Rate: <input type="number" step="0.001" value={deal.structure.fee_rate} onChange={e => setDeal(d => ({ ...d, structure: { ...d.structure, fee_rate: parseFloat(e.target.value) } }))} style={{...inputStyle, width: 60}} />
              </span>
            </div>
            {deal.structure.classes.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={tableStyle}>
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
                            {cls.class_type !== 'IO' && <input type="text" value={fmtComma(cls.original_balance)} onChange={e => updateClass(i, 'original_balance', parseComma(e.target.value))} style={{...inputStyle, width: 100}} />}
                          </td>
                          <td style={tdStyle}>
                            {cls.class_type !== 'IO' && <select value={cls.coupon_type} onChange={e => updateClass(i, 'coupon_type', e.target.value)} style={{...inputStyle, width: 55}}><option value="FIX">FIX</option><option value="WAC">WAC</option></select>}
                          </td>
                          <td style={tdStyle}>
                            {cls.class_type !== 'IO' && cls.coupon_type === 'FIX' && <input type="number" step="0.25" value={(cls.coupon_fix * 100).toFixed(4)} onChange={e => updateClass(i, 'coupon_fix', parseFloat(e.target.value) / 100)} style={{...inputStyle, width: 70}} />}
                            {cls.class_type !== 'IO' && cls.coupon_type === 'WAC' && <span style={{ color: '#a78bfa', fontSize: 11 }}>WAC</span>}
                          </td>
                          <td style={tdStyle}>{cls.class_type === 'SEQ' ? cls.priority_rank : '-'}</td>
                          <td style={tdStyle}>
                            {cls.class_type !== 'IO' && <select value={cls.pricing_type} onChange={e => updateClass(i, 'pricing_type', e.target.value)} style={{...inputStyle, width: 75}}><option value="Price">Price</option><option value="Yield">Yield</option><option value="JSpread">J-Sprd</option></select>}
                          </td>
                          <td style={tdStyle}>
                            {cls.class_type !== 'IO' && <input type="number" step="0.01" value={cls.pricing_input} onChange={e => updateClass(i, 'pricing_input', parseFloat(e.target.value))} style={{...inputStyle, width: 70}} />}
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
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>Mo</th><th style={thStyle}>Date</th><th style={thStyle}>CF Date</th>
                      <th style={thStyle}>YrFrac</th><th style={thStyle}>Beg Bal</th><th style={thStyle}>Pmt Agy</th>
                      <th style={thStyle}>Int Inv</th><th style={thStyle}>Int Agy</th><th style={thStyle}>Reg Prn</th>
                      <th style={thStyle}>Balloon</th><th style={thStyle}>End Bal</th><th style={thStyle}>Net Prn</th>
                      <th style={thStyle}>Net Flow</th>
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
                        <td style={tdStyleR}>{fmt(cf.reg_prn)}</td>
                        <td style={tdStyleR}>{fmt(cf.balloon_pay)}</td>
                        <td style={tdStyleR}>{fmt(cf.end_bal)}</td>
                        <td style={tdStyleR}>{fmt(cf.net_prn)}</td>
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
      collat_principal: cf.net_prn,
      collat_end_bal: cf.end_bal,
    };
    for (const bid of bondIds) {
      const bcf = result.bond_cashflows[bid]?.find(b => b.month === cf.month);
      row[`${bid}_beg`] = bcf?.beg_bal ?? 0;
      row[`${bid}_int`] = bcf?.interest_paid ?? 0;
      row[`${bid}_prn`] = bcf?.principal_paid ?? 0;
      row[`${bid}_end`] = bcf?.end_bal ?? 0;
      row[`${bid}_penalty`] = bcf?.penalty_income ?? 0;
    }
    return row;
  });

  return (
    <>
      <div style={{ maxHeight: 400, overflow: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle} rowSpan={2}>Mo</th>
              <th style={thStyle} rowSpan={2}>Date</th>
              <th style={{...thStyle, borderLeft: '2px solid #475569'}} colSpan={4}>Collateral</th>
              {bondIds.map(bid => (
                <th key={bid} style={{...thStyle, borderLeft: '2px solid #475569'}} colSpan={5}>{bid}</th>
              ))}
            </tr>
            <tr>
              <th style={{...thStyle, borderLeft: '2px solid #475569'}}>Beg Bal</th><th style={thStyle}>Interest</th><th style={thStyle}>Principal</th><th style={thStyle}>End Bal</th>
              {bondIds.map(bid => (
                <React.Fragment key={bid}>
                  <th style={{...thStyle, borderLeft: '2px solid #475569'}}>Beg Bal</th><th style={thStyle}>Int Paid</th><th style={thStyle}>Prin Paid</th><th style={thStyle}>End Bal</th><th style={thStyle}>Penalty</th>
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
                <td style={tdStyleR}>{fmt(r.collat_principal)}</td>
                <td style={tdStyleR}>{fmt(r.collat_end_bal)}</td>
                {bondIds.map(bid => (
                  <React.Fragment key={bid}>
                    <td style={{...tdStyleR, borderLeft: '2px solid #475569'}}>{fmt(r[`${bid}_beg`])}</td>
                    <td style={tdStyleR}>{fmt(r[`${bid}_int`])}</td>
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
  width: '100%', borderCollapse: 'collapse', fontSize: 11,
};
const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid #475569', color: '#94a3b8', fontWeight: 500, whiteSpace: 'nowrap',
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
