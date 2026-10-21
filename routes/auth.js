const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../lib/db');
const B = require('../lib/biz');

const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).page('error', { code: 429, msg: 'Too many login attempts. Try again in 15 minutes.', title: 'Slow down' }, 'public') });
const DUMMY = bcrypt.hashSync('not-a-real-password', 12); // constant-time-ish response for unknown users

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/app');
  res.page('auth/login', { title: 'Staff login', error: null }, 'public');
});

router.post('/login', loginLimit, (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const u = db.get('SELECT * FROM users WHERE lower(username)=?', [username]);
  const ok = bcrypt.compareSync(String(req.body.password || ''), u ? u.password_hash : DUMMY) && u && u.active;
  if (!ok) {
    B.audit({ ip: req.ip, session: {} }, 'login.fail', 'user', null, username.slice(0, 60));
    return res.status(401).page('auth/login', { title: 'Staff login', error: 'Invalid username or password.' }, 'public');
  }
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.user = { id: u.id, username: u.username, name: u.name, role: u.role, can_expenses: !!u.can_expenses, must_change_pw: !!u.must_change_pw };
    B.audit(req, 'login', 'user', u.id, '');
    req.session.save(() => res.redirect(u.must_change_pw ? '/app/profile' : '/app'));
  });
});

router.post('/logout', (req, res) => {
  B.audit(req, 'logout', 'user', req.session.user && req.session.user.id, '');
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
