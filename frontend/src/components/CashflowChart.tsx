import React from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import type { CashflowRow } from '../types/deal';

interface Props {
  data: CashflowRow[];
}

export function CashflowChart({ data }: Props) {
  if (!data.length) return null;

  const chartData = data
    .filter(d => d.month > 0)
    .map(d => ({
      month: d.month,
      interest: d.int_to_inv,
      principal: d.reg_prn,
      balloon: d.balloon_pay,
      balance: d.end_bal,
      unsched: d.unsched_prn,
    }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis dataKey="month" stroke="#64748b" fontSize={10} />
        <YAxis yAxisId="left" stroke="#64748b" fontSize={10} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
        <YAxis yAxisId="right" orientation="right" stroke="#64748b" fontSize={10} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
        <Tooltip
          contentStyle={{ background: '#1e293b', border: '1px solid #475569', fontSize: 11 }}
          formatter={(v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 })}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar yAxisId="left" dataKey="interest" stackId="cf" fill="#38bdf8" name="Interest" />
        <Bar yAxisId="left" dataKey="principal" stackId="cf" fill="#a78bfa" name="Sched Prn" />
        <Bar yAxisId="left" dataKey="unsched" stackId="cf" fill="#f472b6" name="Unsched Prn" />
        <Bar yAxisId="left" dataKey="balloon" stackId="cf" fill="#fbbf24" name="Balloon" />
        <Line yAxisId="right" dataKey="balance" stroke="#10b981" dot={false} name="Balance" strokeWidth={2} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
