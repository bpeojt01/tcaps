const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../lib/db');
const U = require('../lib/util');
const B = require('../lib/biz');
const forms = require('../lib/forms');

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).page('error', { code: 429, msg: 'Too many submissions. Please try again later.', title: 'Slow down' }, 'public') });

const pub = (res, view, data = {}) => res.page(view, data, 'public');
const services = () => db.all('SELECT * FROM services WHERE active=1 ORDER BY sort,id');

router.get('/', (req, res) => pub(res, 'public/home', { title: 'Home', services: services() }));
router.get('/about', (req, res) => pub(res, 'public/about', { title: 'About Us' }));
router.get('/services', (req, res) => pub(res, 'public/services', { title: 'Services', services: services() }));
router.get('/privacy', (req, res) => pub(res, 'public/privacy', { title: 'Privacy Policy' }));
router.get('/contact', (req, res) => pub(res, 'public/contact', { title: 'Contact Us', v: {}, errors: {} }));

router.post('/contact', limiter, (req, res) => {
  const v = { name: String(req.body.name || '').trim().slice(0, 120), email: String(req.body.email || '').trim().slice(0, 160),
    phone: String(req.body.phone || '').trim().slice(0, 40), body: String(req.body.body || '').trim().slice(0, 3000) };
  const errors = {};
  if (!v.name) errors.name = 'Required.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) errors.email = 'Enter a valid email.';
  if (!v.body) errors.body = 'Required.';
  if (req.body.consent !== 'on') errors.consent = 'Please accept the privacy notice.';
  if (req.body.website) return res.redirect('/contact'); // honeypot
  if (Object.keys(errors).length) return pub(res.status(422), 'public/contact', { title: 'Contact Us', v, errors });
  db.run('INSERT INTO messages (name,email,phone,body,at) VALUES (?,?,?,?,?)', [v.name, v.email, v.phone, v.body, U.now()]);
  res.flash('ok', 'Thank you! Your message was sent. We will get back to you soon.');
  res.redirect('/#contact');
});

router.get('/request', (req, res) => {
  const t = B.SERVICE_TYPES.includes(req.query.service) ? req.query.service : '';
  const v = { service_type: t };
  if (req.query.origin) v.d_origin = String(req.query.origin).slice(0, 80);
  if (req.query.destination) v.d_destination = String(req.query.destination).slice(0, 80);
  if (v.d_origin || v.d_destination) v.d_trip_type = 'One-way';
  pub(res, 'public/request', { title: 'Request Travel Assistance', v, errors: {}, forms });
});

router.post('/request', limiter, (req, res) => {
  const b = req.body;
  if (b.website) return res.redirect('/request'); // honeypot field
  const v = { ...b };
  const errors = {};
  const name = String(b.name || '').trim().slice(0, 120), phone = String(b.phone || '').trim().slice(0, 40);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 160), pref = String(b.pref_contact || '');
  if (!name) errors.name = 'Required.';
  if (!/^[0-9+()\-\s]{7,20}$/.test(phone)) errors.phone = 'Enter a valid contact number.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = 'Enter a valid email address.';
  if (!['Phone call', 'SMS', 'Email', 'Viber', 'Messenger', 'WhatsApp'].includes(pref)) errors.pref_contact = 'Choose a contact method.';
  if (!B.SERVICE_TYPES.includes(b.service_type)) errors.service_type = 'Choose a service.';
  if (b.consent !== 'on') errors.consent = 'You must agree to the privacy notice.';
  const parsed = B.SERVICE_TYPES.includes(b.service_type) ? forms.parseDetails(b.service_type, b) : { details: {}, errors: {} };
  Object.assign(errors, parsed.errors);
  if (Object.keys(errors).length) return pub(res.status(422), 'public/request', { title: 'Request Travel Assistance', v, errors, forms });

  const ref = db.tx(() => {
    let c = db.get('SELECT id FROM customers WHERE lower(email)=?', [email]);
    let cid = c && c.id;
    if (!cid) {
      cid = db.run('INSERT INTO customers (name,phone,email,pref_contact,created_at) VALUES (?,?,?,?,?)', [name, phone, email, pref, U.now()]);
      db.run('UPDATE customers SET code=? WHERE id=?', ['CUST-' + String(cid).padStart(5, '0'), cid]);
    }
    let r; do { r = `TR-${U.today().replace(/-/g, '')}-${U.rand(4)}`; } while (db.get('SELECT 1 FROM requests WHERE ref=?', [r]));
    const id = db.run('INSERT INTO requests (ref,customer_id,service_type,details,source,created_at) VALUES (?,?,?,?,?,?)',
      [r, cid, b.service_type, JSON.stringify({ ...parsed.details, contact_method: pref, contact_phone: phone }), 'Website', U.now()]);
    db.run('INSERT INTO request_log (request_id,from_status,to_status,note,at) VALUES (?,?,?,?,?)', [id, null, 'Pending Review', 'Submitted via website', U.now()]);
    db.run(`INSERT INTO audit_logs (at,action,entity,entity_id,detail,ip) VALUES (?,?,?,?,?,?)`, [U.now(), 'request.submit', 'request', id, r, req.ip]);
    return r;
  });
  req.session.lastRef = ref;
  res.redirect('/request/done');
});

router.get('/request/done', (req, res) => {
  if (!req.session.lastRef) return res.redirect('/request');
  pub(res, 'public/done', { title: 'Request received', ref: req.session.lastRef });
});

module.exports = router;
