// Business rules: settings, audit, booking money, finance totals, attendance calculations.
const db = require('./db');
const U = require('./util');

const STATUSES = ['Pending Review', 'Contacted', 'Awaiting Customer Confirmation', 'Quotation Sent', 'Awaiting Payment',
  'Processing Booking', 'Booked / Confirmed', 'Completed', 'Cancelled', 'Rejected'];
const OPEN_STATUSES = STATUSES.filter((s) => !['Completed', 'Cancelled', 'Rejected'].includes(s));
const BOOKING_STATUSES = ['Quoted', 'Confirmed', 'Completed', 'Cancelled'];
const SERVICE_TYPES = ['Domestic flight', 'International flight', 'Hotel reservation', 'Travel package', 'Group booking', 'Other travel service'];
const METHODS = ['Cash', 'GCash', 'Maya', 'Bank transfer', 'Credit/debit card', 'Check', 'Other'];
const EXPENSE_CATS = ['Office supplies', 'Internet & utilities', 'Transportation', 'Rent', 'Salaries', 'Marketing', 'Other operational'];

const settings = () => {
  const s = Object.fromEntries(db.all('SELECT key,value FROM settings').map((r) => [r.key, r.value]));
  s.phones = [s.phone, s.mobile].filter(Boolean).join(' · ');
  const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
  s.fareList = lines(s.fares).map((l) => {
    const [route, amt] = l.split('|').map((x) => x.trim());
    const [from, to] = route.split(/\s+to\s+/i);
    return { route, from: from || '', to: to || '', cents: U.toCents(amt) };
  }).filter((f) => Number.isFinite(f.cents));
  s.whyList = lines(s.why).map((l) => { const [t, d] = l.split('|'); return { t: (t || '').trim(), d: (d || '').trim() }; });
  s.partnerList = String(s.partners || '').split(',').map((x) => x.trim()).filter(Boolean);
  return s;
};

function audit(req, action, entity, entityId, detail) {
  const u = req && req.session && req.session.user;
  db.run('INSERT INTO audit_logs (at,user_id,username,action,entity,entity_id,detail,ip) VALUES (?,?,?,?,?,?,?,?)',
    [U.now(), u ? u.id : null, u ? u.username : null, action, entity, entityId == null ? null : String(entityId),
      typeof detail === 'string' ? detail : JSON.stringify(detail || {}), req ? req.ip : null]);
}

// ---------- bookings / payments ----------
const total = (b) => b.selling_price + b.service_fee - b.discount;           // total amount payable
const payStatus = (tot, paid) => (paid <= 0 ? 'Unpaid' : paid < tot ? 'Partially Paid' : paid === tot ? 'Paid' : 'Overpaid');

// Valid payments minus valid refunds, per booking.
const PAID_SQL = `COALESCE((SELECT SUM(CASE kind WHEN 'Payment' THEN amount ELSE -amount END)
  FROM payments p WHERE p.booking_id=b.id AND p.status='Valid'),0)`;

function decorate(b) {
  b.total = total(b);
  b.balance = b.status === 'Cancelled' ? 0 : Math.max(0, b.total - b.paid);
  b.pay_status = payStatus(b.total, b.paid);
  b.margin = b.total - b.supplier_cost;
  return b;
}
const bookingSelect = `SELECT b.*, c.name AS customer, c.code AS customer_code, u.name AS employee, ${PAID_SQL} AS paid
  FROM bookings b JOIN customers c ON c.id=b.customer_id LEFT JOIN users u ON u.id=b.assigned_to`;

// ---------- finance ----------
// Accounting assumptions (shown on the Financial Reports page):
//  * Sales (quoted+confirmed+completed) are by booking date; Cancelled bookings are excluded everywhere.
//  * Confirmed value = Confirmed + Completed bookings. Supplier cost and margin are recognised on confirmed value only.
//  * Collections = valid payments less valid refunds, by payment date (cash basis). Reversed payments are ignored.
//  * Gross booking margin = confirmed value − supplier cost. Net operating result = gross margin − valid expenses.
//  * Outstanding balance = sum of (total payable − net paid) on Confirmed/Completed bookings, regardless of date range.
function finance(from, to) {
  const d = (col) => `substr(${col},1,10) BETWEEN ? AND ?`;
  const rng = [from, to];
  const sales = db.get(`SELECT
      COALESCE(SUM(CASE WHEN status!='Cancelled' THEN selling_price+service_fee-discount END),0) AS booking_sales,
      COALESCE(SUM(CASE WHEN status='Quoted' THEN selling_price+service_fee-discount END),0) AS quoted,
      COALESCE(SUM(CASE WHEN status IN ('Confirmed','Completed') THEN selling_price+service_fee-discount END),0) AS confirmed,
      COALESCE(SUM(CASE WHEN status='Completed' THEN selling_price+service_fee-discount END),0) AS completed,
      COALESCE(SUM(CASE WHEN status='Cancelled' THEN selling_price+service_fee-discount END),0) AS cancelled,
      COALESCE(SUM(CASE WHEN status IN ('Confirmed','Completed') THEN supplier_cost END),0) AS supplier_costs,
      COALESCE(SUM(CASE WHEN status IN ('Confirmed','Completed') THEN service_fee END),0) AS fees,
      COALESCE(SUM(CASE WHEN status IN ('Confirmed','Completed') THEN discount END),0) AS discounts,
      COUNT(CASE WHEN status='Confirmed' THEN 1 END) AS n_confirmed, COUNT(CASE WHEN status='Completed' THEN 1 END) AS n_completed
    FROM bookings WHERE ${d('created_at')}`, rng);
  const pay = db.get(`SELECT
      COALESCE(SUM(CASE WHEN kind='Payment' THEN amount END),0) AS received,
      COALESCE(SUM(CASE WHEN kind='Refund' THEN amount END),0) AS refunds
    FROM payments WHERE status='Valid' AND ${d('paid_at')}`, rng);
  const expenses = db.val(`SELECT COALESCE(SUM(amount),0) FROM expenses WHERE status='Valid' AND ${d('spent_at')}`, rng);
  const outstanding = db.val(`SELECT COALESCE(SUM(MAX(0, (selling_price+service_fee-discount) - ${PAID_SQL})),0)
    FROM bookings b WHERE status IN ('Confirmed','Completed')`);
  const collected = pay.received - pay.refunds;
  const grossMargin = sales.confirmed - sales.supplier_costs;
  return { ...sales, collected, received: pay.received, refunds: pay.refunds, expenses, outstanding,
    grossMargin, net: grossMargin - expenses };
}

// ---------- attendance ----------
function schedFor(u) { return { start: u.sched_start, end: u.sched_end, grace: u.grace_min, brk: u.break_min, days: String(u.workdays).split(',').filter(Boolean).map(Number) }; }

// Late = time-in later than scheduled start + grace period.
function lateInfo(u, timeIn) {
  const s = schedFor(u);
  const over = U.tmins(timeIn) - U.mins(s.start);
  return over > s.grace ? { is_late: 1, late_min: over } : { is_late: 0, late_min: 0 };
}

// Worked minutes; unpaid break is deducted only when the shift spans longer than the break + 1h.
function workedMin(u, r) {
  if (!r || !r.time_in || !r.time_out) return 0;
  const span = U.diffMin(r.time_in, r.time_out);
  if (span <= 0) return 0;
  return Math.max(0, span - (span > u.break_min + 60 ? u.break_min : 0));
}

// Build the per-day attendance status list for one employee between two dates (inclusive), up to today.
function daily(u, from, to) {
  const nowStr = U.now(), today = nowStr.slice(0, 10), s = schedFor(u);
  const recs = Object.fromEntries(db.all('SELECT * FROM attendance WHERE user_id=? AND day BETWEEN ? AND ?', [u.id, from, to]).map((r) => [r.day, r]));
  const lv = db.all('SELECT * FROM leaves WHERE (user_id=? OR user_id IS NULL) AND day BETWEEN ? AND ?', [u.id, from, to]);
  const hol = new Set(lv.filter((l) => l.kind === 'Holiday').map((l) => l.day));
  const leave = new Set(lv.filter((l) => l.kind === 'Leave').map((l) => l.day));
  const startDay = u.created_at.slice(0, 10);
  const out = [];
  for (let d = from; d <= to; d = U.addDays(d, 1)) {
    if (d > today) break;
    const r = recs[d];
    const row = { day: d, rec: r || null, scheduled: s.days.includes(U.dow(d)), mins: workedMin(u, r), status: '', late: !!(r && r.is_late), late_min: r ? r.late_min : 0 };
    if (r && r.time_in) {
      row.status = !r.time_out && (d < today || nowStr.slice(11, 16) > s.end) ? 'Incomplete' : !r.time_out ? 'Clocked in' : r.is_late ? 'Late' : 'Present';
    } else if (hol.has(d)) row.status = 'Holiday';
    else if (leave.has(d)) row.status = 'Approved leave';
    else if (!row.scheduled) row.status = 'Rest day';
    else if (d < startDay) row.status = 'Not employed';
    else if (d < today || nowStr.slice(11, 16) > s.end) row.status = 'Absent';   // cutoff = scheduled end of shift
    else row.status = 'Pending';
    out.push(row);
  }
  return out;
}

function summarize(u, rows) {
  const att = rows.filter((r) => r.rec && r.rec.time_in);
  const sched = rows.filter((r) => r.scheduled && !['Holiday', 'Approved leave', 'Not employed'].includes(r.status) && r.status !== 'Pending');
  const mins = rows.reduce((a, r) => a + r.mins, 0);
  const days = att.length, absent = rows.filter((r) => r.status === 'Absent').length;
  const expected = sched.length;
  return { user: u, scheduled: expected, days, absent, leave: rows.filter((r) => r.status === 'Approved leave').length,
    holidays: rows.filter((r) => r.status === 'Holiday').length, late: att.filter((r) => r.rec.is_late).length,
    incomplete: rows.filter((r) => r.status === 'Incomplete').length, mins,
    avg: days ? mins / days : 0, pct: expected ? Math.min(100, Math.round((rows.filter((r) => r.scheduled && r.rec && r.rec.time_in).length / expected) * 1000) / 10) : 0 };
}

module.exports = { STATUSES, OPEN_STATUSES, BOOKING_STATUSES, SERVICE_TYPES, METHODS, EXPENSE_CATS, settings, audit, total, payStatus,
  PAID_SQL, decorate, bookingSelect, finance, schedFor, lateInfo, workedMin, daily, summarize };
