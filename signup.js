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

const BASE_STYLES = `
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --yellow: #FDB926;
      --yellow-dark: #E5A615;
      --dark: #111A21;
      --dark2: #1A2730;
      --mid: #8A9BA8;
      --border: #2A3740;
      --white: #FDFDFD;
      --radius: 12px;
      --radius-lg: 20px;
    }
    body {
      font-family: 'Inter', sans-serif;
      background: var(--dark);
      color: var(--white);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
    }
    .container { max-width: 1100px; margin: 0 auto; padding: 0 20px; }
    .nav {
      position: sticky; top: 0;
      background: var(--dark);
      border-bottom: 1px solid var(--border);
      z-index: 100; padding: 16px 0;
    }
    .nav-inner { display: flex; align-items: center; justify-content: space-between; }
    .logo {
      display: flex; align-items: center; gap: 10px;
      text-decoration: none; color: var(--white);
      font-size: 1.2rem; font-weight: 800; letter-spacing: -0.5px;
    }
    .logo img { height: 64px; width: auto; }
    .btn {
      display: inline-block; padding: 12px 24px; border-radius: 8px;
      font-weight: 600; font-size: 0.95rem; cursor: pointer;
      text-decoration: none; transition: all 0.15s ease; border: none;
      font-family: 'Inter', sans-serif;
      -webkit-appearance: none; appearance: none; box-shadow: none;
    }
    .btn-nav {
      background: var(--dark2); color: var(--white);
      padding: 10px 20px; font-size: 0.875rem;
    }
    .btn-nav:hover { background: var(--dark2); border: 1px solid var(--border); }
    .btn-primary { background: var(--yellow); color: var(--dark); font-weight: 700; }
    .btn-primary:hover {
      background: var(--yellow-dark);
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(245,200,66,0.4);
    }
    .btn-large { padding: 16px 32px; font-size: 1.05rem; border-radius: 10px; }
    .btn-full { width: 100%; text-align: center; }
    .signup-section {
      padding: 80px 0;
      background: var(--dark);
      text-align: center;
    }
    .hero-badge {
      display: inline-block;
      background: rgba(253, 185, 38, 0.15);
      color: var(--yellow);
      border: 1px solid var(--yellow);
      padding: 6px 16px; border-radius: 100px;
      font-size: 0.8rem; font-weight: 600;
      letter-spacing: 0.5px; text-transform: uppercase;
      margin-bottom: 24px;
    }
    .signup-section h2 {
      font-size: clamp(1.8rem, 4vw, 2.4rem);
      font-weight: 900; letter-spacing: -1px;
      margin-bottom: 16px; color: var(--white);
    }
    .signup-section > .container > p {
      color: var(--mid); max-width: 480px;
      margin: 0 auto 40px; font-size: 1rem;
    }
    .signup-form {
      max-width: 560px; margin: 0 auto;
      display: flex; flex-direction: column; gap: 12px;
    }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .signup-form input {
      width: 100%; min-width: 0; padding: 14px 16px;
      border: 1.5px solid var(--border); border-radius: 8px;
      font-size: 0.95rem; font-family: 'Inter', sans-serif;
      outline: none; transition: border-color 0.15s;
      background: var(--dark2); color: var(--white);
    }
    .signup-form input:focus { border-color: var(--yellow); background: var(--dark2); }
    .signup-form input::placeholder { color: var(--mid); }
    .form-note { font-size: 0.8rem; color: var(--mid); margin-top: 4px; }
    .error-box {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5; border-radius: 8px;
      padding: 12px 16px; font-size: 0.9rem; text-align: left;
    }
    .footer {
      padding: 40px 0; background: var(--dark);
      color: var(--mid); border-top: 1px solid var(--border);
    }
    .footer-inner { text-align: center; }
    .footer .logo { color: var(--white); margin-bottom: 12px; justify-content: center; }
    .footer-text { font-size: 0.9rem; max-width: 400px; margin: 0 auto 16px; }
    .footer-copy { font-size: 0.8rem; color: var(--mid); opacity: 0.7; }
    @media (max-width: 600px) {
      .form-row { grid-template-columns: 1fr; }
      .btn-large { padding: 14px 24px; font-size: 1rem; }
    }
  </style>
`;

const NAV = `
  <header class="nav">
    <div class="container nav-inner">
      <a href="/" class="logo">
        <img src="/logo.png" alt="The Foreman" />
      </a>
    </div>
  </header>
`;

const FOOTER = `
  <footer class="footer">
    <div class="container footer-inner">
      <a href="/" class="logo">
        <img src="/logo.png" alt="The Foreman" />
      </a>
      <p class="footer-text">Built for UK tradespeople who'd rather be working than doing paperwork.</p>
      <p class="footer-copy">© 2026 The Foreman. All rights reserved.</p>
    </div>
  </footer>
`;

function renderSignupPage(error = '', values = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign Up — The Foreman</title>
  <meta name="description" content="Sign up for The Foreman — your AI trade assistant on WhatsApp." />
  ${BASE_STYLES}
</head>
<body>
  ${NAV}
  <section class="signup-section">
    <div class="container">
      <div class="hero-badge">AI-powered trade assistant</div>
      <h2>Get started with The Foreman</h2>
      <p>Sign your business up and we'll activate your WhatsApp number for The Foreman.</p>
      <form method="post" action="/signup" class="signup-form">
        ${error ? `<div class="error-box">${escapeHtml(error)}</div>` : ''}
        <div class="form-row">
          <input name="contact_name" placeholder="Your name" required value="${escapeHtml(values.contact_name || '')}" />
          <input name="name" placeholder="Business name" required value="${escapeHtml(values.name || '')}" />
        </div>
        <div class="form-row">
          <input name="trade" placeholder="Trade (e.g. plumbing, electrical)" value="${escapeHtml(values.trade || '')}" />
          <input type="email" name="email" placeholder="Email address" value="${escapeHtml(values.email || '')}" />
        </div>
        <input name="phone" placeholder="WhatsApp number (e.g. 07800 900123)" required value="${escapeHtml(values.phone || '')}" />
        <button type="submit" class="btn btn-primary btn-large btn-full">Sign up now →</button>
        <p class="form-note">We'll review your request and be in touch once you're approved.</p>
      </form>
    </div>
  </section>
  ${FOOTER}
</body>
</html>`;
}

function renderThanksPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>You're on the list — The Foreman</title>
  ${BASE_STYLES}
  <style>
    .thanks-page {
      min-height: 100vh; display: flex;
      align-items: center; justify-content: center;
      text-align: center; padding: 40px 20px;
      background: var(--dark2);
    }
    .thanks-card {
      background: var(--dark); border: 1px solid var(--border);
      border-radius: var(--radius-lg); padding: 48px 40px;
      max-width: 520px; width: 100%;
    }
    .thanks-icon { margin-bottom: 24px; }
    .thanks-icon img { height: 72px; width: auto; }
    .thanks-card h1 {
      font-size: 1.8rem; font-weight: 900;
      letter-spacing: -0.8px; margin-bottom: 16px; color: var(--white);
    }
    .thanks-card p { color: var(--mid); margin-bottom: 32px; line-height: 1.7; }
  </style>
</head>
<body>
  <div class="thanks-page">
    <div class="thanks-card">
      <div class="thanks-icon"><img src="/logo.png" alt="The Foreman" /></div>
      <h1>Request received!</h1>
      <p>Nice one. We'll review your details and get in touch once your WhatsApp number has been activated on The Foreman.</p>
    </div>
  </div>
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
    };

    const phone = normalisePhone(values.phone);

    if (!values.name || !values.contact_name || !phone) {
      return res.status(400).send(renderSignupPage('Business name, your name, and WhatsApp number are required.', values));
    }

    await db.createBusiness({ ...values, phone });

    res.redirect('/signup/thanks');
  });

  app.get('/signup/thanks', (req, res) => {
    res.send(renderThanksPage());
  });
}

module.exports = {
  registerSignupRoutes,
  normalisePhone,
};
