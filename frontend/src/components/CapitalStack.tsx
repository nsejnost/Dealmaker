import React from 'react';
import type { BondClass } from '../types/deal';

const COLORS: Record<string, string> = {
  SEQ: '#38bdf8',
  PT: '#a78bfa',
  IO: '#fbbf24',
};

interface Props {
  classes: BondClass[];
}

export function CapitalStack({ classes }: Props) {
  const totalBal = classes.reduce((s, c) => s + (c.original_balance || 0), 0);
  if (totalBal === 0 && classes.length === 0) {
    return (
      <div style={{ background: '#1e293b', borderRadius: 8, padding: 16, border: '1px solid #334155' }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: 15, color: '#38bdf8', fontWeight: 600 }}>Capital Stack</h3>
        <p style={{ color: '#64748b', fontSize: 13 }}>Add bond classes to see the capital stack.</p>
      </div>
    );
  }

  return (
    <div style={{ background: '#1e293b', borderRadius: 8, padding: 16, border: '1px solid #334155' }}>
      <h3 style={{ margin: '0 0 12px 0', fontSize: 15, color: '#38bdf8', fontWeight: 600 }}>Capital Stack</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {classes.filter(c => c.class_type !== 'IO').map((cls, i) => {
          const pct = totalBal > 0 ? (cls.original_balance / totalBal) * 100 : 0;
          return (
            <div key={i} style={{
              background: COLORS[cls.class_type] + '33',
              border: `1px solid ${COLORS[cls.class_type]}`,
              borderRadius: 4,
              padding: '8px 12px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                {cls.class_id} ({cls.class_type})
                {cls.coupon_type === 'WAC' ? ' [WAC]' : ` [${(cls.coupon_fix * 100).toFixed(2)}%]`}
              </span>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>
                {cls.original_balance.toLocaleString()} ({pct.toFixed(1)}%)
              </span>
            </div>
          );
        })}
        {classes.filter(c => c.class_type === 'IO').map((cls, i) => (
          <div key={`io-${i}`} style={{
            background: COLORS.IO + '33',
            border: `1px solid ${COLORS.IO}`,
            borderRadius: 4,
            padding: '8px 12px',
            fontSize: 13,
          }}>
            {cls.class_id} (IO) - Excess Interest
          </div>
        ))}
      </div>
    </div>
  );
}
