// Dashboards and owner-only modules.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../lib/db');
const U = require('../lib/util');
const B = require('../lib/biz');
const C = require('./common');

const page = (res, view, data) => res.page(view, data, 'app');
const str = (v, n = 500) => String(v ?? '').trim().slice(0, n);
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const bad = (req, res, msg, to) => { res.flash('err', msg); res.redirect(to || req.get('referer') || '/app'); };
const json = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const activeStaff = () => db.all('SELECT * FROM users WHERE active=1 ORDER BY name');

// Resolve a period selection (day/month/quarter/year/custom) to [from,to].
function period(q) {
  const t = U.today();
  let from, to;
  switch (q.period) {
    case 'day': from = to = validDate(q.from || '') ? q.from : t; break;
    case 'quarter': { const m = Number(t.slice(5, 7)), s = Math.floor((m - 1) / 3) * 3 + 1; from = `${t.slice(0, 4)}-${String(s).padStart(2, '0')}-01`; to = U.monthRange(`${t.slice(0, 4)}-${String(s + 2).padStart(2, '0')}`)[1]; break; }
    case 'year': from = `${t.slice(0, 4)}-01-01`; to = `${t.slice(0, 4)}-12-31`; break;
    case 'custom': from = validDate(q.from || '') ? q.from : t.slice(0, 7) + '-01'; to = validDate(q.to || '') ? q.to : t; break;
    default: [from, to] = U.monthRange(t.slice(0, 7)); q.period = 'month';
  }
  if (to < from) [from, to] = [to, from];
  if (U.diffMin(from + ' 00:00:00', to + ' 00:00:00') > 366 * 1440) from = U.addDays(to, -366);
  return { from, to, key: q.period };
}
const monthsBack = (to, n) => { const out = []; let [y, m] = to.slice(0, 7).split('-').map(Number); for (let i = 0; i < n; i++) { out.unshift(`${y}-${String(m).padStart(2, '0')}`); if (--m === 0) { m = 12; y--; } } return out; };

// ---------------- dashboard ----------------
router.get('/app', C.requireLogin, (req, res) => {
  const me = db.get('SELECT * FROM users WHERE id=?', [req.session.user.id]);
  const today = U.today();
  const rec = db.get('SELECT * FROM attendance WHERE user_id=? AND day=?', [me.id, today]);
  const counts = db.get(`SELECT
    (SELECT COUNT(*) FROM requests WHERE status='Pending Review') AS pending,
    (SELECT COUNT(*) FROM requests WHERE status NOT IN ('Completed','Cancelled','Rejected')) AS open_requests,
    (SELECT COUNT(*) FROM bookings WHERE status='Confirmed') AS confirmed,
    (SELECT COUNT(*) FROM bookings WHERE status='Completed') AS completed,
    (SELECT COUNT(*) FROM customers) AS customers,
    (SELECT COUNT(*) FROM messages WHERE handled=0) AS messages`);
  if (!C.isOwner(req)) {
    return page(res, 'app/dashboard-staff', { title: 'Dashboard', me, rec, counts,
      mine: db.all(`SELECT r.id,r.ref,r.status,r.service_type,c.name AS customer FROM requests r JOIN customers c ON c.id=r.customer_id
        WHERE r.assigned_to=? AND r.status NOT IN ('Completed','Cancelled','Rejected') ORDER BY r.id DESC LIMIT 8`, [me.id]),
      newest: db.all(`SELECT r.id,r.ref,r.service_type,r.created_at,c.name AS customer FROM requests r JOIN customers c ON c.id=r.customer_id WHERE r.status='Pending Review' ORDER BY r.id DESC LIMIT 8`),
      mins: B.workedMin(me, rec), sched: B.schedFor(me) });
  }
  const q = { ...req.query };
  const per = period(q), { from, to } = per;
  const f = B.finance(from, to);
  const newInq = db.val('SELECT COUNT(*) FROM requests WHERE substr(created_at,1,10) BETWEEN ? AND ?', [from, to]);

  // Employee monitoring cards (today)
  const staff = activeStaff();
  const todayRecs = db.all('SELECT * FROM attendance WHERE day=?', [today]);
  const todayRows = staff.map((u) => B.daily(u, today, today)[0]);
  const emp = { active: staff.length, timedIn: todayRecs.length, clockedIn: todayRecs.filter((r) => r.time_in && !r.time_out).length,
    late: todayRecs.filter((r) => r.is_late).length, absent: todayRows.filter((r) => r && r.status === 'Absent').length,
    incomplete: db.val(`SELECT COUNT(*) FROM attendance WHERE time_out IS NULL AND day<? AND day BETWEEN ? AND ?`, [today, from, to]) };

  // Charts
  const months = monthsBack(to, 12);
  const series = months.map((m) => { const [a, z] = U.monthRange(m); const x = B.finance(a, z); return { m, sales: x.booking_sales, collected: x.collected, expenses: x.expenses, net: x.net }; });
  const byService = db.all(`SELECT service_type AS k, COUNT(*) AS n FROM bookings WHERE status!='Cancelled' AND substr(created_at,1,10) BETWEEN ? AND ? GROUP BY 1`, [from, to]);
  const byStatus = db.all(`SELECT status AS k, COUNT(*) AS n FROM bookings WHERE substr(created_at,1,10) BETWEEN ? AND ? GROUP BY 1`, [from, to]);
  const inquiries = months.map((m) => db.val(`SELECT COUNT(*) FROM requests WHERE substr(created_at,1,7)=?`, [m]));
  const attMonthly = months.slice(-6).map((m) => db.val(`SELECT COUNT(*) FROM attendance WHERE substr(day,1,7)=?`, [m]));
  const perEmp = staff.filter((u) => u.role === 'employee' || true).map((u) => { const s = B.summarize(u, B.daily(u, from, to)); return { n: u.name, late: s.late, absent: s.absent }; });
  const chart = { months, sales: series.map((s) => s.sales / 100), collected: series.map((s) => s.collected / 100), expenses: series.map((s) => s.expenses / 100),
    net: series.map((s) => s.net / 100), byService, byStatus, inquiries, attMonthly: attMonthly, attMonths: months.slice(-6), perEmp };
  page(res, 'app/dashboard-owner', { title: 'Dashboard', per, f, counts, newInq, emp, chartJson: json(chart), rec, me, sched: B.schedFor(me), mins: B.workedMin(me, rec) });
});

// ---------------- financial management ----------------
router.get('/app/finance', C.requireOwner, (req, res) => {
  const q = { ...req.query }, per = period(q);
  const f = B.finance(per.from, per.to);
  const byService = db.all(`SELECT service_type AS k, COUNT(*) AS n, SUM(selling_price+service_fee-discount) AS sales, SUM(supplier_cost) AS cost, SUM(service_fee) AS fees
    FROM bookings WHERE status IN ('Confirmed','Completed') AND substr(created_at,1,10) BETWEEN ? AND ? GROUP BY 1 ORDER BY sales DESC`, [per.from, per.to]);
  const expCat = db.all(`SELECT category AS k, SUM(amount) AS total FROM expenses WHERE status='Valid' AND spent_at BETWEEN ? AND ? GROUP BY 1 ORDER BY total DESC`, [per.from, per.to]);
  const owing = db.all(`SELECT * FROM (${B.bookingSelect}) x WHERE status IN ('Confirmed','Completed')`).map(B.decorate).filter((b) => b.balance > 0).sort((a, b) => b.balance - a.balance).slice(0, 15);
  if (req.query.export === 'csv') {
    const rows = [['Booking sales (excl. cancelled)', U.plain(f.booking_sales)], ['Quoted', U.plain(f.quoted)], ['Confirmed booking value', U.plain(f.confirmed)], ['Completed value', U.plain(f.completed)],
      ['Cancelled value', U.plain(f.cancelled)], ['Payments received', U.plain(f.received)], ['Refunds', U.plain(f.refunds)], ['Net collected', U.plain(f.collected)],
      ['Supplier costs', U.plain(f.supplier_costs)], ['Service fees', U.plain(f.fees)], ['Gross booking margin', U.plain(f.grossMargin)], ['Business expenses', U.plain(f.expenses)],
      ['Net operating result', U.plain(f.net)], ['Outstanding balances (as of today)', U.plain(f.outstanding)]];
    return C.sendCsv(res, `financial-report-${per.from}_${per.to}`, ['Item', 'Amount (PHP)'], rows);
  }
  page(res, 'app/finance', { title: 'Financial Reports', per, f, byService, expCat, owing });
});

// ---------------- employees ----------------
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
router.get('/app/employees', C.requireOwner, (req, res) => page(res, 'app/employees', { title: 'Employee Management', users: db.all('SELECT * FROM users ORDER BY active DESC, name') }));
router.get('/app/employees/new', C.requireOwner, (req, res) => page(res, 'app/employee-form', { title: 'New employee', e: { role: 'employee', active: 1, sched_start: '08:00', sched_end: '17:00', grace_min: 10, break_min: 60, workdays: '1,2,3,4,5' }, errors: {}, DAYS, isNew: true }));
router.get('/app/employees/:id', C.requireOwner, (req, res, next) => {
  const e = db.get('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!e) return next();
  page(res, 'app/employee-form', { title: e.name, e, errors: {}, DAYS, isNew: false });
});
function employeeInput(b, isNew) {
  const e = { name: str(b.name, 120), email: str(b.email, 160), username: str(b.username, 40).toLowerCase(), role: b.role === 'owner' ? 'owner' : 'employee',
    active: b.active === 'on' ? 1 : 0, can_expenses: b.can_expenses === 'on' ? 1 : 0, sched_start: str(b.sched_start, 5), sched_end: str(b.sched_end, 5),
    grace_min: parseInt(b.grace_min, 10), break_min: parseInt(b.break_min, 10), workdays: [].concat(b.workdays || []).map(Number).filter((n) => n >= 0 && n <= 6).sort().join(',') };
  const errors = {};
  if (!e.name) errors.name = 'Required.';
  if (!/^[a-z0-9._-]{3,40}$/.test(e.username)) errors.username = '3–40 letters, numbers, dot, dash or underscore.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.sched_start)) errors.sched_start = 'Use HH:MM.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(e.sched_end) || e.sched_end <= e.sched_start) errors.sched_end = 'Must be after the start time.';
  if (!(e.grace_min >= 0 && e.grace_min <= 120)) errors.grace_min = '0–120 minutes.';
  if (!(e.break_min >= 0 && e.break_min <= 240)) errors.break_min = '0–240 minutes.';
  if (isNew && (String(b.password || '').length < 10 || !/\d/.test(b.password) || !/[a-z]/i.test(b.password))) errors.password = 'At least 10 characters with letters and numbers.';
  return { e, errors };
}
router.post('/app/employees/new', C.requireOwner, (req, res) => {
  const { e, errors } = employeeInput(req.body, true);
  if (!errors.username && db.get('SELECT 1 FROM users WHERE lower(username)=?', [e.username])) errors.username = 'Already taken.';
  if (Object.keys(errors).length) return page(res.status(422), 'app/employee-form', { title: 'New employee', e, errors, DAYS, isNew: true });
  const id = db.tx(() => {
    const i = db.run(`INSERT INTO users (name,email,username,password_hash,role,active,can_expenses,must_change_pw,sched_start,sched_end,grace_min,break_min,workdays,created_at) VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
      [e.name, e.email, e.username, bcrypt.hashSync(req.body.password, 12), e.role, e.active, e.can_expenses, e.sched_start, e.sched_end, e.grace_min, e.break_min, e.workdays, U.now()]);
    db.run('UPDATE users SET emp_no=? WHERE id=?', ['EMP-' + String(i).padStart(4, '0'), i]);
    return i;
  });
  B.audit(req, 'employee.create', 'user', id, { username: e.username, role: e.role });
  res.flash('ok', 'Employee created. They must change the password at first login.'); res.redirect('/app/employees');
});
router.post('/app/employees/:id', C.requireOwner, (req, res, next) => {
  const old = db.get('SELECT * FROM users WHERE id=?', [req.params.id]);
  if (!old) return next();
  const { e, errors } = employeeInput(req.body, false);
  if (!errors.username && db.get('SELECT 1 FROM users WHERE lower(username)=? AND id!=?', [e.username, old.id])) errors.username = 'Already taken.';
  if (old.id === req.session.user.id && (!e.active || e.role !== 'owner')) errors.name = 'You cannot deactivate or demote your own account.';
  if (req.body.password && (String(req.body.password).length < 10 || !/\d/.test(req.body.password) || !/[a-z]/i.test(req.body.password))) errors.password = 'At least 10 characters with letters and numbers.';
  if (Object.keys(errors).length) return page(res.status(422), 'app/employee-form', { title: old.name, e: { ...e, id: old.id, emp_no: old.emp_no }, errors, DAYS, isNew: false });
  db.tx(() => {
    db.run(`UPDATE users SET name=?,email=?,username=?,role=?,active=?,can_expenses=?,sched_start=?,sched_end=?,grace_min=?,break_min=?,workdays=? WHERE id=?`,
      [e.name, e.email, e.username, e.role, e.active, e.can_expenses, e.sched_start, e.sched_end, e.grace_min, e.break_min, e.workdays, old.id]);
    if (req.body.password) db.run('UPDATE users SET password_hash=?, must_change_pw=1 WHERE id=?', [bcrypt.hashSync(req.body.password, 12), old.id]);
  });
  B.audit(req, 'employee.update', 'user', old.id, { before: { role: old.role, active: old.active, sched: [old.sched_start, old.sched_end, old.grace_min, old.break_min, old.workdays] }, after: { role: e.role, active: e.active, sched: [e.sched_start, e.sched_end, e.grace_min, e.break_min, e.workdays] }, passwordReset: !!req.body.password });
  res.flash('ok', 'Employee saved.'); res.redirect('/app/employees');
});

// ---------------- attendance monitoring ----------------
router.get('/app/attendance-monitor', C.requireOwner, (req, res) => {
  const today = U.today(), day = validDate(req.query.day || '') ? req.query.day : today;
  const rows = activeStaff().map((u) => ({ u, d: B.daily(u, day, day)[0] || { status: 'Future', rec: null, mins: 0, late_min: 0 } }));
  if (req.query.export === 'csv') return C.sendCsv(res, 'attendance-' + day, ['Emp No', 'Employee', 'Date', 'Status', 'Time in', 'Time out', 'Late (min)', 'Hours'], rows.map(({ u, d }) => [u.emp_no, u.name, day, d.status, d.rec && d.rec.time_in ? d.rec.time_in.slice(11, 16) : '', d.rec && d.rec.time_out ? d.rec.time_out.slice(11, 16) : '', d.late_min, U.hrs(d.mins)]));
  const leaves = db.all(`SELECT l.*, u.name FROM leaves l LEFT JOIN users u ON u.id=l.user_id WHERE l.day>=? ORDER BY l.day LIMIT 50`, [U.addDays(today, -30)]);
  page(res, 'app/attendance-monitor', { title: 'Attendance Monitoring', day, rows, leaves, staff: activeStaff(), nowStr: U.now() });
});
router.post('/app/attendance/leave', C.requireOwner, (req, res) => {
  const day = str(req.body.day, 10), kind = req.body.kind === 'Holiday' ? 'Holiday' : 'Leave', uid = /^\d+$/.test(req.body.user_id || '') ? Number(req.body.user_id) : null;
  if (!validDate(day)) return bad(req, res, 'Enter a valid date.');
  if (kind === 'Leave' && !uid) return bad(req, res, 'Choose the employee on leave.');
  if (db.get('SELECT 1 FROM leaves WHERE user_id IS ? AND day=? AND kind=?', [uid, day, kind])) return bad(req, res, 'That entry already exists.');
  const id = db.run('INSERT INTO leaves (user_id,day,kind,note) VALUES (?,?,?,?)', [kind === 'Holiday' ? null : uid, day, kind, str(req.body.note, 200)]);
  B.audit(req, 'leave.add', 'leave', id, { day, kind, uid });
  res.flash('ok', `${kind} recorded.`); res.redirect(req.get('referer') || '/app/attendance-monitor');
});
router.post('/app/attendance/leave/:id/delete', C.requireOwner, (req, res) => {
  const l = db.get('SELECT * FROM leaves WHERE id=?', [req.params.id]);
  if (l) { db.run('DELETE FROM leaves WHERE id=?', [l.id]); B.audit(req, 'leave.remove', 'leave', l.id, l); }
  res.redirect(req.get('referer') || '/app/attendance-monitor');
});
// Correct a record: original values are preserved in attendance_corrections with the mandatory reason.
router.post('/app/attendance/correct', C.requireOwner, (req, res) => {
  const uid = Number(req.body.user_id), day = str(req.body.day, 10), reason = str(req.body.reason, 500);
  const u = db.get('SELECT * FROM users WHERE id=?', [uid]);
  const tin = str(req.body.time_in, 5), tout = str(req.body.time_out, 5), T = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!u || !validDate(day)) return bad(req, res, 'Invalid employee or date.');
  if (!reason) return bad(req, res, 'A documented reason is required for corrections.');
  if (day > U.today()) return bad(req, res, 'Cannot record attendance for a future date.');
  if (!T.test(tin) || (tout && !T.test(tout)) || (tout && tout <= tin)) return bad(req, res, 'Enter valid times; time-out must be after time-in.');
  const newIn = `${day} ${tin}:00`, newOut = tout ? `${day} ${tout}:00` : null, old = db.get('SELECT * FROM attendance WHERE user_id=? AND day=?', [uid, day]);
  const late = B.lateInfo(u, newIn);
  db.tx(() => {
    db.run('INSERT INTO attendance_corrections (user_id,day,old_in,old_out,new_in,new_out,reason,by_user,at) VALUES (?,?,?,?,?,?,?,?,?)', [uid, day, old && old.time_in, old && old.time_out, newIn, newOut, reason, req.session.user.id, U.now()]);
    if (old) db.run('UPDATE attendance SET time_in=?,time_out=?,is_late=?,late_min=? WHERE id=?', [newIn, newOut, late.is_late, late.late_min, old.id]);
    else db.run('INSERT INTO attendance (user_id,day,time_in,time_out,is_late,late_min) VALUES (?,?,?,?,?,?)', [uid, day, newIn, newOut, late.is_late, late.late_min]);
  });
  B.audit(req, 'attendance.correct', 'attendance', `${uid}:${day}`, { from: old ? [old.time_in, old.time_out] : null, to: [newIn, newOut], reason });
  res.flash('ok', 'Attendance corrected and logged.'); res.redirect(req.get('referer') || '/app/attendance-monitor');
});

// ---------------- monthly attendance reports ----------------
router.get('/app/attendance-report', C.requireOwner, (req, res) => {
  const today = U.today();
  const ym = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
  const uid = /^\d+$/.test(req.query.employee || '') ? Number(req.query.employee) : null;
  const all = db.all('SELECT * FROM users WHERE active=1 OR id IN (SELECT user_id FROM attendance) ORDER BY name');
  const users = uid ? all.filter((u) => u.id === uid) : all;
  const [from, to] = U.monthRange(ym);
  const detail = users.map((u) => ({ u, rows: B.daily(u, from, to) }));
  const sums = detail.map((d) => B.summarize(d.u, d.rows));
  const prev = monthsBack(ym + '-01', 4).slice(0, 3);
  const compare = users.map((u) => ({ u, months: prev.map((m) => { const [a, z] = U.monthRange(m); const s = B.summarize(u, B.daily(u, a, z)); return { m, pct: s.pct, late: s.late, absent: s.absent, hrs: s.mins }; }) }));
  const corr = db.all(`SELECT c.*, u.name AS who, b.name AS by_name FROM attendance_corrections c JOIN users u ON u.id=c.user_id JOIN users b ON b.id=c.by_user WHERE substr(c.day,1,7)=? ${uid ? 'AND c.user_id=' + uid : ''} ORDER BY c.id DESC`, [ym]);
  if (req.query.export === 'csv') {
    const head = ['Emp No', 'Employee', 'Month', 'Scheduled days', 'Days attended', 'Absences', 'Approved leave', 'Late arrivals', 'Incomplete', 'Total hours', 'Avg hours/day', 'Attendance %'];
    const rows = sums.map((s) => [s.user.emp_no, s.user.name, ym, s.scheduled, s.days, s.absent, s.leave, s.late, s.incomplete, U.hrs(s.mins), U.hrs(s.avg), s.pct]);
    if (req.query.detail) return C.sendCsv(res, `attendance-detail-${ym}`, ['Emp No', 'Employee', 'Date', 'Status', 'Time in', 'Time out', 'Late (min)', 'Hours'],
      detail.flatMap((d) => d.rows.map((r) => [d.u.emp_no, d.u.name, r.day, r.status, r.rec && r.rec.time_in ? r.rec.time_in.slice(11, 16) : '', r.rec && r.rec.time_out ? r.rec.time_out.slice(11, 16) : '', r.late_min, U.hrs(r.mins)])));
    return C.sendCsv(res, `attendance-summary-${ym}`, head, rows);
  }
  page(res, 'app/attendance-report', { title: 'Monthly Attendance Report', ym, uid, all, detail, sums, compare, prev, corr });
});

// ---------------- services, content, settings ----------------
router.get('/app/services', C.requireOwner, (req, res) => page(res, 'app/services', { title: 'Service Management', services: db.all('SELECT * FROM services ORDER BY sort,id') }));
router.post('/app/services', C.requireOwner, (req, res) => {
  const id = /^\d+$/.test(req.body.id || '') ? Number(req.body.id) : null, name = str(req.body.name, 120);
  if (!name || !B.SERVICE_TYPES.includes(req.body.type)) return bad(req, res, 'Name and a valid request type are required.');
  const vals = [name, req.body.type, str(req.body.description, 600), str(req.body.icon, 8), req.body.active === 'on' ? 1 : 0, parseInt(req.body.sort, 10) || 0];
  if (id) db.run('UPDATE services SET name=?,type=?,description=?,icon=?,active=?,sort=? WHERE id=?', [...vals, id]);
  else db.run('INSERT INTO services (name,type,description,icon,active,sort) VALUES (?,?,?,?,?,?)', vals);
  B.audit(req, id ? 'service.update' : 'service.create', 'service', id, name);
  res.flash('ok', 'Service saved.'); res.redirect('/app/services');
});

const CONTENT_KEYS = ['business_name', 'tagline', 'location', 'phone', 'mobile', 'email', 'address', 'hours', 'facebook', 'facebook_name', 'instagram', 'about', 'mission', 'vision', 'values', 'fares_title', 'fares_note', 'fares', 'partners', 'why', 'privacy'];
const LONG_KEYS = ['privacy', 'about', 'fares', 'why', 'fares_note', 'partners', 'mission', 'vision'];
const SYSTEM_KEYS = ['retention_years'];
router.get('/app/content', C.requireOwner, (req, res) => page(res, 'app/settings', { title: 'Website Content', keys: CONTENT_KEYS, mode: 'content', backups: [] }));
router.get('/app/settings', C.requireOwner, (req, res) => page(res, 'app/settings', { title: 'System Settings', keys: SYSTEM_KEYS, mode: 'system', backups: db.listBackups().slice(0, 15), messages: db.all('SELECT * FROM messages ORDER BY id DESC LIMIT 20') }));
router.post('/app/settings', C.requireOwner, (req, res) => {
  const allowed = req.body.mode === 'content' ? CONTENT_KEYS : SYSTEM_KEYS;
  db.tx(() => { for (const k of allowed) if (k in req.body) db.run('INSERT OR REPLACE INTO settings VALUES (?,?)', [k, str(req.body[k], LONG_KEYS.includes(k) ? 6000 : 400)]); });
  B.audit(req, 'settings.update', 'settings', req.body.mode, allowed.filter((k) => k in req.body));
  res.flash('ok', 'Saved.'); res.redirect(req.body.mode === 'content' ? '/app/content' : '/app/settings');
});
router.post('/app/settings/backup', C.requireOwner, (req, res) => { const n = db.backup('manual'); B.audit(req, 'backup.create', 'system', n, ''); res.flash('ok', 'Backup created: ' + n); res.redirect('/app/settings'); });
router.get('/app/settings/backup/:name', C.requireOwner, (req, res, next) => {
  const n = db.listBackups().find((f) => f === req.params.name);
  if (!n) return next();
  B.audit(req, 'backup.download', 'system', n, '');
  res.download(require('path').join(db.BACKUP_DIR, n));
});
router.post('/app/messages/:id/handled', C.requireOwner, (req, res) => { db.run('UPDATE messages SET handled=1 WHERE id=?', [req.params.id]); res.redirect('/app/settings'); });

// ---------------- audit logs ----------------
router.get('/app/audit', C.requireOwner, (req, res) => {
  const w = [], p = [], q = req.query;
  if (q.q) { const l = `%${str(q.q, 60)}%`; w.push('(action LIKE ? OR detail LIKE ? OR username LIKE ? OR entity_id LIKE ?)'); p.push(l, l, l, l); }
  if (q.entity) { w.push('entity=?'); p.push(str(q.entity, 30)); }
  if (validDate(q.from || '')) { w.push('substr(at,1,10)>=?'); p.push(q.from); }
  if (validDate(q.to || '')) { w.push('substr(at,1,10)<=?'); p.push(q.to); }
  const sql = `SELECT * FROM audit_logs ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC`;
  if (q.export === 'csv') return C.sendCsv(res, 'audit-log', ['Time', 'User', 'Action', 'Entity', 'ID', 'Detail', 'IP'], db.all(sql, p).map((r) => [r.at, r.username, r.action, r.entity, r.entity_id, r.detail, r.ip]));
  page(res, 'app/audit', { title: 'Audit Logs', list: C.paginate(req, sql, p, 30), entities: db.all('SELECT DISTINCT entity FROM audit_logs WHERE entity IS NOT NULL ORDER BY 1').map((r) => r.entity) });
});

void crypto;
module.exports = router;
