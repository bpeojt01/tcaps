// Authenticated area available to all staff (employees and owner): attendance, customers, requests, bookings, payments, expenses.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const U = require('../lib/util');
const B = require('../lib/biz');
const forms = require('../lib/forms');
const C = require('./common');

router.use('/app', C.requireLogin);
const page = (res, view, data) => res.page(view, data, 'app');
const bad = (req, res, msg, to) => { res.flash('err', msg); res.redirect(to || req.get('referer') || '/app'); };
const str = (v, n = 500) => String(v ?? '').trim().slice(0, n);
const intOrNull = (v) => (/^\d+$/.test(String(v || '')) ? Number(v) : null);
const staffList = () => db.all('SELECT id,name FROM users WHERE active=1 ORDER BY name');
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

// ---------------- profile ----------------
router.get('/app/profile', (req, res) => page(res, 'app/profile', { title: 'My Profile', u: db.get('SELECT * FROM users WHERE id=?', [req.session.user.id]) }));
router.post('/app/profile/password', (req, res) => {
  const u = db.get('SELECT * FROM users WHERE id=?', [req.session.user.id]);
  const { current, next, confirm } = req.body;
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) return bad(req, res, 'Current password is incorrect.', '/app/profile');
  if (String(next || '').length < 10 || !/[a-z]/i.test(next) || !/\d/.test(next)) return bad(req, res, 'New password must be at least 10 characters and include letters and numbers.', '/app/profile');
  if (next !== confirm) return bad(req, res, 'New passwords do not match.', '/app/profile');
  db.run('UPDATE users SET password_hash=?, must_change_pw=0 WHERE id=?', [bcrypt.hashSync(next, 12), u.id]);
  req.session.user.must_change_pw = false;
  B.audit(req, 'password.change', 'user', u.id, '');
  res.flash('ok', 'Password updated.');
  res.redirect('/app/profile');
});

// ---------------- my attendance ----------------
router.get('/app/attendance', (req, res) => {
  const u = db.get('SELECT * FROM users WHERE id=?', [req.session.user.id]);
  const today = U.today();
  const ym = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
  const [from, to] = U.monthRange(ym);
  const rows = B.daily(u, from, to).reverse();
  const rec = db.get('SELECT * FROM attendance WHERE user_id=? AND day=?', [u.id, today]);
  page(res, 'app/attendance', { title: 'My Attendance', u, rec, rows, ym, sum: B.summarize(u, rows), todayMins: B.workedMin(u, rec), sched: B.schedFor(u), nowStr: U.now() });
});
router.post('/app/attendance/in', (req, res) => {
  const id = req.session.user.id, u = db.get('SELECT * FROM users WHERE id=?', [id]), n = U.now(), day = n.slice(0, 10);
  if (db.get('SELECT 1 FROM attendance WHERE user_id=? AND day=?', [id, day])) return bad(req, res, 'You have already timed in today.', '/app/attendance');
  const late = B.lateInfo(u, n);
  const rid = db.run('INSERT INTO attendance (user_id,day,time_in,is_late,late_min) VALUES (?,?,?,?,?)', [id, day, n, late.is_late, late.late_min]);
  B.audit(req, 'attendance.in', 'attendance', rid, n);
  res.flash('ok', `Time-in recorded at ${n.slice(11, 16)}${late.is_late ? ` — marked late by ${late.late_min} min` : ' — on time'}.`);
  res.redirect('/app/attendance');
});
router.post('/app/attendance/out', (req, res) => {
  const id = req.session.user.id, n = U.now();
  const rec = db.get('SELECT * FROM attendance WHERE user_id=? AND day=?', [id, n.slice(0, 10)]);
  if (!rec || !rec.time_in) return bad(req, res, 'No open attendance record — time in first.', '/app/attendance');
  if (rec.time_out) return bad(req, res, 'You have already timed out today.', '/app/attendance');
  db.run('UPDATE attendance SET time_out=? WHERE id=?', [n, rec.id]);
  B.audit(req, 'attendance.out', 'attendance', rec.id, n);
  res.flash('ok', `Time-out recorded at ${n.slice(11, 16)}.`);
  res.redirect('/app/attendance');
});

// ---------------- customers ----------------
const custBalance = `COALESCE((SELECT SUM(MAX(0,(b.selling_price+b.service_fee-b.discount)-${B.PAID_SQL})) FROM bookings b WHERE b.customer_id=c.id AND b.status IN ('Confirmed','Completed')),0)`;
const newCode = (id) => 'CUST-' + String(id).padStart(5, '0');

router.get('/app/customers', (req, res) => {
  const w = [], p = [];
  if (req.query.q) { const q = `%${str(req.query.q, 60)}%`; w.push('(c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.code LIKE ?)'); p.push(q, q, q, q); }
  if (req.query.owing) w.push(`${custBalance} > 0`);
  const sort = C.SORTS({ name: 'c.name', code: 'c.code', date: 'c.created_at', balance: 'balance' }, 'date')(req);
  const list = C.paginate(req, `SELECT c.*, ${custBalance} AS balance,
    (SELECT COUNT(*) FROM requests r WHERE r.customer_id=c.id) AS n_req, (SELECT COUNT(*) FROM bookings b WHERE b.customer_id=c.id) AS n_bk
    FROM customers c ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ${sort}`, p);
  page(res, 'app/customers', { title: 'Customers', list });
});
router.get('/app/customers/new', (req, res) => page(res, 'app/customer-form', { title: 'New customer', c: {}, errors: {} }));
function custInput(b) {
  const c = { name: str(b.name, 120), phone: str(b.phone, 40), email: str(b.email, 160).toLowerCase(), pref_contact: str(b.pref_contact, 30), notes: str(b.notes, 2000) };
  const errors = {};
  if (!c.name) errors.name = 'Required.';
  if (!c.phone && !c.email) errors.phone = 'Provide a phone number or email.';
  if (c.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) errors.email = 'Invalid email.';
  return { c, errors };
}
router.post('/app/customers/new', (req, res) => {
  const { c, errors } = custInput(req.body);
  if (Object.keys(errors).length) return page(res.status(422), 'app/customer-form', { title: 'New customer', c, errors });
  const id = db.tx(() => { const i = db.run('INSERT INTO customers (name,phone,email,pref_contact,notes,created_at) VALUES (?,?,?,?,?,?)', [c.name, c.phone, c.email, c.pref_contact, c.notes, U.now()]); db.run('UPDATE customers SET code=? WHERE id=?', [newCode(i), i]); return i; });
  B.audit(req, 'customer.create', 'customer', id, c.name);
  res.redirect('/app/customers/' + id);
});
router.get('/app/customers/:id', (req, res, next) => {
  const c = db.get(`SELECT c.*, ${custBalance} AS balance FROM customers c WHERE id=?`, [req.params.id]);
  if (!c) return next();
  const bookings = db.all(`${B.bookingSelect} WHERE b.customer_id=? ORDER BY b.id DESC`, [c.id]).map(B.decorate);
  page(res, 'app/customer', { title: c.name, c, bookings,
    requests: db.all('SELECT * FROM requests WHERE customer_id=? ORDER BY id DESC', [c.id]),
    payments: db.all(`SELECT p.*, b.ref AS booking_ref FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE p.customer_id=? ORDER BY p.id DESC`, [c.id]),
    notes: db.all(`SELECT n.*, u.name AS author FROM notes n LEFT JOIN users u ON u.id=n.user_id WHERE entity='customer' AND entity_id=? ORDER BY n.id DESC`, [c.id]) });
});
router.get('/app/customers/:id/edit', (req, res, next) => {
  const c = db.get('SELECT * FROM customers WHERE id=?', [req.params.id]);
  if (!c) return next();
  page(res, 'app/customer-form', { title: 'Edit customer', c, errors: {} });
});
router.post('/app/customers/:id/edit', (req, res, next) => {
  const old = db.get('SELECT * FROM customers WHERE id=?', [req.params.id]);
  if (!old) return next();
  const { c, errors } = custInput(req.body);
  if (Object.keys(errors).length) return page(res.status(422), 'app/customer-form', { title: 'Edit customer', c: { ...c, id: old.id, code: old.code }, errors });
  db.run('UPDATE customers SET name=?,phone=?,email=?,pref_contact=?,notes=? WHERE id=?', [c.name, c.phone, c.email, c.pref_contact, c.notes, old.id]);
  B.audit(req, 'customer.update', 'customer', old.id, { before: old, after: c });
  res.redirect('/app/customers/' + old.id);
});
router.post('/app/notes', (req, res) => {
  const entity = ['customer', 'request', 'booking'].includes(req.body.entity) ? req.body.entity : null;
  const id = intOrNull(req.body.entity_id), body = str(req.body.body, 2000);
  if (!entity || !id || !body) return bad(req, res, 'Write a note first.');
  db.run('INSERT INTO notes (entity,entity_id,body,user_id,at) VALUES (?,?,?,?,?)', [entity, id, body, req.session.user.id, U.now()]);
  B.audit(req, 'note.add', entity, id, body.slice(0, 80));
  res.redirect(req.get('referer') || '/app');
});

// ---------------- travel requests ----------------
router.get('/app/requests', (req, res) => {
  const w = [], p = [], q = req.query;
  if (q.q) { const l = `%${str(q.q, 60)}%`; w.push('(r.ref LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)'); p.push(l, l, l, l); }
  if (B.STATUSES.includes(q.status)) { w.push('r.status=?'); p.push(q.status); }
  if (q.status === 'open') w.push(`r.status NOT IN ('Completed','Cancelled','Rejected')`);
  if (B.SERVICE_TYPES.includes(q.service)) { w.push('r.service_type=?'); p.push(q.service); }
  if (intOrNull(q.employee)) { w.push('r.assigned_to=?'); p.push(Number(q.employee)); }
  if (validDate(q.from || '')) { w.push('substr(r.created_at,1,10)>=?'); p.push(q.from); }
  if (validDate(q.to || '')) { w.push('substr(r.created_at,1,10)<=?'); p.push(q.to); }
  const sort = C.SORTS({ date: 'r.created_at', ref: 'r.ref', customer: 'c.name', status: 'r.status' }, 'date')(req);
  const list = C.paginate(req, `SELECT r.*, c.name AS customer, c.code AS customer_code, u.name AS employee FROM requests r
    JOIN customers c ON c.id=r.customer_id LEFT JOIN users u ON u.id=r.assigned_to ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ${sort}`, p);
  page(res, 'app/requests', { title: 'Travel Requests', list, staff: staffList() });
});
router.get('/app/requests/new', (req, res) => page(res, 'app/request-new', { title: 'Register request', v: { customer_id: req.query.customer || '' }, errors: {}, forms, customers: db.all('SELECT id,code,name FROM customers ORDER BY name') }));
router.post('/app/requests/new', (req, res) => {
  const b = req.body, errors = {};
  const cust = db.get('SELECT * FROM customers WHERE id=?', [intOrNull(b.customer_id)]);
  if (!cust) errors.customer_id = 'Choose a customer (create one first if new).';
  if (!B.SERVICE_TYPES.includes(b.service_type)) errors.service_type = 'Choose a service.';
  const source = ['Walk-in', 'Phone call', 'Email', 'Social media'].includes(b.source) ? b.source : null;
  if (!source) errors.source = 'Choose the channel.';
  const parsed = B.SERVICE_TYPES.includes(b.service_type) ? forms.parseDetails(b.service_type, b) : { details: {}, errors: {} };
  Object.assign(errors, parsed.errors);
  if (Object.keys(errors).length) return page(res.status(422), 'app/request-new', { title: 'Register request', v: b, errors, forms, customers: db.all('SELECT id,code,name FROM customers ORDER BY name') });
  const out = db.tx(() => {
    let ref; do { ref = `TR-${U.today().replace(/-/g, '')}-${U.rand(4)}`; } while (db.get('SELECT 1 FROM requests WHERE ref=?', [ref]));
    const id = db.run('INSERT INTO requests (ref,customer_id,service_type,details,source,assigned_to,created_at) VALUES (?,?,?,?,?,?,?)',
      [ref, cust.id, b.service_type, JSON.stringify(parsed.details), source, req.session.user.id, U.now()]);
    db.run('INSERT INTO request_log (request_id,from_status,to_status,note,user_id,at) VALUES (?,?,?,?,?,?)', [id, null, 'Pending Review', `Registered (${source})`, req.session.user.id, U.now()]);
    return id;
  });
  B.audit(req, 'request.create', 'request', out, source);
  res.redirect('/app/requests/' + out);
});
router.get('/app/requests/:id', (req, res, next) => {
  const r = db.get(`SELECT r.*, c.name AS customer, c.code AS customer_code, c.phone, c.email, u.name AS employee FROM requests r
    JOIN customers c ON c.id=r.customer_id LEFT JOIN users u ON u.id=r.assigned_to WHERE r.id=?`, [req.params.id]);
  if (!r) return next();
  page(res, 'app/request', { title: r.ref, r, details: JSON.parse(r.details || '{}'), labels: forms.labelOf(r.service_type), staff: staffList(),
    log: db.all(`SELECT l.*, u.name AS who FROM request_log l LEFT JOIN users u ON u.id=l.user_id WHERE request_id=? ORDER BY l.id DESC`, [r.id]),
    notes: db.all(`SELECT n.*, u.name AS author FROM notes n LEFT JOIN users u ON u.id=n.user_id WHERE entity='request' AND entity_id=? ORDER BY n.id DESC`, [r.id]),
    bookings: db.all('SELECT id,ref,status FROM bookings WHERE request_id=?', [r.id]) });
});
router.post('/app/requests/:id/status', (req, res, next) => {
  const r = db.get('SELECT * FROM requests WHERE id=?', [req.params.id]);
  if (!r) return next();
  const to = req.body.status, note = str(req.body.note, 1000);
  if (!B.STATUSES.includes(to)) return bad(req, res, 'Invalid status.');
  if (to === r.status && !note) return bad(req, res, 'Status unchanged.');
  const assignee = intOrNull(req.body.assigned_to);
  db.tx(() => {
    db.run('UPDATE requests SET status=?, assigned_to=COALESCE(?, assigned_to, ?) WHERE id=?', [to, assignee, req.session.user.id, r.id]);
    db.run('INSERT INTO request_log (request_id,from_status,to_status,note,user_id,at) VALUES (?,?,?,?,?,?)', [r.id, r.status, to, note, req.session.user.id, U.now()]);
  });
  B.audit(req, 'request.status', 'request', r.id, `${r.status} -> ${to}`);
  res.flash('ok', 'Request updated.');
  res.redirect('/app/requests/' + r.id);
});

// ---------------- bookings ----------------
function bookingInput(b) {
  const e = {}, v = {
    customer_id: intOrNull(b.customer_id), request_id: intOrNull(b.request_id), service_type: b.service_type, supplier: str(b.supplier, 160),
    details: str(b.details, 3000), confirmation_ref: str(b.confirmation_ref, 80), remarks: str(b.remarks, 2000), status: b.status,
    assigned_to: intOrNull(b.assigned_to),
  };
  for (const k of ['supplier_cost', 'selling_price', 'service_fee', 'discount']) {
    const c = b[k] === '' || b[k] == null ? 0 : U.toCents(b[k]);
    if (!Number.isFinite(c) || c < 0 || c > 1e11) e[k] = 'Enter an amount of 0 or more.'; else v[k] = c;
  }
  if (!db.get('SELECT 1 FROM customers WHERE id=?', [v.customer_id])) e.customer_id = 'Choose a customer.';
  if (!B.SERVICE_TYPES.includes(v.service_type)) e.service_type = 'Choose a service type.';
  if (!B.BOOKING_STATUSES.includes(v.status)) e.status = 'Choose a status.';
  if (v.assigned_to && !db.get('SELECT 1 FROM users WHERE id=? AND active=1', [v.assigned_to])) v.assigned_to = null;
  if (!e.selling_price && !e.service_fee && !e.discount && v.discount > v.selling_price + v.service_fee) e.discount = 'Discount cannot exceed the price plus fee.';
  if (v.request_id && !db.get('SELECT 1 FROM requests WHERE id=?', [v.request_id])) v.request_id = null;
  return { v, e };
}
const bookingFormData = () => ({ customers: db.all('SELECT id,code,name FROM customers ORDER BY name'), staff: staffList() });

router.get('/app/bookings', (req, res) => {
  const w = [], p = [], q = req.query;
  if (q.q) { const l = `%${str(q.q, 60)}%`; w.push('(b.ref LIKE ? OR c.name LIKE ? OR b.supplier LIKE ? OR b.confirmation_ref LIKE ?)'); p.push(l, l, l, l); }
  if (B.BOOKING_STATUSES.includes(q.status)) { w.push('b.status=?'); p.push(q.status); }
  if (B.SERVICE_TYPES.includes(q.service)) { w.push('b.service_type=?'); p.push(q.service); }
  if (intOrNull(q.employee)) { w.push('b.assigned_to=?'); p.push(Number(q.employee)); }
  if (intOrNull(q.customer)) { w.push('b.customer_id=?'); p.push(Number(q.customer)); }
  if (validDate(q.from || '')) { w.push('substr(b.created_at,1,10)>=?'); p.push(q.from); }
  if (validDate(q.to || '')) { w.push('substr(b.created_at,1,10)<=?'); p.push(q.to); }
  const having = { Unpaid: 'paid<=0', 'Partially Paid': 'paid>0 AND paid<tot', Paid: 'paid=tot', Overpaid: 'paid>tot' }[q.pay];
  const sort = C.SORTS({ date: 'created_at', ref: 'ref', customer: 'customer', total: 'tot', status: 'status' }, 'date')(req);
  const base = w.length ? `SELECT * FROM (${B.bookingSelect} WHERE ${w.join(' AND ')}) y` : `SELECT * FROM (${B.bookingSelect}) y`;
  const full = `SELECT * FROM (SELECT y.*, (selling_price+service_fee-discount) AS tot FROM (${base}) y) t ${having ? 'WHERE ' + having : ''} ${sort}`;
  const list = C.paginate(req, full, p);
  list.rows.forEach(B.decorate);
  page(res, 'app/bookings', { title: 'Bookings', list, staff: staffList() });
});
router.get('/app/bookings/new', (req, res) => {
  const rq = db.get('SELECT * FROM requests WHERE id=?', [intOrNull(req.query.request)]);
  const v = { status: 'Quoted', customer_id: rq ? rq.customer_id : req.query.customer || '', request_id: rq ? rq.id : '', service_type: rq ? rq.service_type : '', assigned_to: req.session.user.id,
    details: rq ? Object.entries(JSON.parse(rq.details)).filter(([k]) => !k.startsWith('contact_')).map(([k, x]) => `${forms.labelOf(rq.service_type)[k] || k}: ${x}`).join('\n') : '' };
  page(res, 'app/booking-form', { title: 'New booking', v, errors: {}, isNew: true, ...bookingFormData() });
});
router.post('/app/bookings/new', (req, res) => {
  const { v, e } = bookingInput(req.body);
  if (Object.keys(e).length) return page(res.status(422), 'app/booking-form', { title: 'New booking', v: req.body, errors: e, isNew: true, ...bookingFormData() });
  const id = db.tx(() => {
    const i = db.run(`INSERT INTO bookings (customer_id,request_id,service_type,supplier,details,supplier_cost,selling_price,service_fee,discount,status,assigned_to,confirmation_ref,remarks,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [v.customer_id, v.request_id, v.service_type, v.supplier, v.details, v.supplier_cost, v.selling_price, v.service_fee, v.discount, v.status, v.assigned_to, v.confirmation_ref, v.remarks, U.now()]);
    db.run('UPDATE bookings SET ref=? WHERE id=?', [`BK-${U.today().slice(0, 4)}-${String(i).padStart(5, '0')}`, i]);
    return i;
  });
  B.audit(req, 'booking.create', 'booking', id, v);
  res.redirect('/app/bookings/' + id);
});
const loadBooking = (id) => { const b = db.get(`${B.bookingSelect} WHERE b.id=?`, [id]); return b && B.decorate(b); };
router.get('/app/bookings/:id', (req, res, next) => {
  const b = loadBooking(req.params.id);
  if (!b) return next();
  page(res, 'app/booking', { title: b.ref, b, errors: {},
    payments: db.all(`SELECT p.*, u.name AS recorder FROM payments p LEFT JOIN users u ON u.id=p.user_id WHERE booking_id=? ORDER BY p.id DESC`, [b.id]),
    docs: db.all(`SELECT d.*, u.name AS uploader FROM documents d LEFT JOIN users u ON u.id=d.user_id WHERE booking_id=? ORDER BY d.id DESC`, [b.id]),
    notes: db.all(`SELECT n.*, u.name AS author FROM notes n LEFT JOIN users u ON u.id=n.user_id WHERE entity='booking' AND entity_id=? ORDER BY n.id DESC`, [b.id]),
    request: b.request_id ? db.get('SELECT id,ref FROM requests WHERE id=?', [b.request_id]) : null });
});
router.get('/app/bookings/:id/edit', (req, res, next) => {
  const b = loadBooking(req.params.id);
  if (!b) return next();
  page(res, 'app/booking-form', { title: 'Edit ' + b.ref, v: { ...b, supplier_cost: U.plain(b.supplier_cost), selling_price: U.plain(b.selling_price), service_fee: U.plain(b.service_fee), discount: U.plain(b.discount) }, errors: {}, isNew: false, ...bookingFormData() });
});
router.post('/app/bookings/:id/edit', (req, res, next) => {
  const old = loadBooking(req.params.id);
  if (!old) return next();
  const { v, e } = bookingInput({ ...req.body, customer_id: old.customer_id });
  if (Object.keys(e).length) return page(res.status(422), 'app/booking-form', { title: 'Edit ' + old.ref, v: { ...req.body, id: old.id, ref: old.ref }, errors: e, isNew: false, ...bookingFormData() });
  db.run(`UPDATE bookings SET request_id=?,service_type=?,supplier=?,details=?,supplier_cost=?,selling_price=?,service_fee=?,discount=?,status=?,assigned_to=?,confirmation_ref=?,remarks=?,updated_at=? WHERE id=?`,
    [v.request_id, v.service_type, v.supplier, v.details, v.supplier_cost, v.selling_price, v.service_fee, v.discount, v.status, v.assigned_to, v.confirmation_ref, v.remarks, U.now(), old.id]);
  B.audit(req, 'booking.update', 'booking', old.id, { before: { s: old.status, cost: old.supplier_cost, price: old.selling_price, fee: old.service_fee, disc: old.discount }, after: { s: v.status, cost: v.supplier_cost, price: v.selling_price, fee: v.service_fee, disc: v.discount } });
  if (v.status === 'Cancelled' && old.status !== 'Cancelled' && old.paid > 0) res.flash('err', `Booking cancelled, but ${U.peso(old.paid)} was collected. Record any refund as a Refund payment so reports stay accurate.`);
  else res.flash('ok', 'Booking saved.');
  res.redirect('/app/bookings/' + old.id);
});

router.post('/app/bookings/:id/payment', (req, res, next) => {
  const b = loadBooking(req.params.id);
  if (!b) return next();
  const kind = req.body.kind === 'Refund' ? 'Refund' : 'Payment';
  const amt = U.toCents(req.body.amount), date = str(req.body.paid_at, 10) || U.today();
  const back = '/app/bookings/' + b.id;
  if (!Number.isFinite(amt) || amt <= 0 || amt > 1e11) return bad(req, res, 'Enter a valid amount greater than zero.', back);
  if (!validDate(date) || date > U.today()) return bad(req, res, 'Payment date cannot be blank or in the future.', back);
  if (!B.METHODS.includes(req.body.method)) return bad(req, res, 'Choose a payment method.', back);
  if (b.status === 'Cancelled' && kind === 'Payment') return bad(req, res, 'This booking is cancelled; only refunds can be recorded.', back);
  if (kind === 'Refund' && amt > b.paid) return bad(req, res, `A refund cannot exceed the net amount paid (${U.peso(b.paid)}).`, back);
  const id = db.tx(() => {
    const i = db.run('INSERT INTO payments (booking_id,customer_id,paid_at,amount,method,reference,kind,remarks,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [b.id, b.customer_id, date, amt, req.body.method, str(req.body.reference, 80), kind, str(req.body.remarks, 500), req.session.user.id, U.now()]);
    db.run('UPDATE payments SET ref=? WHERE id=?', [`PAY-${String(i).padStart(6, '0')}`, i]);
    return i;
  });
  B.audit(req, 'payment.' + kind.toLowerCase(), 'payment', id, { booking: b.ref, amount: amt });
  res.flash('ok', `${kind} of ${U.peso(amt)} recorded.`);
  res.redirect(back);
});
router.post('/app/payments/:id/reverse', C.requireOwner, (req, res, next) => {
  const p = db.get('SELECT * FROM payments WHERE id=?', [req.params.id]);
  if (!p) return next();
  const reason = str(req.body.reason, 500);
  if (!reason) return bad(req, res, 'A reason is required to reverse a payment.');
  if (p.status !== 'Valid') return bad(req, res, 'Already reversed.');
  db.run(`UPDATE payments SET status='Reversed', reversed_by=?, reversed_reason=? WHERE id=?`, [req.session.user.id, reason, p.id]);
  B.audit(req, 'payment.reverse', 'payment', p.id, { amount: p.amount, kind: p.kind, reason });
  res.flash('ok', 'Payment reversed; it no longer counts in totals but remains on record.');
  res.redirect(req.get('referer') || '/app/payments');
});

router.post('/app/bookings/:id/upload', C.uploadOne('file'), (req, res, next) => {
  const b = db.get('SELECT id,ref FROM bookings WHERE id=?', [req.params.id]);
  if (!b) return next();
  if (!req.file) return bad(req, res, 'Choose a file to upload.');
  db.run('INSERT INTO documents (booking_id,stored,original,user_id,at) VALUES (?,?,?,?,?)', [b.id, req.file.filename, req.file.originalname.slice(0, 200), req.session.user.id, U.now()]);
  B.audit(req, 'document.upload', 'booking', b.id, req.file.originalname.slice(0, 100));
  res.flash('ok', 'Document uploaded.'); res.redirect('/app/bookings/' + b.id);
});
router.get('/app/files/doc/:id', (req, res, next) => {
  const d = db.get('SELECT * FROM documents WHERE id=?', [req.params.id]);
  if (!d) return next();
  B.audit(req, 'document.download', 'booking', d.booking_id, d.original);
  C.sendStored(res, d.stored, d.original);
});

// ---------------- transactions / payments ----------------
function paymentQuery(req) {
  const w = [], p = [], q = req.query;
  if (q.q) { const l = `%${str(q.q, 60)}%`; w.push('(p.ref LIKE ? OR c.name LIKE ? OR b.ref LIKE ? OR p.reference LIKE ?)'); p.push(l, l, l, l); }
  if (['Payment', 'Refund'].includes(q.kind)) { w.push('p.kind=?'); p.push(q.kind); }
  if (['Valid', 'Reversed'].includes(q.pstatus)) { w.push('p.status=?'); p.push(q.pstatus); }
  if (B.METHODS.includes(q.method)) { w.push('p.method=?'); p.push(q.method); }
  if (intOrNull(q.employee)) { w.push('p.user_id=?'); p.push(Number(q.employee)); }
  if (intOrNull(q.customer)) { w.push('p.customer_id=?'); p.push(Number(q.customer)); }
  if (validDate(q.from || '')) { w.push('p.paid_at>=?'); p.push(q.from); }
  if (validDate(q.to || '')) { w.push('p.paid_at<=?'); p.push(q.to); }
  const sort = C.SORTS({ date: 'p.paid_at', amount: 'p.amount', customer: 'c.name', ref: 'p.ref' }, 'date')(req);
  return [`SELECT p.*, c.name AS customer, b.ref AS booking_ref, u.name AS recorder FROM payments p JOIN customers c ON c.id=p.customer_id
    JOIN bookings b ON b.id=p.booking_id LEFT JOIN users u ON u.id=p.user_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ${sort}`, p];
}
router.get('/app/payments', (req, res) => {
  const [sql, p] = paymentQuery(req);
  if (req.query.export === 'csv') {
    return C.sendCsv(res, 'transactions', ['Payment ID', 'Date', 'Type', 'Status', 'Customer', 'Booking', 'Method', 'Reference', 'Amount', 'Recorded by', 'Remarks'],
      db.all(sql, p).map((r) => [r.ref, r.paid_at, r.kind, r.status, r.customer, r.booking_ref, r.method, r.reference, (r.kind === 'Refund' ? '-' : '') + U.plain(r.amount), r.recorder, r.remarks]));
  }
  page(res, 'app/payments', { title: 'Payments & Transactions', list: C.paginate(req, sql, p), staff: staffList() });
});

// ---------------- expenses ----------------
router.get('/app/expenses', C.requireExpenses, (req, res) => {
  const w = [], p = [], q = req.query;
  if (q.q) { const l = `%${str(q.q, 60)}%`; w.push('(e.description LIKE ? OR e.category LIKE ?)'); p.push(l, l); }
  if (B.EXPENSE_CATS.includes(q.category)) { w.push('e.category=?'); p.push(q.category); }
  if (validDate(q.from || '')) { w.push('e.spent_at>=?'); p.push(q.from); }
  if (validDate(q.to || '')) { w.push('e.spent_at<=?'); p.push(q.to); }
  const sql = `SELECT e.*, u.name AS recorder FROM expenses e LEFT JOIN users u ON u.id=e.user_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY e.spent_at DESC, e.id DESC`;
  if (q.export === 'csv') return C.sendCsv(res, 'expenses', ['ID', 'Date', 'Category', 'Amount', 'Method', 'Description', 'Status', 'Recorded by'], db.all(sql, p).map((r) => [r.id, r.spent_at, r.category, U.plain(r.amount), r.method, r.description, r.status, r.recorder]));
  const total = db.val(`SELECT COALESCE(SUM(amount),0) FROM (${sql}) WHERE status='Valid'`, p);
  page(res, 'app/expenses', { title: 'Expenses', list: C.paginate(req, sql, p), total, errors: {} });
});
router.post('/app/expenses', C.requireExpenses, C.uploadOne('receipt'), (req, res) => {
  const amt = U.toCents(req.body.amount), date = str(req.body.spent_at, 10) || U.today();
  const err = !Number.isFinite(amt) || amt <= 0 ? 'Enter a valid amount.' : !validDate(date) || date > U.today() ? 'Enter a valid date (not in the future).'
    : !B.EXPENSE_CATS.includes(req.body.category) ? 'Choose a category.' : !B.METHODS.includes(req.body.method) ? 'Choose a payment method.' : !str(req.body.description) ? 'Add a description.' : null;
  if (err) return bad(req, res, err, '/app/expenses');
  const id = db.run('INSERT INTO expenses (spent_at,category,amount,method,description,receipt,user_id,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [date, req.body.category, amt, req.body.method, str(req.body.description, 500), req.file ? req.file.filename : null, req.session.user.id, U.now()]);
  if (req.file) db.run(`INSERT INTO notes (entity,entity_id,body,user_id,at) VALUES ('expense_file',?,?,?,?)`, [id, req.file.originalname.slice(0, 200), req.session.user.id, U.now()]);
  B.audit(req, 'expense.create', 'expense', id, { amount: amt, category: req.body.category });
  res.flash('ok', 'Expense recorded.'); res.redirect('/app/expenses');
});
router.get('/app/files/receipt/:id', C.requireExpenses, (req, res, next) => {
  const e = db.get('SELECT receipt FROM expenses WHERE id=?', [req.params.id]);
  if (!e || !e.receipt) return next();
  const n = db.get(`SELECT body FROM notes WHERE entity='expense_file' AND entity_id=?`, [req.params.id]);
  C.sendStored(res, e.receipt, n ? n.body : e.receipt);
});
router.post('/app/expenses/:id/void', C.requireOwner, (req, res, next) => {
  const e = db.get('SELECT * FROM expenses WHERE id=?', [req.params.id]);
  if (!e) return next();
  const reason = str(req.body.reason, 500);
  if (!reason) return bad(req, res, 'A reason is required to void an expense.');
  db.run(`UPDATE expenses SET status='Voided', void_reason=? WHERE id=?`, [reason, e.id]);
  B.audit(req, 'expense.void', 'expense', e.id, { amount: e.amount, reason });
  res.flash('ok', 'Expense voided (kept on record, excluded from totals).'); res.redirect('/app/expenses');
});

module.exports = router;
