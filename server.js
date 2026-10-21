const express = require('express');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const helmet = require('helmet');
const db = require('./lib/db');
const schema = require('./lib/schema');
const U = require('./lib/util');
const B = require('./lib/biz');

(async () => {
  await schema.init();
  const app = express();
  const prod = process.env.NODE_ENV === 'production';
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"],
    } },
  }));
  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));

  let secret = process.env.SESSION_SECRET;
  if (!secret) secret = db.val(`SELECT value FROM settings WHERE key='_session_secret'`) ||
    (() => { const s = crypto.randomBytes(32).toString('hex'); db.run(`INSERT INTO settings VALUES ('_session_secret',?)`, [s]); return s; })();
  app.use(session({
    name: 'tsid', secret, resave: false, saveUninitialized: false, rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: 1000 * 60 * 60 * 8 },
  }));

  // CSRF: per-session token, required on every state-changing request (form field or ?_csrf= for multipart forms).
  app.use((req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.locals.csrf = req.session.csrf;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const t = String((req.body && req.body._csrf) || req.query._csrf || '');
      const ok = t.length === req.session.csrf.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(req.session.csrf));
      if (!ok) return res.status(403).render('error', { code: 403, msg: 'Your session expired or the form was invalid. Go back, refresh and try again.', layout: 'public' });
    }
    next();
  });

  app.use((req, res, next) => {
    res.locals.me = req.session.user || null;
    res.locals.S = B.settings();
    res.locals.U = U; res.locals.B = B;
    res.locals.flash = req.session.flash || null; delete req.session.flash;
    res.locals.path = req.path;
    res.locals.title = '';
    res.flash = (type, msg) => { req.session.flash = { type, msg }; };
    // Render a view inside a layout ('public' or 'app').
    res.page = (view, data = {}, layout = 'app') => res.render(view, { ...data, layout: null }, (err, body) => {
      if (err) return next(err);
      res.render('layouts/' + layout, { ...data, body });
    });
    if (req.csrfFailed) return res.status(403).page('error', { code: 403, msg: 'Your session expired or the form was invalid. Go back, refresh and try again.', title: 'Error' }, req.session.user ? 'app' : 'public');
    next();
  });

  app.use(require('./routes/public'));
  app.use(require('./routes/auth'));
  app.use(require('./routes/staff'));
  app.use(require('./routes/owner'));

  app.use((req, res) => res.status(404).page('error', { code: 404, msg: 'Page not found.', title: 'Not found' }, req.session.user ? 'app' : 'public'));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(err);
    if (res.headersSent) return;
    res.status(500).page('error', { code: 500, msg: 'Something went wrong. Please try again.', title: 'Error' }, req.session.user ? 'app' : 'public');
  });

  // Daily automatic backup (also one at start-up).
  const daily = () => { try { db.backup('auto'); } catch (e) { console.error('backup failed', e); } };
  daily(); setInterval(daily, 24 * 3600 * 1000).unref();
  const bye = () => { try { db.flush(); } finally { process.exit(0); } };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);

  const port = process.env.PORT || 3030;
  app.listen(port, () => console.log(`Travel system running at http://localhost:${port}`));
})();
