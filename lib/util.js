// Money (integer centavos), Asia/Manila time helpers, small utilities.
const crypto = require('crypto');
const TZ = 'Asia/Manila';

const dtf = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const now = () => dtf.format(new Date()).replace(' ', ' ');       // 'YYYY-MM-DD HH:mm:ss' Manila
const today = () => now().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();             // 0=Sun
const mins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const tmins = (dt) => mins(dt.slice(11, 16));
const diffMin = (a, b) => Math.round((Date.parse(b.replace(' ', 'T') + 'Z') - Date.parse(a.replace(' ', 'T') + 'Z')) / 60000);
const monthRange = (ym) => { const [y, m] = ym.split('-').map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`]; };

const toCents = (s) => {
  const n = Number(String(s ?? '').replace(/[₱,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
const peso = (c) => '₱' + ((c || 0) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plain = (c) => ((c || 0) / 100).toFixed(2);
const hrs = (m) => (m / 60).toFixed(2);

const rand = (n = 4) => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (const b of crypto.randomBytes(n)) s += A[b % A.length]; return s; };
// Quote cells; neutralise spreadsheet formula injection (leading = + @ or non-numeric -).
const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^([=+@\t\r]|-(?!\d))/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (head, rows) => '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

module.exports = { TZ, now, today, addDays, dow, mins, tmins, diffMin, monthRange, toCents, peso, plain, hrs, rand, toCsv };
