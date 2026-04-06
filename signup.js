const db = require('./db');

function normalisePhone(phone) {
  if (!phone) return '';
  let value = String(phone).trim().replace(/[\s()-]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (value.startsWith('0')) value = `+44${value.slice(1)}`;
  if (value.startsWith('44') && !value.startsWith('+')) value = `+${value}`;
  return value;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSignupPage(error = '', values = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>The Foreman Signup</title>
  <style>
    body {
      font-family: Inter, system-ui, sans-serif;
      margin: 0;
      min-height: 100vh;
      background: linear-gradient(180deg, #020617, #0f172a);
      color: #e5e7eb;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .panel {
      width: 100%;
      max-width: 640px;
      background: rgba(15, 23, 42, 0.96);
      border: 1px solid #233046;
      border-radius: 20px;
      padding: 28px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.3);
    }
    h1 { margin-top: 0; margin-bottom: 8px; }
    p { color: #94a3b8; }
    form { display: grid; gap: 16px; margin-top: 24px; }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
    label { display: grid; gap: 6px; font-weight: 600; }
    input, textarea {
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid #334155;
      background: #0b1220;
      color: #e5e7eb;
      font: inherit;
    }
    textarea { min-height: 110px; resize: vertical; }
    button {
      border: 0;
      border-radius: 12px;
      padding: 14px 16px;
      background: #22c55e;
      color: #052e16;
      font-weight: 800;
      cursor: pointer;
    }
    .error {
      margin-top: 16px;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(239, 68, 68, 0.15);
      color: #fca5a5;
      border: 1px solid rgba(239, 68, 68, 0.25);
    }
  </style>
</head>
<body>
  <section class="panel">
    <h1>🔨 Sign up to The Foreman</h1>
    <p>Tell us about your business. We’ll review it and activate your WhatsApp number for the shared Foreman line.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="post" action="/signup">
      <div class="grid">
        <label>
          Business name
          <input name="name" required value="${escapeHtml(values.name || '')}" />
        </label>
        <label>
          Trade
          <input name="trade" placeholder="Plumbing, electrical, roofing..." value="${escapeHtml(values.trade || '')}" />
        </label>
      </div>
      <div class="grid">
        <label>
          Contact name
          <input name="contact_name" required value="${escapeHtml(values.contact_name || '')}" />
        </label>
        <label>
          Email
          <input type="email" name="email" value="${escapeHtml(values.email || '')}" />
        </label>
      </div>
      <div class="grid">
        <label>
          WhatsApp number
          <input name="phone" required placeholder="07800 900123" value="${escapeHtml(values.phone || '')}" />
        </label>
        <label>
          Postcode
          <input name="postcode" value="${escapeHtml(values.postcode || '')}" />
        </label>
      </div>
      <label>
        Notes
        <textarea name="notes" placeholder="Anything useful about the business, service area, or setup">${escapeHtml(values.notes || '')}</textarea>
      </label>
      <button type="submit">Request access</button>
    </form>
  </section>
</body>
</html>`;
}

function registerSignupRoutes(app) {
  app.get('/signup', (req, res) => {
    res.send(renderSignupPage());
  });

  app.post('/signup', async (req, res) => {
    const values = {
      name: (req.body.name || '').trim(),
      trade: (req.body.trade || '').trim(),
      contact_name: (req.body.contact_name || '').trim(),
      email: (req.body.email || '').trim(),
      phone: (req.body.phone || '').trim(),
      postcode: (req.body.postcode || '').trim(),
      notes: (req.body.notes || '').trim(),
    };

    const phone = normalisePhone(values.phone);

    if (!values.name || !values.contact_name || !phone) {
      return res.status(400).send(renderSignupPage('Business name, contact name, and WhatsApp number are required.', values));
    }

    await db.createBusiness({
      ...values,
      phone,
    });

    res.redirect('/signup/thanks');
  });

  app.get('/signup/thanks', (req, res) => {
    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Thanks — The Foreman</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: linear-gradient(180deg, #020617, #0f172a);
      color: #e5e7eb;
      font-family: Inter, system-ui, sans-serif;
      padding: 24px;
    }
    .panel {
      max-width: 620px;
      background: rgba(15, 23, 42, 0.96);
      border: 1px solid #233046;
      border-radius: 20px;
      padding: 28px;
      text-align: center;
    }
    p { color: #94a3b8; }
  </style>
</head>
<body>
  <section class="panel">
    <h1>Thanks — request received</h1>
    <p>Your business has been added for review. Once approved, your WhatsApp number will work with The Foreman.</p>
  </section>
</body>
</html>`);
  });
}

module.exports = {
  registerSignupRoutes,
  normalisePhone,
};
