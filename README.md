# Travel Assistance & Business Management System

Public website + staff/owner management system (Node.js, Express, EJS, SQLite via `sql.js`).

## Run
```
npm install
npm start          # http://localhost:3030
```
First start creates the owner account (`owner`) and prints a random password in the console
(set `OWNER_PASSWORD` to choose one). The owner must change it at first login.
Env: `PORT`, `SESSION_SECRET`, `NODE_ENV=production` (secure cookies — serve over HTTPS).

## Layout
- `routes/public.js` – website + request form · `routes/staff.js` – attendance, customers, requests, bookings, payments, expenses
- `routes/owner.js` – dashboard, finance, employees, attendance monitor/reports, content, audit, backups
- `lib/biz.js` – all money and attendance rules (late, absence, hours, finance totals)
- `data/` (created at runtime) – `travel.db`, `uploads/`, `backups/`

## Key rules implemented
- Money stored as integer centavos; PHP; Asia/Manila time, timestamps generated server-side.
- Outstanding = total payable − valid payments + refunds; payments/refunds are append-only, reversed (owner, with reason) never deleted.
- Late = time-in > shift start + grace. Absent = scheduled workday ended with no attendance/leave/holiday.
- Corrections keep the original record in `attendance_corrections`; everything important is in `audit_logs`.
- Accounting assumptions are printed on the Financial Reports page.

## Not included / next steps
- Email/SMS notifications; server-side PDF (use *PDF / Print* → Save as PDF; CSV opens in Excel).
- Sessions use the in-memory store (users must log in again after a restart) – swap for a persistent store at scale.
- Backups are file copies; copy `data/` off-machine regularly.
