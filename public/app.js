(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // Mobile sidebar
  const menu = $('[data-menu]'), side = $('.side');
  if (menu && side) menu.addEventListener('click', () => side.classList.toggle('open'));

  // Philippine clock, offset from the server's time so a wrong PC clock cannot mislead (display only; records use server time).
  $$('[data-clock]').forEach((el) => {
    const srv = Date.parse(el.dataset.now.replace(' ', 'T') + '+08:00'), off = srv - Date.now();
    const fmt = new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    const tick = () => { el.textContent = fmt.format(new Date(Date.now() + off)); };
    tick(); setInterval(tick, 1000);
  });

  // Confirm dialogs, print, loading state on submit
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-confirm]');
    if (c && !window.confirm(c.dataset.confirm)) { e.preventDefault(); return; }
    if (e.target.closest('[data-print]')) { e.preventDefault(); window.print(); }
  });
  document.addEventListener('submit', (e) => {
    const f = e.target, b = f.querySelector('button[type=submit],button:not([type])');
    if (b && !f.dataset.noload) setTimeout(() => { b.disabled = true; b.innerHTML = '<span class="spin"></span>Please wait…'; }, 0);
  });

  // One-page home: highlight the nav link of the section currently in view
  const spy = $$('[data-spy]'), secs = spy.map((a) => document.getElementById(a.dataset.spy)).filter(Boolean);
  if (secs.length && 'IntersectionObserver' in window) {
    const mark = (id) => spy.forEach((a) => a.classList.toggle('on', a.dataset.spy === id));
    const seen = new Map();
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => seen.set(e.target.id, e.isIntersecting));
      const cur = secs.filter((s) => seen.get(s.id)).pop();
      if (cur) mark(cur.id);
    }, { rootMargin: '-40% 0px -55% 0px' });
    secs.forEach((s) => io.observe(s));
  }

  // Auto-submit filter selects
  $$('select[data-auto]').forEach((s) => s.addEventListener('change', () => s.form.submit()));

  // Request form: show only the fields for the chosen service
  const svc = $('select[name=service_type]');
  if (svc) {
    const apply = () => {
      $$('[data-types]').forEach((g) => {
        const on = g.dataset.types.split('|').includes(svc.value);
        g.hidden = !on;
        $$('input,select,textarea', g).forEach((i) => { i.disabled = !on; });
      });
      const trip = $('[name=d_trip_type]:not(:disabled)');
      $$('[data-when-trip]').forEach((el) => { const on = !!trip && trip.value === el.dataset.whenTrip; el.hidden = !on; $$('input', el).forEach((i) => { i.disabled = !on || el.closest('[data-types]').hidden; }); });
    };
    svc.addEventListener('change', apply);
    document.addEventListener('change', (e) => { if (e.target.name === 'd_trip_type') apply(); });
    apply();
  }

  // Dashboard charts
  const data = $('#chart-data');
  if (data) {
    const run = () => {
      if (!window.Chart) return setTimeout(run, 150);
      const d = JSON.parse(data.textContent), C = window.Chart;
      const col = ['#c99a2e', '#b5651d', '#2f7d4a', '#7a5c2e', '#b23a2b', '#e3c26a', '#8a6212', '#d98e4a'];
      const peso = (v) => '₱' + Number(v).toLocaleString('en-PH');
      const mk = (id, cfg) => { const el = document.getElementById(id); if (el) new C(el, { ...cfg, options: { responsive: true, maintainAspectRatio: false, ...cfg.options } }); };
      const money = { scales: { y: { ticks: { callback: peso } } }, plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${peso(c.parsed.y)}` } } } };
      mk('c-sales', { type: 'bar', data: { labels: d.months, datasets: [{ label: 'Booking sales', data: d.sales, backgroundColor: col[0] }, { label: 'Collections', data: d.collected, backgroundColor: col[1] }] }, options: money });
      mk('c-net', { type: 'line', data: { labels: d.months, datasets: [{ label: 'Expenses', data: d.expenses, borderColor: col[4], tension: .3 }, { label: 'Net operating result', data: d.net, borderColor: col[2], tension: .3 }] }, options: money });
      mk('c-svc', { type: 'doughnut', data: { labels: d.byService.map((x) => x.k), datasets: [{ data: d.byService.map((x) => x.n), backgroundColor: col }] } });
      mk('c-status', { type: 'pie', data: { labels: d.byStatus.map((x) => x.k), datasets: [{ data: d.byStatus.map((x) => x.n), backgroundColor: col }] } });
      mk('c-inq', { type: 'line', data: { labels: d.months, datasets: [{ label: 'New inquiries', data: d.inquiries, borderColor: col[0], fill: true, backgroundColor: '#c99a2e33', tension: .3 }] }, options: { scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } } });
      mk('c-att', { type: 'bar', data: { labels: d.attMonths, datasets: [{ label: 'Attendance records', data: d.attMonthly, backgroundColor: col[2] }] }, options: { scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } } });
      mk('c-emp', { type: 'bar', data: { labels: d.perEmp.map((x) => x.n), datasets: [{ label: 'Late', data: d.perEmp.map((x) => x.late), backgroundColor: col[1] }, { label: 'Absent', data: d.perEmp.map((x) => x.absent), backgroundColor: col[4] }] }, options: { scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } } });
    };
    run();
  }
})();
