import React, { useState, useEffect, useCallback } from 'react';
import type { Deal, DealResult, BondClass, PLDCurveEntry, CashflowRow, BondCashflowRow, AnalyticsOutput } from './types/deal';
import { dealApi, type UploadResult } from './api/dealApi';
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

function makeDefaultDeal(): Deal {
  return {
    deal_id: '',
    deal_name: 'New Deal',
    loan: {
      dated_date: '2026-03-01',
      first_settle: '2026-03-01',
      delay: 44,
      original_face: 1000000,
      coupon_net: 0.05,
      wac_gross: 0.0525,
      wam: 480,
      amort_wam: 480,
      io_period: 0,
      balloon: 120,
      seasoning: 0,
      lockout_months: 0,
    },
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
    structure: { classes: [], pt_share: 0, fee_rate: 0 },
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

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    dealApi.listDeals().then(setSavedDeals).catch(() => {});
  }, []);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const data: UploadResult = await dealApi.uploadExcel(file);
      setDeal(d => ({ ...d, loan: data.loan, pricing: data.pricing }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, []);

  const runDeal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await dealApi.runInline(deal);
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

  const updateLoan = (field: string, value: any) => {
    setDeal(d => ({ ...d, loan: { ...d.loan, [field]: value } }));
  };
  const updatePricing = (field: string, value: any) => {
    setDeal(d => ({ ...d, pricing: { ...d.pricing, [field]: value } }));
  };
  const updateCPJ = (field: string, value: any) => {
    setDeal(d => ({ ...d, cpj: { ...d.cpj, [field]: value } }));
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

  // Deal Arb computation
  const dealArb = React.useMemo(() => {
    if (!result || !result.collateral_analytics) return null;
    const collat = result.collateral_analytics;
    const classes = deal.structure.classes.filter(c => c.class_type !== 'IO');
    if (classes.length === 0) return null;

    const collatProceeds = (collat.price / 100) * deal.loan.original_face;
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
    const arbPer100 = totalBondBalance > 0 ? (arbDollar / deal.loan.original_face) * 100 : 0;
    const avgBondYield = totalBondBalance > 0 ? weightedYield / totalBondBalance : 0;
    const yieldSpread = collat.yield_pct - avgBondYield;

    return { arbDollar, arbPer100, collatYield: collat.yield_pct, avgBondYield, yieldSpread, bondProceeds, collatProceeds };
  }, [result, deal.structure.classes, deal.loan.original_face]);

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
          <input ref={fileInputRef} type="file" accept=".xlsm,.xlsx" onChange={handleUpload} style={{ display: 'none' }} />
          <button onClick={() => fileInputRef.current?.click()} disabled={uploading} style={btnSecondary}>
            {uploading ? 'Reading...' : 'Import Excel'}
          </button>
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

      <div style={{ padding: '12px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* ── COLLATERAL SECTION ── */}
        <Section title="Collateral">
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Dated Date</th>
                  <th style={thStyle}>1st Settle</th>
                  <th style={thStyle}>Delay</th>
                  <th style={thStyle}>Orig Face</th>
                  <th style={thStyle}>Net Cpn</th>
                  <th style={thStyle}>Gross WAC</th>
                  <th style={thStyle}>WAM</th>
                  <th style={thStyle}>Amort WAM</th>
                  <th style={thStyle}>IO (mo)</th>
                  <th style={thStyle}>Balloon</th>
                  <th style={thStyle}>Seasoning</th>
                  <th style={thStyle}>Lockout</th>
                  {result && result.collateral_analytics && <>
                    <th style={{...thStyle, borderLeft: '2px solid #475569'}}>Price</th>
                    <th style={thStyle}>Yield</th>
                    <th style={thStyle}>J-Sprd</th>
                    <th style={thStyle}>WAL</th>
                    <th style={thStyle}>Mod Dur</th>
                    <th style={thStyle}>Convx</th>
                    <th style={thStyle}>Risk</th>
                    <th style={thStyle}>Tsy@WAL</th>
                  </>}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={tdStyle}><input type="date" value={deal.loan.dated_date} onChange={e => updateLoan('dated_date', e.target.value)} style={{...inputStyle, width: 120}} /></td>
                  <td style={tdStyle}><input type="date" value={deal.loan.first_settle} onChange={e => updateLoan('first_settle', e.target.value)} style={{...inputStyle, width: 120}} /></td>
                  <td style={tdStyle}><input type="number" value={deal.loan.delay} onChange={e => updateLoan('delay', parseInt(e.target.value))} style={{...inputStyle, width: 50}} /></td>
                  <td style={tdStyle}><input type="number" value={deal.loan.original_face} onChange={e => updateLoan('original_face', parseFloat(e.target.value))} style={{...inputStyle, width: 100}} /></td>
                  <td style={tdStyle}><input type="number" step="0.0025" value={deal.loan.coupon_net} onChange={e => updateLoan('coupon_net', parseFloat(e.target.value))} style={{...inputStyle, width: 70}} /></td>
                  <td style={tdStyle}><input type="number" step="0.0025" value={deal.loan.wac_gross} onChange={e => updateLoan('wac_gross', parseFloat(e.target.value))} style={{...inputStyle, width: 70}} /></td>
                  <td style={tdStyle}><input type="number" value={deal.loan.wam} onChange={e => updateLoan('wam', parseInt(e.target.value))} style={{...inputStyle, width: 50}} /></td>
                  <td style={tdStyle}><input type="number" value={deal.loan.amort_wam} onChange={e => updateLoan('amort_wam', parseInt(e.target.value))} style={{...inputStyle, width: 50}} /></td>
                  <td style={tdStyle}><input type="number" value={deal.loan.io_period} onChange={e => updateLoan('io_period', parseInt(e.target.value))} style={{...inputStyle, width: 50}} /></td>
                  <td style={tdStyle}><input type="number" value={deal.loan.balloon} onChange={e => updateLoan('balloon', parseInt(e.target.value))} style={{...inputStyle, width: 50}} /></td>
                  <td style={tdStyle}><input type="number" value={deal.loan.seasoning} onChange={e => updateLoan('seasoning', parseInt(e.target.value))} style={{...inputStyle, width: 50}} /></td>
                  <td style={tdStyle}><input type="number" value={deal.loan.lockout_months} onChange={e => updateLoan('lockout_months', parseInt(e.target.value))} style={{...inputStyle, width: 50}} /></td>
                  {result && result.collateral_analytics && (() => {
                    const a = result.collateral_analytics!;
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
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
            Fee = {((deal.loan.wac_gross - deal.loan.coupon_net) * 10000).toFixed(0)} bp
            &nbsp;|&nbsp; Term = {Math.floor(deal.loan.wam / 12)}yr {deal.loan.wam % 12}mo
          </div>
        </Section>

        {/* ── PRICING & TREASURY ── */}
        <Section title="Pricing & Treasury Curve">
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={labelStyle}>Type</label>
              <select value={deal.pricing.pricing_type} onChange={e => updatePricing('pricing_type', e.target.value)} style={{...inputStyle, width: 90}}>
                <option value="Price">Price</option>
                <option value="Yield">Yield</option>
                <option value="JSpread">J-Spread</option>
              </select>
              <label style={labelStyle}>Input</label>
              <input type="number" step="0.01" value={deal.pricing.pricing_input} onChange={e => updatePricing('pricing_input', parseFloat(e.target.value))} style={{...inputStyle, width: 80}} />
              <label style={labelStyle}>Settle</label>
              <input type="date" value={deal.pricing.settle_date} onChange={e => updatePricing('settle_date', e.target.value)} style={{...inputStyle, width: 120}} />
              <label style={labelStyle}>Curve Dt</label>
              <input type="date" value={deal.pricing.curve_date} onChange={e => updatePricing('curve_date', e.target.value)} style={{...inputStyle, width: 120}} />
            </div>
            <div style={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: '#94a3b8', marginRight: 4 }}>Tsy:</span>
              {deal.treasury_curve.points.map((p, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span style={{ fontSize: 9, color: '#64748b' }}>{p.term < 1 ? `${(p.term * 12).toFixed(0)}m` : `${p.term}y`}</span>
                  <input type="number" step="0.001" value={p.rate}
                    onChange={e => {
                      const pts = [...deal.treasury_curve.points];
                      pts[i] = { ...pts[i], rate: parseFloat(e.target.value) };
                      setDeal(d => ({ ...d, treasury_curve: { points: pts } }));
                    }}
                    style={{ ...inputStyle, width: 52, fontSize: 10, padding: '2px 3px', textAlign: 'center' as const }} />
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* ── CPJ SETTINGS ── */}
        <Section title="CPJ Prepayment">
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
              <input type="checkbox" checked={deal.cpj.enabled} onChange={e => updateCPJ('enabled', e.target.checked)} />
              Enable
            </label>
            {deal.cpj.enabled && <>
              <label style={labelStyle}>Speed</label>
              <input type="number" value={deal.cpj.cpj_speed} onChange={e => updateCPJ('cpj_speed', parseFloat(e.target.value))} style={{...inputStyle, width: 60}} />
              <label style={labelStyle}>Lockout</label>
              <input type="number" value={deal.cpj.lockout_months} onChange={e => updateCPJ('lockout_months', parseInt(e.target.value))} style={{...inputStyle, width: 50}} />
              <label style={labelStyle}>PLD Mult</label>
              <input type="number" step="0.1" value={deal.cpj.pld_multiplier} onChange={e => updateCPJ('pld_multiplier', parseFloat(e.target.value))} style={{...inputStyle, width: 50}} />
              <button onClick={() => setShowPLD(!showPLD)} style={btnSmall}>{showPLD ? 'Hide PLD' : 'PLD Curve'}</button>
            </>}
          </div>
          {deal.cpj.enabled && showPLD && (
            <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {deal.cpj.pld_curve.map((e, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span style={{ fontSize: 9, color: '#64748b' }}>{e.start_month}-{e.end_month}</span>
                  <input type="number" step="0.001" value={e.annual_rate}
                    onChange={ev => {
                      const curve = [...deal.cpj.pld_curve];
                      curve[i] = { ...curve[i], annual_rate: parseFloat(ev.target.value) };
                      updateCPJ('pld_curve', curve);
                    }}
                    style={{ ...inputStyle, width: 60, fontSize: 10, padding: '2px 3px' }} />
                </div>
              ))}
            </div>
          )}
          {/* Loan Pricing Profile */}
          <div style={{ marginTop: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
              <input type="checkbox"
                checked={deal.loan_pricing_profile !== null}
                onChange={e => setDeal(d => ({
                  ...d,
                  loan_pricing_profile: e.target.checked
                    ? { amort_wam_override: 480, balloon_override: 120, io_period_override: null, wam_override: null }
                    : null,
                }))}
              />
              Loan Pricing Override
            </label>
            {deal.loan_pricing_profile && <>
              <label style={labelStyle}>Amort WAM</label>
              <input type="number" value={deal.loan_pricing_profile.amort_wam_override ?? ''} onChange={e => setDeal(d => ({ ...d, loan_pricing_profile: { ...d.loan_pricing_profile!, amort_wam_override: e.target.value ? parseInt(e.target.value) : null } }))} style={{...inputStyle, width: 60}} />
              <label style={labelStyle}>Balloon</label>
              <input type="number" value={deal.loan_pricing_profile.balloon_override ?? ''} onChange={e => setDeal(d => ({ ...d, loan_pricing_profile: { ...d.loan_pricing_profile!, balloon_override: e.target.value ? parseInt(e.target.value) : null } }))} style={{...inputStyle, width: 60}} />
              <label style={labelStyle}>IO Period</label>
              <input type="number" value={deal.loan_pricing_profile.io_period_override ?? ''} onChange={e => setDeal(d => ({ ...d, loan_pricing_profile: { ...d.loan_pricing_profile!, io_period_override: e.target.value ? parseInt(e.target.value) : null } }))} style={{...inputStyle, width: 60}} />
            </>}
          </div>
        </Section>

        {/* ── BOND STRUCTURE ── */}
        <Section title="Bond Structure">
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
                          {cls.class_type !== 'IO' && <input type="number" value={cls.original_balance} onChange={e => updateClass(i, 'original_balance', parseFloat(e.target.value))} style={{...inputStyle, width: 90}} />}
                        </td>
                        <td style={tdStyle}>
                          {cls.class_type !== 'IO' && <select value={cls.coupon_type} onChange={e => updateClass(i, 'coupon_type', e.target.value)} style={{...inputStyle, width: 55}}><option value="FIX">FIX</option><option value="WAC">WAC</option></select>}
                        </td>
                        <td style={tdStyle}>
                          {cls.class_type !== 'IO' && cls.coupon_type === 'FIX' && <input type="number" step="0.0025" value={cls.coupon_fix} onChange={e => updateClass(i, 'coupon_fix', parseFloat(e.target.value))} style={{...inputStyle, width: 70}} />}
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
              {deal.cpj.enabled && (
                <div>
                  <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#94a3b8' }}>Bond Collateral (CPJ)</h4>
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
                <th key={bid} style={{...thStyle, borderLeft: '2px solid #475569'}} colSpan={4}>{bid}</th>
              ))}
            </tr>
            <tr>
              <th style={{...thStyle, borderLeft: '2px solid #475569'}}>Beg Bal</th><th style={thStyle}>Interest</th><th style={thStyle}>Principal</th><th style={thStyle}>End Bal</th>
              {bondIds.map(bid => (
                <React.Fragment key={bid}>
                  <th style={{...thStyle, borderLeft: '2px solid #475569'}}>Beg Bal</th><th style={thStyle}>Int Paid</th><th style={thStyle}>Prin Paid</th><th style={thStyle}>End Bal</th>
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
