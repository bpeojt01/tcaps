// SQLite (sql.js, pure JS) with file persistence. Single-process; writes are flushed to disk shortly after each change.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'travel.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

let db;
let timer = null;
let depth = 0;

async function open() {
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  return db;
}

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  const data = Buffer.from(db.export());
  db.run('PRAGMA foreign_keys = ON'); // export() resets pragmas
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, DB_FILE);
}
function dirty() { if (!depth && !timer) timer = setTimeout(flush, 400); }

const clean = (p) => p.map((v) => (v === undefined ? null : v));

function all(sql, p = []) {
  const st = db.prepare(sql);
  try {
    st.bind(clean(p));
    const rows = [];
    while (st.step()) rows.push(st.getAsObject());
    return rows;
  } finally { st.free(); }
}
const get = (sql, p = []) => all(sql, p)[0];
const val = (sql, p = []) => { const r = get(sql, p); return r ? Object.values(r)[0] : null; };

function run(sql, p = []) {
  db.run(sql, clean(p));
  const id = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  dirty();
  return id;
}

function tx(fn) {
  depth++;
  db.run('BEGIN');
  try {
    const r = fn();
    db.run('COMMIT');
    depth--;
    dirty();
    return r;
  } catch (e) {
    db.run('ROLLBACK');
    depth--;
    throw e;
  }
}

function backup(label = 'auto') {
  flush();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `travel-${label}-${stamp}.db`);
  fs.copyFileSync(DB_FILE, file);
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort();
  while (files.length > 30) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  return path.basename(file);
}
const listBackups = () => fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort().reverse();

module.exports = { open, all, get, val, run, tx, flush, backup, listBackups, BACKUP_DIR, DATA_DIR };
