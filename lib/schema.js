const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, description TEXT, icon TEXT,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, emp_no TEXT UNIQUE, name TEXT NOT NULL, email TEXT, username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','employee')),
  active INTEGER NOT NULL DEFAULT 1, can_expenses INTEGER NOT NULL DEFAULT 0, must_change_pw INTEGER NOT NULL DEFAULT 0,
  sched_start TEXT NOT NULL DEFAULT '08:00', sched_end TEXT NOT NULL DEFAULT '17:00',
  grace_min INTEGER NOT NULL DEFAULT 10, break_min INTEGER NOT NULL DEFAULT 60,
  workdays TEXT NOT NULL DEFAULT '1,2,3,4,5', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE, name TEXT NOT NULL, phone TEXT, email TEXT,
  pref_contact TEXT, notes TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_cust_name ON customers(name);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(id),
  service_type TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'Pending Review',
  source TEXT NOT NULL DEFAULT 'Website', assigned_to INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_req_status ON requests(status);
CREATE TABLE IF NOT EXISTS request_log (
  id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id), from_status TEXT, to_status TEXT,
  note TEXT, user_id INTEGER REFERENCES users(id), at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY, entity TEXT NOT NULL, entity_id INTEGER NOT NULL, body TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id), at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE, customer_id INTEGER NOT NULL REFERENCES customers(id),
  request_id INTEGER REFERENCES requests(id), service_type TEXT NOT NULL, supplier TEXT, details TEXT,
  supplier_cost INTEGER NOT NULL DEFAULT 0, selling_price INTEGER NOT NULL DEFAULT 0,
  service_fee INTEGER NOT NULL DEFAULT 0, discount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Quoted' CHECK (status IN ('Quoted','Confirmed','Completed','Cancelled')),
  assigned_to INTEGER REFERENCES users(id), confirmation_ref TEXT, remarks TEXT,
  created_at TEXT NOT NULL, updated_at TEXT);
CREATE INDEX IF NOT EXISTS ix_bk_cust ON bookings(customer_id);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE, booking_id INTEGER NOT NULL REFERENCES bookings(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id), paid_at TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL, reference TEXT, kind TEXT NOT NULL DEFAULT 'Payment' CHECK (kind IN ('Payment','Refund')),
  status TEXT NOT NULL DEFAULT 'Valid' CHECK (status IN ('Valid','Reversed')),
  remarks TEXT, user_id INTEGER REFERENCES users(id), reversed_by INTEGER, reversed_reason TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_pay_bk ON payments(booking_id);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, spent_at TEXT NOT NULL, category TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT, description TEXT, receipt TEXT, user_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'Valid' CHECK (status IN ('Valid','Voided')), void_reason TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id), stored TEXT NOT NULL, original TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id), at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL,
  time_in TEXT, time_out TEXT, is_late INTEGER NOT NULL DEFAULT 0, late_min INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, day));
CREATE TABLE IF NOT EXISTS attendance_corrections (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, day TEXT NOT NULL, old_in TEXT, old_out TEXT, new_in TEXT, new_out TEXT,
  reason TEXT NOT NULL, by_user INTEGER NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS leaves (
  id INTEGER PRIMARY KEY, user_id INTEGER, day TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('Leave','Holiday')),
  note TEXT, UNIQUE (user_id, day, kind));
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, username TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, detail TEXT, ip TEXT);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, name TEXT, email TEXT, phone TEXT, body TEXT, at TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0);
`;

const DEFAULT_SETTINGS = {
  business_name: 'Alchemist Trip & Ride Travel Service',
  tagline: 'Your Travel Partner, One Click Away!',
  location: 'Puerto Princesa City, Palawan',
  phone: '', mobile: '0951 672 3814', email: '',
  address: 'Puerto Princesa City, Palawan',
  hours: '',
  facebook: '', facebook_name: 'Alchemist Trip&Ride Travel Service', instagram: '',
  about: 'Sa Alchemist Trip&Ride Travel Service, kasama mo kami mula booking hanggang biyahe.\n\nWe are a travel assistance service in Puerto Princesa City, Palawan. We help customers arrange domestic and international airline tickets, hotel reservations and other travel needs. Our team coordinates with airlines and suppliers on your behalf, so you get clear options and honest quotations.',
  mission: 'To make travel easy, affordable and reliable by guiding every traveller from booking to biyahe.',
  vision: 'To be the most trusted travel partner in Palawan and beyond.',
  values: 'Travel made easy, Affordable, Reliable, Personalized service',
  fares_title: 'Lowest fares · selected dates only · September to December 2026',
  fares_note: 'Fares are per person, one-way, for selected dates only, and subject to change and seat availability. Send a request and our team will confirm the exact fare before anything is booked.',
  fares: 'Manila to Palawan|2714\nPalawan to Manila|2583\nPalawan to Iloilo|2327\nCebu to Cagayan de Oro|2344\nButuan City to Manila|2240\nCagayan de Oro to Cebu City|1870\nCaticlan to Manila|2330\nBacolod to Manila|1892',
  partners: 'Philippine Airlines, Cebu Pacific, AirAsia, Royal Air, Airswift, Starlite Ferries, Horizon Sun',
  why: [
    'May taong tutulong sa booking|Hindi mo kailangang gawin lahat mag-isa.',
    'Mas madaling magtanong|May mapagkukunan ka ng impormasyon tungkol sa flight, baggage, schedule, at requirements.',
    'Mas madali at mabilis|Maaaring maghanap ng available options para sa\'yo.',
    'Assistance kapag may changes|Maaaring tumulong sa rebooking o concerns, depende sa airline at booking terms.',
    'Mas convenient para sa first-time travelers|May gabay bago ang biyahe.',
    'Personalized service|Maaaring iayon ang options sa budget at travel needs mo.',
  ].join('\n'),
  privacy: 'We collect your name, contact details and travel requirements only to respond to your request and to process bookings you approve. We do not sell your information. Access is limited to authorized staff, and records are kept only as long as needed for service, accounting and legal obligations, in line with the Philippine Data Privacy Act of 2012 (RA 10173). You may ask to access, correct or delete your data by contacting us.',
  retention_years: '5',
};

const SERVICES = [
  ['Domestic Flight Assistance', 'Domestic flight', 'We find and arrange domestic airline tickets that fit your schedule and budget.', '✈️'],
  ['International Flight Assistance', 'International flight', 'Help with international airfare, routing and ticketing for leisure or business travel.', '🌍'],
  ['Hotel Reservations', 'Hotel reservation', 'Hotel and accommodation arrangements in the Philippines and abroad.', '🏨'],
  ['Travel Package Assistance', 'Travel package', 'Combined flights, hotels and tours tailored to your trip.', '🧳'],
  ['Group Travel Bookings', 'Group booking', 'Group fares and rooming for families, teams, pilgrimages and events.', '👥'],
  ['Other Travel Services', 'Other travel service', 'Visa guidance, transfers, travel insurance and other travel needs.', '🧭'],
];

async function init() {
  await db.open();
  db.tx(() => { for (const s of SCHEMA.split(/;\s*\n/).filter((x) => x.trim())) db.run(s); });
  const have = new Set(db.all('SELECT key FROM settings').map((r) => r.key));
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (!have.has(k)) db.run('INSERT INTO settings VALUES (?,?)', [k, v]);
  // One-time switch from the placeholder content to the real business details (later edits in the dashboard are kept).
  if (!have.has('_brand_v')) {
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (k !== 'privacy' && k !== 'retention_years') db.run('INSERT OR REPLACE INTO settings VALUES (?,?)', [k, DEFAULT_SETTINGS[k]]);
    db.run(`INSERT INTO settings VALUES ('_brand_v','1')`);
  }
  if (!db.val('SELECT COUNT(*) FROM services')) SERVICES.forEach((s, i) => db.run('INSERT INTO services (name,type,description,icon,sort) VALUES (?,?,?,?,?)', [...s, i]));
  if (!db.val('SELECT COUNT(*) FROM users')) {
    const pw = process.env.OWNER_PASSWORD || crypto.randomBytes(9).toString('base64url');
    db.run(`INSERT INTO users (emp_no,name,username,password_hash,role,can_expenses,must_change_pw,created_at) VALUES ('EMP-0001','Owner','owner',?, 'owner',1,1,datetime('now'))`, [bcrypt.hashSync(pw, 12)]);
    console.log(`\n  First-run owner account created.\n  Username: owner\n  Password: ${pw}   (you will be asked to change it at first login)\n`);
  }
  db.flush();
}
module.exports = { init };
