const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const router = express.Router();

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(String(a || ''));
  const bBuf = Buffer.from(String(b || ''));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requestWantsHtml(req) {
  const accept = req.get('accept') || '';
  return accept.includes('text/html');
}

function requireAdmin(req, res, next) {
  if (!config.adminSecret) {
    return res.status(503).send('Admin dashboard disabled. Set ADMIN_SECRET.');
  }

  const headerSecret = req.headers['x-admin-secret'];
  if (headerSecret && timingSafeEqual(headerSecret, config.adminSecret)) {
    return next();
  }

  const auth = req.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const password = idx >= 0 ? decoded.slice(idx + 1) : '';
      if (timingSafeEqual(password, config.adminSecret)) {
        return next();
      }
    } catch (_) {
      // ignore malformed auth header
    }
  }

  if (requestWantsHtml(req)) {
    res.set('WWW-Authenticate', 'Basic realm="The Foreman Admin"');
    return res.status(401).send('Unauthorized');
  }

  return res.status(401).json({ error: 'Unauthorised' });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderBusinessCard(business) {
  const statusClass = `status-${business.status}`;
  const actions = [];

  if (business.status !== 'active') {
    actions.push(`
      <form method="post" action="/admin/businesses/${business.id}/activate">
        <button type="submit" class="approve">Approve</button>
      </form>
    `);
  }

  if (business.status !== 'suspended') {
    actions.push(`
      <form method="post" action="/admin/businesses/${business.id}/suspend">
        <button type="submit" class="danger">Suspend</button>
      </form>
    `);
  }

  if (business.status !== 'pending') {
    actions.push(`
      <form method="post" action="/admin/businesses/${business.id}/pending">
        <button type="submit">Mark pending</button>
      </form>
    `);
  }

  return `
    <article class="card">
      <div class="card-head">
        <div>
          <h3>${escapeHtml(business.business_name)}</h3>
          <p class="muted">${escapeHtml(business.contact_name || 'No contact name')}</p>
        </div>
        <span class="badge ${statusClass}">${escapeHtml(business.status)}</span>
      </div>
      <dl>
        <div><dt>Phone</dt><dd>${escapeHtml(business.phone)}</dd></div>
        <div><dt>Email</dt><dd>${escapeHtml(business.email || '—')}</dd></div>
        <div><dt>Plan</dt><dd>${escapeHtml(business.plan || 'trial')}</dd></div>
        <div><dt>Created</dt><dd>${escapeHtml(new Date(business.created_at).toLocaleString('en-GB'))}</dd></div>
      </dl>
      <div class="actions">${actions.join('')}</div>
    </article>
  `;
}

function renderSection(title, businesses) {
  return `
    <section class="column">
      <h2>${escapeHtml(title)}</h2>
      <div class="stack">
        ${businesses.length ? businesses.map(renderBusinessCard).join('') : '<div class="empty">Nothing here.</div>'}
      </div>
    </section>
  `;
}

async function renderDashboard(req, res) {
  const businesses = await db.getAll('SELECT * FROM businesses ORDER BY created_at DESC');
  const pending = businesses.filter((b) => b.status === 'pending');
  const active = businesses.filter((b) => b.status === 'active');
  const suspended = businesses.filter((b) => b.status === 'suspended');

  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>The Foreman Admin</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #020617;
      --panel: #0f172a;
      --panel-border: #243041;
      --text: #e5e7eb;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: linear-gradient(180deg, #020617, #111827);
      color: var(--text);
      font-family: Inter, system-ui, sans-serif;
      padding: 24px;
    }
    .wrap { max-width: 1180px; margin: 0 auto; }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 16px;
      margin-bottom: 24px;
    }
    .top h1 { margin: 0 0 8px; }
    .muted { color: var(--muted); }
    .lock {
      border: 1px solid rgba(56, 189, 248, 0.25);
      background: rgba(56, 189, 248, 0.08);
      padding: 10px 14px;
      border-radius: 12px;
      color: #cbd5e1;
      font-size: 0.95rem;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat, .card {
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid var(--panel-border);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 12px 30px rgba(0,0,0,0.2);
    }
    .stat strong {
      display: block;
      margin-top: 6px;
      font-size: 1.8rem;
    }
    .columns {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 18px;
    }
    .column h2 { margin: 0 0 12px; font-size: 1.05rem; }
    .stack { display: grid; gap: 12px; }
    .card-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    .card h3 { margin: 0 0 4px; }
    .badge {
      padding: 6px 10px;
      border-radius: 999px;
      text-transform: uppercase;
      font-size: 0.78rem;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .status-pending { background: rgba(245, 158, 11, 0.18); color: #fbbf24; }
    .status-active { background: rgba(34, 197, 94, 0.18); color: #4ade80; }
    .status-suspended { background: rgba(239, 68, 68, 0.18); color: #f87171; }
    dl { display: grid; gap: 8px; margin: 0; }
    dl div { display: grid; grid-template-columns: 70px 1fr; gap: 8px; }
    dt { color: var(--muted); }
    dd { margin: 0; word-break: break-word; }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    form { margin: 0; }
    button {
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      background: #334155;
      color: white;
      font-weight: 600;
      cursor: pointer;
    }
    button.approve { background: #15803d; }
    button.danger { background: #b91c1c; }
    .empty {
      padding: 18px;
      border: 1px dashed var(--panel-border);
      border-radius: 14px;
      color: var(--muted);
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>🔐 The Foreman Admin</h1>
        <p class="muted">Approve or suspend business signups from the browser.</p>
      </div>
      <div class="lock">Protected by HTTP Basic Auth and server-side ADMIN_SECRET</div>
    </div>

    <div class="stats">
      <div class="stat"><span class="muted">Pending</span><strong>${pending.length}</strong></div>
      <div class="stat"><span class="muted">Active</span><strong>${active.length}</strong></div>
      <div class="stat"><span class="muted">Suspended</span><strong>${suspended.length}</strong></div>
      <div class="stat"><span class="muted">Total</span><strong>${businesses.length}</strong></div>
    </div>

    <div class="columns">
      ${renderSection('Pending approval', pending)}
      ${renderSection('Active', active)}
      ${renderSection('Suspended', suspended)}
    </div>
  </div>
</body>
</html>`);
}

router.get('/admin', requireAdmin, renderDashboard);

router.get('/admin/businesses', requireAdmin, async (req, res) => {
  const businesses = await db.getAll('SELECT * FROM businesses ORDER BY created_at DESC');
  res.json(businesses);
});

router.get('/admin/businesses/:id', requireAdmin, async (req, res) => {
  const business = await db.getBusiness(parseInt(req.params.id, 10));
  if (!business) return res.status(404).json({ error: 'Not found' });
  res.json(business);
});

async function setStatus(req, res, status) {
  const id = parseInt(req.params.id, 10);
  const business = await db.getBusiness(id);
  if (!business) {
    return requestWantsHtml(req)
      ? res.status(404).send('Not found')
      : res.status(404).json({ error: 'Not found' });
  }

  await db.updateBusinessStatus(id, status);
  console.log(`${status === 'active' ? '✅' : status === 'suspended' ? '🚫' : '🕒'} Business #${id} (${business.business_name}) -> ${status}`);

  if (requestWantsHtml(req)) {
    return res.redirect('/admin');
  }

  return res.json({ ok: true, status });
}

router.post('/admin/businesses/:id/activate', requireAdmin, async (req, res) => setStatus(req, res, 'active'));
router.post('/admin/businesses/:id/suspend', requireAdmin, async (req, res) => setStatus(req, res, 'suspended'));
router.post('/admin/businesses/:id/pending', requireAdmin, async (req, res) => setStatus(req, res, 'pending'));

module.exports = router;
