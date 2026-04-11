const crypto = require('crypto');
const db = require('./db');
const config = require('./config');

function adminSecretConfigured() {
  return Boolean(config.adminSecret);
}

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(String(a || ''));
  const bBuf = Buffer.from(String(b || ''));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function isAuthorised(req) {
  if (!adminSecretConfigured()) return false;

  const headerSecret = req.get('x-admin-secret');
  if (headerSecret && timingSafeEqual(headerSecret, config.adminSecret)) return true;

  const auth = req.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const password = separator >= 0 ? decoded.slice(separator + 1) : '';
      if (timingSafeEqual(password, config.adminSecret)) return true;
    } catch (_) {
      return false;
    }
  }

  return false;
}

function requireAdmin(req, res, next) {
  if (!adminSecretConfigured()) {
    return res.status(503).send('Admin dashboard is disabled. Set ADMIN_SECRET.');
  }

  if (isAuthorised(req)) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="The Foreman Admin"');
  return res.status(401).send('Unauthorized');
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
          <h3>${escapeHtml(business.business_name || business.name)}</h3>
          <p class="muted">${escapeHtml(business.trade || 'Trade not provided')}</p>
        </div>
        <span class="badge ${statusClass}">${escapeHtml(business.status)}</span>
      </div>
      <dl>
        <div><dt>Phone</dt><dd>${escapeHtml(business.phone)}</dd></div>
        <div><dt>Email</dt><dd>${escapeHtml(business.email || '—')}</dd></div>
        <div><dt>Contact</dt><dd>${escapeHtml(business.contact_name || '—')}</dd></div>
        <div><dt>Postcode</dt><dd>${escapeHtml(business.postcode || '—')}</dd></div>
        <div><dt>Created</dt><dd>${escapeHtml(new Date(business.created_at).toLocaleString('en-GB'))}</dd></div>
      </dl>
      ${business.notes ? `<p class="notes">${escapeHtml(business.notes)}</p>` : ''}
      <div class="actions">${actions.join('')}</div>
    </article>
  `;
}

async function renderDashboard(req, res) {
  const businesses = await db.listBusinesses();
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
      --bg: #0f172a;
      --panel: #111827;
      --panel-border: #243041;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --green: #22c55e;
      --amber: #f59e0b;
      --red: #ef4444;
      --blue: #38bdf8;
      --white: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, system-ui, sans-serif;
      background: linear-gradient(180deg, #020617, #111827);
      color: var(--text);
      padding: 24px;
    }
    .wrap {
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 { margin: 0 0 8px; }
    p { margin: 0; }
    .top {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-end;
      margin-bottom: 24px;
    }
    .muted { color: var(--muted); }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat, .card {
      background: rgba(17, 24, 39, 0.92);
      border: 1px solid var(--panel-border);
      border-radius: 16px;
      padding: 16px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    }
    .stat strong {
      font-size: 1.8rem;
      display: block;
      margin-top: 6px;
    }
    .columns {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 18px;
    }
    .column h2 {
      margin: 0 0 12px;
      font-size: 1.05rem;
    }
    .stack {
      display: grid;
      gap: 12px;
    }
    .card-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 14px;
    }
    .card h3 {
      margin: 0 0 4px;
      font-size: 1.05rem;
    }
    .badge {
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .status-pending { background: rgba(245, 158, 11, 0.18); color: #fbbf24; }
    .status-active { background: rgba(34, 197, 94, 0.18); color: #4ade80; }
    .status-suspended { background: rgba(239, 68, 68, 0.18); color: #f87171; }
    dl {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
      margin: 0 0 14px;
    }
    dl div {
      display: grid;
      grid-template-columns: 88px 1fr;
      gap: 8px;
      font-size: 0.95rem;
    }
    dt { color: var(--muted); }
    dd { margin: 0; word-break: break-word; }
    .notes {
      margin: 0 0 14px;
      padding: 12px;
      border-radius: 12px;
      background: rgba(255,255,255,0.03);
      color: #cbd5e1;
      white-space: pre-wrap;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    form { margin: 0; }
    button {
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      background: #334155;
      color: var(--white);
      cursor: pointer;
      font-weight: 600;
    }
    button.approve { background: #15803d; }
    button.danger { background: #b91c1c; }
    .empty {
      border: 1px dashed var(--panel-border);
      border-radius: 14px;
      padding: 18px;
      color: var(--muted);
      text-align: center;
    }
    .lock {
      font-size: 0.95rem;
      color: #cbd5e1;
      background: rgba(56, 189, 248, 0.08);
      border: 1px solid rgba(56, 189, 248, 0.2);
      border-radius: 12px;
      padding: 10px 14px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>🔐 The Foreman Admin</h1>
        <p class="muted">Approve, suspend, and review business signups.</p>
      </div>
      <div class="lock">Locked with HTTP Basic Auth + server-side admin secret</div>
    </div>

    <section class="stats">
      <div class="stat"><span class="muted">Pending</span><strong>${pending.length}</strong></div>
      <div class="stat"><span class="muted">Active</span><strong>${active.length}</strong></div>
      <div class="stat"><span class="muted">Suspended</span><strong>${suspended.length}</strong></div>
      <div class="stat"><span class="muted">Total</span><strong>${businesses.length}</strong></div>
    </section>

    <section class="columns">
      <div class="column">
        <h2>Pending approval</h2>
        <div class="stack">
          ${pending.length ? pending.map(renderBusinessCard).join('') : '<div class="empty">No pending signups.</div>'}
        </div>
      </div>
      <div class="column">
        <h2>Active</h2>
        <div class="stack">
          ${active.length ? active.map(renderBusinessCard).join('') : '<div class="empty">No active businesses.</div>'}
        </div>
      </div>
      <div class="column">
        <h2>Suspended</h2>
        <div class="stack">
          ${suspended.length ? suspended.map(renderBusinessCard).join('') : '<div class="empty">No suspended businesses.</div>'}
        </div>
      </div>
    </section>
  </div>
</body>
</html>`);
}

async function listBusinesses(req, res) {
  const businesses = await db.listBusinesses();
  res.json({ businesses });
}

async function updateBusinessStatus(req, res, status) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid business id' });
  }

  const business = await db.updateBusinessStatus(id, status);
  if (!business) {
    return res.status(404).json({ error: 'Business not found' });
  }

  if (req.accepts('html')) {
    return res.redirect('/admin');
  }

  return res.json({ business });
}

function registerAdminRoutes(app) {
  app.get('/admin', requireAdmin, renderDashboard);
  app.get('/admin/businesses', requireAdmin, listBusinesses);
  app.post('/admin/businesses/:id/activate', requireAdmin, (req, res) => updateBusinessStatus(req, res, 'active'));
  app.post('/admin/businesses/:id/suspend', requireAdmin, (req, res) => updateBusinessStatus(req, res, 'suspended'));
  app.post('/admin/businesses/:id/pending', requireAdmin, (req, res) => updateBusinessStatus(req, res, 'pending'));
}

module.exports = {
  registerAdminRoutes,
  requireAdmin,
};
