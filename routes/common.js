const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../lib/db');
const U = require('../lib/util');

const requireLogin = (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  const u = db.get('SELECT active,role,can_expenses,must_change_pw FROM users WHERE id=?', [req.session.user.id]);
  if (!u || !u.active) return req.session.destroy(() => res.redirect('/login'));
  Object.assign(req.session.user, { role: u.role, can_expenses: !!u.can_expenses, must_change_pw: !!u.must_change_pw });
  if (u.must_change_pw && !req.originalUrl.startsWith('/app/profile')) return res.redirect('/app/profile');
  next();
};
const deny = (req, res) => res.status(403).page('error', { code: 403, msg: 'You do not have permission to open this page.', title: 'Forbidden' });
const requireOwner = (req, res, next) => (req.session.user && req.session.user.role === 'owner' ? next() : deny(req, res));
const requireExpenses = (req, res, next) => (req.session.user.role === 'owner' || req.session.user.can_expenses ? next() : deny(req, res));
const isOwner = (req) => req.session.user.role === 'owner';

// Accepts rows from a base query; returns paging info. `sql` must be a complete SELECT without LIMIT.
function paginate(req, sql, params, per = 20) {
  const total = db.val(`SELECT COUNT(*) FROM (${sql})`, params);
  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
  const rows = db.all(`${sql} LIMIT ${per} OFFSET ${(page - 1) * per}`, params);
  const qs = new URLSearchParams(req.query); qs.delete('page'); qs.delete('export');
  return { rows, total, page, pages, qs: qs.toString() };
}

const SORTS = (map, def) => (req) => {
  const col = map[req.query.sort] || map[def];
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
  return ` ORDER BY ${col} ${dir}, 1 DESC`;
};

const sendCsv = (res, name, head, rows) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}-${U.today()}.csv"` });
  res.send(U.toCsv(head, rows));
};

// ---------- uploads (stored outside the web root; served only through authenticated routes) ----------
const UPLOAD_DIR = path.join(db.DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED = { '.pdf': ['application/pdf'], '.jpg': ['image/jpeg'], '.jpeg': ['image/jpeg'], '.png': ['image/png'],
  '.doc': ['application/msword'], '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const ok = !!(ALLOWED[ext] && ALLOWED[ext].includes(file.mimetype));
    cb(ok ? null : new Error('Only PDF, JPG, PNG or Word files up to 5 MB are allowed.'), ok);
  },
});
// Wrap multer so upload errors become flash messages instead of crashes.
const uploadOne = (field) => (req, res, next) => upload.single(field)(req, res, (err) => {
  if (err) { res.flash('err', err.message); return res.redirect(req.get('referer') || '/app'); }
  next();
});
const sendStored = (res, stored, original) => {
  const p = path.join(UPLOAD_DIR, path.basename(stored));
  if (!fs.existsSync(p)) return res.status(404).send('File not found');
  res.download(p, original);
};

module.exports = { requireLogin, requireOwner, requireExpenses, isOwner, deny, paginate, SORTS, sendCsv, uploadOne, sendStored, UPLOAD_DIR };
