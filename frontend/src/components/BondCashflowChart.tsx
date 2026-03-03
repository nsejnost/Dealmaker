import React from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { BondCashflowRow } from '../types/deal';

const COLORS = ['#38bdf8', '#a78bfa', '#fbbf24', '#f472b6', '#10b981', '#f97316'];

interface Props {
  data: Record<string, BondCashflowRow[]>;
}

export function BondCashflowChart({ data }: Props) {
  const classIds = Object.keys(data);
  if (!classIds.length) return null;

  const maxMonths = Math.max(...classIds.map(id => data[id].length));

  const chartData = [];
  for (let i = 0; i < maxMonths; i++) {
    const row: any = { month: i };
    for (const id of classIds) {
      const cf = data[id]?.[i];
      if (cf) {
        row[`${id}_bal`] = cf.end_bal;
        row[`${id}_prn`] = cf.principal_paid;
        row[`${id}_int`] = cf.interest_paid;
      }
    }
    if (i > 0) chartData.push(row);
  }

  return (
    <div>
      <h4 style={{ color: '#94a3b8', fontSize: 13, marginBottom: 8 }}>Bond Balances</h4>
      <ResponsiveContainer width="100%" height={250}>
        <ComposedChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="month" stroke="#64748b" fontSize={10} />
          <YAxis stroke="#64748b" fontSize={10} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
          <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #475569', fontSize: 11 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {classIds.map((id, i) => (
            <Line key={id} dataKey={`${id}_bal`} stroke={COLORS[i % COLORS.length]} name={`${id} Bal`} dot={false} strokeWidth={2} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      <h4 style={{ color: '#94a3b8', fontSize: 13, margin: '16px 0 8px' }}>Bond Cashflows</h4>
      <ResponsiveContainer width="100%" height={250}>
        <ComposedChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis dataKey="month" stroke="#64748b" fontSize={10} />
          <YAxis stroke="#64748b" fontSize={10} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
          <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #475569', fontSize: 11 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {classIds.map((id, i) => (
            <Bar key={`${id}_prn`} dataKey={`${id}_prn`} fill={COLORS[i % COLORS.length]} name={`${id} Prn`} stackId="prn" />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
