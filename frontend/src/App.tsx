import React, { useState, useEffect, useCallback } from 'react';
import type { Deal, DealResult, BondClass, PLDCurveEntry, CashflowRow, BondCashflowRow } from './types/deal';
import { dealApi } from './api/dealApi';
import { CashflowChart } from './components/CashflowChart';
import { BondCashflowChart } from './components/BondCashflowChart';
import { CapitalStack } from './components/CapitalStack';

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

type Tab = 'collateral' | 'pricing' | 'structure' | 'results';

export default function App() {
  const [deal, setDeal] = useState<Deal>(makeDefaultDeal());
  const [result, setResult] = useState<DealResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('collateral');
  const [savedDeals, setSavedDeals] = useState<{deal_id: string; deal_name: string}[]>([]);
  const [showPLD, setShowPLD] = useState(false);

  useEffect(() => {
    dealApi.listDeals().then(setSavedDeals).catch(() => {});
  }, []);

  const runDeal = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await dealApi.runInline(deal);
      setResult(res);
      setTab('results');
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
      // Update priority ranks for SEQ
      let rank = 1;
      classes.forEach(c => { if (c.class_type === 'SEQ') c.priority_rank = rank++; });
      return { ...d, structure: { ...d.structure, classes } };
    });
  };

  const fmt = (n: number, dec = 2) => n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const fmtPct = (n: number, dec = 4) => (n * 100).toFixed(dec) + '%';

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', background: '#0f172a', color: '#e2e8f0', minHeight: '100vh' }}>
      {/* Header */}
      <header style={{ background: '#1e293b', borderBottom: '1px solid #334155', padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <h1 style={{ margin: 0, fontSize: 20, color: '#38bdf8' }}>GNR Deal Maker</h1>
          <span style={{ color: '#94a3b8', fontSize: 13 }}>Ginnie Mae Project Loan REMIC</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={deal.deal_name}
            onChange={e => setDeal(d => ({ ...d, deal_name: e.target.value }))}
            style={{ ...inputStyle, width: 200 }}
          />
          <button onClick={saveDeal} style={btnSecondary}>Save</button>
          <button onClick={runDeal} disabled={loading} style={btnPrimary}>
            {loading ? 'Running...' : 'Run Deal'}
          </button>
        </div>
      </header>

      {error && <div style={{ background: '#7f1d1d', color: '#fca5a5', padding: '8px 24px', fontSize: 13 }}>{error}</div>}

      {/* Deal selector */}
      {savedDeals.length > 0 && (
        <div style={{ padding: '8px 24px', background: '#1e293b', borderBottom: '1px solid #334155', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: '#94a3b8', fontSize: 13, lineHeight: '28px' }}>Saved:</span>
          {savedDeals.map(d => (
            <button key={d.deal_id} onClick={() => loadDeal(d.deal_id)} style={{ ...btnSmall, background: deal.deal_id === d.deal_id ? '#2563eb' : '#334155' }}>
              {d.deal_name}
            </button>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, background: '#1e293b', borderBottom: '2px solid #334155' }}>
        {(['collateral', 'pricing', 'structure', 'results'] as Tab[]).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '10px 24px', background: 'transparent', border: 'none', color: tab === t ? '#38bdf8' : '#94a3b8',
            borderBottom: tab === t ? '2px solid #38bdf8' : '2px solid transparent', cursor: 'pointer', fontSize: 14, fontWeight: 500,
            textTransform: 'capitalize',
          }}>{t}</button>
        ))}
      </div>

      <div style={{ padding: 24 }}>
        {/* COLLATERAL TAB */}
        {tab === 'collateral' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 24 }}>
            {/* Payment Info */}
            <div style={panelStyle}>
              <h3 style={panelHeader}>Payment Information</h3>
              <Field label="Dated Date" value={deal.loan.dated_date} onChange={v => updateLoan('dated_date', v)} type="date" />
              <Field label="1st Settle" value={deal.loan.first_settle} onChange={v => updateLoan('first_settle', v)} type="date" />
              <Field label="Delay (days)" value={deal.loan.delay} onChange={v => updateLoan('delay', parseInt(v))} type="number" />
              <Field label="Original Face" value={deal.loan.original_face} onChange={v => updateLoan('original_face', parseFloat(v))} type="number" />
            </div>
            {/* Amortization Info */}
            <div style={panelStyle}>
              <h3 style={panelHeader}>Amortization Information</h3>
              <Field label="Coupon (Net)" value={deal.loan.coupon_net} onChange={v => updateLoan('coupon_net', parseFloat(v))} type="number" step="0.0025" />
              <Field label="WAC (Gross)" value={deal.loan.wac_gross} onChange={v => updateLoan('wac_gross', parseFloat(v))} type="number" step="0.0025" />
              <Field label="WAM (months)" value={deal.loan.wam} onChange={v => updateLoan('wam', parseInt(v))} type="number" />
              <Field label="Amort WAM" value={deal.loan.amort_wam} onChange={v => updateLoan('amort_wam', parseInt(v))} type="number" />
              <Field label="IO Period (mo)" value={deal.loan.io_period} onChange={v => updateLoan('io_period', parseInt(v))} type="number" />
              <Field label="Balloon (mo)" value={deal.loan.balloon} onChange={v => updateLoan('balloon', parseInt(v))} type="number" />
              <Field label="Seasoning (mo)" value={deal.loan.seasoning} onChange={v => updateLoan('seasoning', parseInt(v))} type="number" />
              <Field label="Lockout (mo)" value={deal.loan.lockout_months} onChange={v => updateLoan('lockout_months', parseInt(v))} type="number" />
              <div style={{ marginTop: 8, fontSize: 12, color: '#64748b' }}>
                Fee = {((deal.loan.wac_gross - deal.loan.coupon_net) * 10000).toFixed(0)} bp
                &nbsp;|&nbsp; Term = {Math.floor(deal.loan.wam / 12)}yr {deal.loan.wam % 12}mo
              </div>
            </div>
            {/* CPJ & Loan Pricing */}
            <div>
              <div style={panelStyle}>
                <h3 style={panelHeader}>CPJ Prepayment Overlay</h3>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <input type="checkbox" checked={deal.cpj.enabled} onChange={e => updateCPJ('enabled', e.target.checked)} />
                  Enable CPJ
                </label>
                {deal.cpj.enabled && (
                  <>
                    <Field label="CPJ Speed" value={deal.cpj.cpj_speed} onChange={v => updateCPJ('cpj_speed', parseFloat(v))} type="number" />
                    <Field label="Lockout (mo)" value={deal.cpj.lockout_months} onChange={v => updateCPJ('lockout_months', parseInt(v))} type="number" />
                    <Field label="PLD Multiplier" value={deal.cpj.pld_multiplier} onChange={v => updateCPJ('pld_multiplier', parseFloat(v))} type="number" step="0.1" />
                    <button onClick={() => setShowPLD(!showPLD)} style={{ ...btnSmall, marginTop: 8 }}>
                      {showPLD ? 'Hide' : 'Edit'} PLD Curve
                    </button>
                    {showPLD && (
                      <div style={{ marginTop: 8 }}>
                        <table style={tableStyle}>
                          <thead><tr><th style={thStyle}>From</th><th style={thStyle}>To</th><th style={thStyle}>Rate</th></tr></thead>
                          <tbody>
                            {deal.cpj.pld_curve.map((e, i) => (
                              <tr key={i}>
                                <td style={tdStyle}>{e.start_month}</td>
                                <td style={tdStyle}>{e.end_month}</td>
                                <td style={tdStyle}>
                                  <input type="number" step="0.001" value={e.annual_rate}
                                    onChange={ev => {
                                      const curve = [...deal.cpj.pld_curve];
                                      curve[i] = { ...curve[i], annual_rate: parseFloat(ev.target.value) };
                                      updateCPJ('pld_curve', curve);
                                    }}
                                    style={{ ...inputStyle, width: 80 }} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </div>
              <div style={{ ...panelStyle, marginTop: 16 }}>
                <h3 style={panelHeader}>Loan Pricing Profile</h3>
                <p style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>Override terms for loan valuation only</p>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <input type="checkbox"
                    checked={deal.loan_pricing_profile !== null}
                    onChange={e => setDeal(d => ({
                      ...d,
                      loan_pricing_profile: e.target.checked
                        ? { amort_wam_override: 480, balloon_override: 120, io_period_override: null, wam_override: null }
                        : null,
                    }))}
                  />
                  Enable Loan Pricing Mode
                </label>
                {deal.loan_pricing_profile && (
                  <>
                    <Field label="Amort WAM Override" value={deal.loan_pricing_profile.amort_wam_override ?? ''}
                      onChange={v => setDeal(d => ({ ...d, loan_pricing_profile: { ...d.loan_pricing_profile!, amort_wam_override: v ? parseInt(v) : null } }))} type="number" />
                    <Field label="Balloon Override" value={deal.loan_pricing_profile.balloon_override ?? ''}
                      onChange={v => setDeal(d => ({ ...d, loan_pricing_profile: { ...d.loan_pricing_profile!, balloon_override: v ? parseInt(v) : null } }))} type="number" />
                    <Field label="IO Period Override" value={deal.loan_pricing_profile.io_period_override ?? ''}
                      onChange={v => setDeal(d => ({ ...d, loan_pricing_profile: { ...d.loan_pricing_profile!, io_period_override: v ? parseInt(v) : null } }))} type="number" />
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* PRICING TAB */}
        {tab === 'pricing' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <div style={panelStyle}>
              <h3 style={panelHeader}>Pricing</h3>
              <Field label="Pricing Type" value={deal.pricing.pricing_type}
                onChange={v => updatePricing('pricing_type', v)} type="select" options={['Price', 'Yield']} />
              <Field label="Pricing Input" value={deal.pricing.pricing_input}
                onChange={v => updatePricing('pricing_input', parseFloat(v))} type="number" step="0.01" />
              <Field label="Settle Date" value={deal.pricing.settle_date}
                onChange={v => updatePricing('settle_date', v)} type="date" />
              <Field label="Curve Date" value={deal.pricing.curve_date}
                onChange={v => updatePricing('curve_date', v)} type="date" />
            </div>
            <div style={panelStyle}>
              <h3 style={panelHeader}>Treasury Curve</h3>
              <table style={tableStyle}>
                <thead><tr><th style={thStyle}>Term (yr)</th><th style={thStyle}>Rate (%)</th></tr></thead>
                <tbody>
                  {deal.treasury_curve.points.map((p, i) => (
                    <tr key={i}>
                      <td style={tdStyle}>{p.term < 1 ? `${(p.term * 12).toFixed(0)}mo` : `${p.term}yr`}</td>
                      <td style={tdStyle}>
                        <input type="number" step="0.001" value={p.rate}
                          onChange={e => {
                            const pts = [...deal.treasury_curve.points];
                            pts[i] = { ...pts[i], rate: parseFloat(e.target.value) };
                            setDeal(d => ({ ...d, treasury_curve: { points: pts } }));
                          }}
                          style={{ ...inputStyle, width: 80 }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* STRUCTURE TAB */}
        {tab === 'structure' && (
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
            <div style={panelStyle}>
              <h3 style={panelHeader}>Bond Classes</h3>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <button onClick={() => addClass('SEQ')} style={btnSecondary}>+ SEQ</button>
                <button onClick={() => addClass('PT')} style={btnSecondary}>+ PT</button>
                <button onClick={() => addClass('IO')} style={btnSecondary}>+ IO</button>
              </div>
              {deal.structure.classes.length === 0 && (
                <p style={{ color: '#64748b' }}>No classes defined. Add SEQ, PT, or IO classes above.</p>
              )}
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>ID</th><th style={thStyle}>Type</th><th style={thStyle}>Balance</th>
                    <th style={thStyle}>Coupon</th><th style={thStyle}>Rate/Type</th><th style={thStyle}>Rank</th><th style={thStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {deal.structure.classes.map((cls, i) => (
                    <tr key={i}>
                      <td style={tdStyle}>
                        <input value={cls.class_id} onChange={e => updateClass(i, 'class_id', e.target.value)} style={{ ...inputStyle, width: 80 }} />
                      </td>
                      <td style={tdStyle}><span style={{ color: cls.class_type === 'SEQ' ? '#38bdf8' : cls.class_type === 'PT' ? '#a78bfa' : '#fbbf24' }}>{cls.class_type}</span></td>
                      <td style={tdStyle}>
                        {cls.class_type !== 'IO' && (
                          <input type="number" value={cls.original_balance} onChange={e => updateClass(i, 'original_balance', parseFloat(e.target.value))} style={{ ...inputStyle, width: 100 }} />
                        )}
                      </td>
                      <td style={tdStyle}>
                        {cls.class_type !== 'IO' && (
                          <select value={cls.coupon_type} onChange={e => updateClass(i, 'coupon_type', e.target.value)} style={inputStyle}>
                            <option value="FIX">FIX</option>
                            <option value="WAC">WAC</option>
                          </select>
                        )}
                      </td>
                      <td style={tdStyle}>
                        {cls.class_type !== 'IO' && cls.coupon_type === 'FIX' && (
                          <input type="number" step="0.0025" value={cls.coupon_fix} onChange={e => updateClass(i, 'coupon_fix', parseFloat(e.target.value))} style={{ ...inputStyle, width: 80 }} />
                        )}
                        {cls.class_type !== 'IO' && cls.coupon_type === 'WAC' && (
                          <span style={{ color: '#a78bfa' }}>WAC</span>
                        )}
                      </td>
                      <td style={tdStyle}>{cls.class_type === 'SEQ' ? cls.priority_rank : '-'}</td>
                      <td style={tdStyle}>
                        <button onClick={() => moveClass(i, -1)} style={btnSmall}>^</button>
                        <button onClick={() => moveClass(i, 1)} style={btnSmall}>v</button>
                        <button onClick={() => removeClass(i)} style={{ ...btnSmall, color: '#f87171' }}>x</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 16 }}>
                <Field label="PT Share" value={deal.structure.pt_share}
                  onChange={v => setDeal(d => ({ ...d, structure: { ...d.structure, pt_share: parseFloat(v) } }))}
                  type="number" step="0.1" />
                <Field label="Fee Rate (annual)" value={deal.structure.fee_rate}
                  onChange={v => setDeal(d => ({ ...d, structure: { ...d.structure, fee_rate: parseFloat(v) } }))}
                  type="number" step="0.001" />
              </div>
            </div>
            <div>
              <CapitalStack classes={deal.structure.classes} />
              <div style={{ ...panelStyle, marginTop: 16 }}>
                <h3 style={panelHeader}>Waterfall Logic</h3>
                <pre style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'pre-wrap' }}>
{`Interest Waterfall:
1. Pay fees (fee_rate * collat_bal / 12)
2. Pay SEQ/PT interest by rank
   - FIX: bal * coupon_fix / 12
   - WAC: bal * pool_wac / 12
3. IO class receives remaining interest

Principal Waterfall:
1. PT group: min(pt_share * principal, group_bal)
   -> pro-rata within PT group
2. SEQ: sequential by priority_rank
   -> each class absorbs up to its balance`}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* RESULTS TAB */}
        {tab === 'results' && (
          <div>
            {!result && <p style={{ color: '#64748b' }}>Run the deal to see results.</p>}
            {result && (
              <>
                {/* Analytics side-by-side */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
                  <div style={panelStyle}>
                    <h3 style={panelHeader}>Collateral Analytics (Contractual)</h3>
                    {result.collateral_analytics && <AnalyticsTable a={result.collateral_analytics} />}
                  </div>
                  <div style={panelStyle}>
                    <h3 style={panelHeader}>Loan Pricing Analytics</h3>
                    {result.loan_pricing_analytics && <AnalyticsTable a={result.loan_pricing_analytics} />}
                  </div>
                </div>

                {/* Bond analytics */}
                {Object.keys(result.bond_analytics).length > 0 && (
                  <div style={{ ...panelStyle, marginBottom: 24 }}>
                    <h3 style={panelHeader}>Bond Analytics</h3>
                    <table style={tableStyle}>
                      <thead><tr><th style={thStyle}>Class</th><th style={thStyle}>Price</th><th style={thStyle}>WAL</th></tr></thead>
                      <tbody>
                        {Object.entries(result.bond_analytics).map(([id, a]) => (
                          <tr key={id}>
                            <td style={tdStyle}>{id}</td>
                            <td style={tdStyle}>{fmt(a.price, 4)}</td>
                            <td style={tdStyle}>{fmt(a.wal, 4)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Charts */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginBottom: 24 }}>
                  <div style={panelStyle}>
                    <h3 style={panelHeader}>Contractual Cashflows</h3>
                    <CashflowChart data={result.collateral_cashflows} />
                    <button onClick={() => exportCSV(result.collateral_cashflows, 'contractual_cashflows.csv')} style={{ ...btnSmall, marginTop: 8 }}>Export CSV</button>
                  </div>
                  {deal.cpj.enabled && (
                    <div style={panelStyle}>
                      <h3 style={panelHeader}>Bond Collateral (CPJ) Cashflows</h3>
                      <CashflowChart data={result.bond_collateral_cashflows} />
                      <button onClick={() => exportCSV(result.bond_collateral_cashflows, 'cpj_cashflows.csv')} style={{ ...btnSmall, marginTop: 8 }}>Export CSV</button>
                    </div>
                  )}
                </div>

                {/* Bond class cashflows */}
                {Object.keys(result.bond_cashflows).length > 0 && (
                  <div style={{ ...panelStyle, marginBottom: 24 }}>
                    <h3 style={panelHeader}>Bond Class Cashflows</h3>
                    <BondCashflowChart data={result.bond_cashflows} />
                  </div>
                )}

                {/* Cashflow table */}
                <div style={panelStyle}>
                  <h3 style={panelHeader}>Contractual Cashflow Table</h3>
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
                            <td style={tdStyle}>{cf.date_serial}</td>
                            <td style={tdStyle}>{cf.cf_date_serial}</td>
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
                  <button onClick={() => exportCSV(result.collateral_cashflows, 'cashflows.csv')} style={{ ...btnSmall, marginTop: 8 }}>Export CSV</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AnalyticsTable({ a }: { a: any }) {
  return (
    <table style={tableStyle}>
      <tbody>
        <tr><td style={tdStyle}>Price</td><td style={tdStyleR}>{a.price.toFixed(4)}</td></tr>
        <tr><td style={tdStyle}>Accrued</td><td style={tdStyleR}>{a.accrued.toFixed(6)}</td></tr>
        <tr><td style={tdStyle}>Yield (%)</td><td style={tdStyleR}>{a.yield_pct.toFixed(6)}</td></tr>
        <tr><td style={tdStyle}>J-Spread (bp)</td><td style={tdStyleR}>{a.j_spread.toFixed(4)}</td></tr>
        <tr><td style={tdStyle}>WAL</td><td style={tdStyleR}>{a.wal.toFixed(6)}</td></tr>
        <tr><td style={tdStyle}>Modified Duration</td><td style={tdStyleR}>{a.modified_duration.toFixed(6)}</td></tr>
        <tr><td style={tdStyle}>Convexity</td><td style={tdStyleR}>{a.convexity.toFixed(6)}</td></tr>
        <tr><td style={tdStyle}>Risk (dP/dY)</td><td style={tdStyleR}>{a.risk_dpdy.toFixed(6)}</td></tr>
        <tr><td style={tdStyle}>Tsy Rate @ WAL</td><td style={tdStyleR}>{a.tsy_rate_at_wal.toFixed(6)}</td></tr>
      </tbody>
    </table>
  );
}

function Field({ label, value, onChange, type = 'text', step, options }: {
  label: string; value: any; onChange: (v: string) => void; type?: string; step?: string; options?: string[];
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <label style={{ width: 140, fontSize: 13, color: '#94a3b8' }}>{label}</label>
      {type === 'select' ? (
        <select value={value} onChange={e => onChange(e.target.value)} style={inputStyle}>
          {options?.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input type={type} step={step} value={value} onChange={e => onChange(e.target.value)} style={inputStyle} />
      )}
    </div>
  );
}

// Styles
const inputStyle: React.CSSProperties = {
  background: '#1e293b', border: '1px solid #475569', borderRadius: 4, color: '#e2e8f0',
  padding: '4px 8px', fontSize: 13,
};
const panelStyle: React.CSSProperties = {
  background: '#1e293b', borderRadius: 8, padding: 16, border: '1px solid #334155',
};
const panelHeader: React.CSSProperties = {
  margin: '0 0 12px 0', fontSize: 15, color: '#38bdf8', fontWeight: 600,
};
const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse', fontSize: 12,
};
const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #475569', color: '#94a3b8', fontWeight: 500,
};
const tdStyle: React.CSSProperties = {
  padding: '4px 8px', borderBottom: '1px solid #1e293b',
};
const tdStyleR: React.CSSProperties = {
  ...tdStyle, textAlign: 'right', fontFamily: 'monospace',
};
const btnPrimary: React.CSSProperties = {
  background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 20px',
  cursor: 'pointer', fontSize: 14, fontWeight: 500,
};
const btnSecondary: React.CSSProperties = {
  background: '#334155', color: '#e2e8f0', border: '1px solid #475569', borderRadius: 6,
  padding: '6px 16px', cursor: 'pointer', fontSize: 13,
};
const btnSmall: React.CSSProperties = {
  background: '#334155', color: '#e2e8f0', border: '1px solid #475569', borderRadius: 4,
  padding: '3px 10px', cursor: 'pointer', fontSize: 11,
};
