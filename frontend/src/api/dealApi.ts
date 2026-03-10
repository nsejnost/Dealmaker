import type { Deal, DealResult } from '../types/deal';

const BASE = '/api/deals';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const json = JSON.parse(text);
      if (json.detail) detail = json.detail;
    } catch {}
    throw new Error(`API error ${res.status}: ${detail}`);
  }
  return res.json();
}

export const dealApi = {
  getDefaults: () => fetchJson<Deal>(`${BASE}/defaults`),

  listDeals: () => fetchJson<{ deal_id: string; deal_name: string }[]>(`${BASE}/list`),

  getDeal: (id: string) => fetchJson<Deal>(`${BASE}/${id}`),

  createDeal: (deal: Deal) =>
    fetchJson<Deal>(`${BASE}/create`, {
      method: 'POST',
      body: JSON.stringify(deal),
    }),

  updateDeal: (id: string, deal: Deal) =>
    fetchJson<Deal>(`${BASE}/${id}`, {
      method: 'PUT',
      body: JSON.stringify(deal),
    }),

  cloneDeal: (id: string, newName?: string) =>
    fetchJson<Deal>(`${BASE}/${id}/clone?new_name=${encodeURIComponent(newName || '')}`, {
      method: 'POST',
    }),

  runDeal: (id: string) =>
    fetchJson<DealResult>(`${BASE}/${id}/run`, { method: 'POST' }),

  runInline: (deal: Deal) =>
    fetchJson<DealResult>(`${BASE}/run-inline`, {
      method: 'POST',
      body: JSON.stringify(deal),
    }),

  deleteDeal: (id: string) =>
    fetchJson<void>(`${BASE}/${id}`, { method: 'DELETE' }),

  getPldCurve: () => fetchJson<any[]>(`${BASE}/pld-curve`),

  getTsyCurve: () => fetchJson<any>(`${BASE}/tsy-curve`),

  runScenarios: (id: string) =>
    fetchJson<any>(`${BASE}/${id}/scenarios`, { method: 'POST' }),

  exportCashflows: (id: string) => fetchJson<any>(`${BASE}/${id}/export/cashflows`),

  computeCurrentFace: (deal: Deal) =>
    fetchJson<{ original_face: number; current_face: number; factor: number }[]>(`${BASE}/current-face`, {
      method: 'POST',
      body: JSON.stringify(deal),
    }),
};
