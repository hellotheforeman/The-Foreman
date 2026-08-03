const config = require('./config');

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
    .hero-section {
      padding: 100px 0 80px;
      text-align: center;
    }
    .hero-badge {
      display: inline-block;
      background: rgba(253, 185, 38, 0.15);
      color: var(--yellow);
      border: 1px solid rgba(253, 185, 38, 0.4);
      padding: 6px 16px; border-radius: 100px;
      font-size: 0.8rem; font-weight: 600;
      letter-spacing: 0.5px; text-transform: uppercase;
      margin-bottom: 28px;
    }
    .hero-section h1 {
      font-size: clamp(2rem, 5vw, 3rem);
      font-weight: 900; letter-spacing: -1.5px;
      margin-bottom: 20px; color: var(--white);
      line-height: 1.1;
    }
    .hero-section h1 span { color: var(--yellow); }
    .hero-section .subtitle {
      color: var(--mid); max-width: 480px;
      margin: 0 auto 40px; font-size: 1.05rem;
      line-height: 1.7;
    }
    .whatsapp-btn {
      display: inline-flex; align-items: center; gap: 10px;
      background: #25D366; color: #fff;
      padding: 16px 32px; border-radius: 10px;
      font-weight: 700; font-size: 1.05rem;
      text-decoration: none; transition: all 0.15s ease;
      box-shadow: 0 4px 20px rgba(37, 211, 102, 0.3);
    }
    .whatsapp-btn:hover {
      background: #1ebe5c;
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(37, 211, 102, 0.4);
    }
    .whatsapp-btn svg { width: 22px; height: 22px; flex-shrink: 0; }
    .steps-section {
      padding: 80px 0;
      border-top: 1px solid var(--border);
    }
    .steps-section h2 {
      text-align: center;
      font-size: 1.4rem; font-weight: 800;
      letter-spacing: -0.5px; margin-bottom: 48px;
      color: var(--white);
    }
    .steps-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 32px; max-width: 800px; margin: 0 auto;
    }
    .step {
      text-align: center;
    }
    .step-number {
      width: 40px; height: 40px; border-radius: 50%;
      background: rgba(253, 185, 38, 0.15);
      border: 1px solid rgba(253, 185, 38, 0.3);
      color: var(--yellow); font-weight: 800; font-size: 1rem;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 16px;
    }
    .step h3 {
      font-size: 0.95rem; font-weight: 700;
      color: var(--white); margin-bottom: 8px;
    }
    .step p { font-size: 0.875rem; color: var(--mid); line-height: 1.6; }
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
        <img src="/logo.png?v=2" alt="The Foreman" />
      </a>
    </div>
  </header>
`;

const FOOTER = `
  <footer class="footer">
    <div class="container footer-inner">
      <a href="/" class="logo">
        <img src="/logo.png?v=2" alt="The Foreman" />
      </a>
      <p class="footer-text">Built for UK tradespeople who'd rather be working than doing paperwork.</p>
      <p class="footer-copy">© 2026 The Foreman. All rights reserved.</p>
    </div>
  </footer>
`;

function renderLandingPage(whatsappUrl) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>The Foreman — WhatsApp assistant for sole traders</title>
  <meta name="description" content="Send quotes, invoices and payment chasers — all from WhatsApp. Built for UK tradespeople." />
  ${BASE_STYLES}
</head>
<body>
  ${NAV}

  <section class="hero-section">
    <div class="container">
      <div class="hero-badge">WhatsApp · No app needed</div>
      <h1>Quotes and invoices,<br /><span>straight from WhatsApp</span></h1>
      <p class="subtitle">Send professional quotes and invoices, track who owes you, and chase late payments — all without leaving WhatsApp.</p>
      <a href="${whatsappUrl}" class="whatsapp-btn" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
        </svg>
        Get started on WhatsApp
      </a>
    </div>
  </section>

  <section class="steps-section">
    <div class="container">
      <h2>Up and running in minutes</h2>
      <div class="steps-grid">
        <div class="step">
          <div class="step-number">1</div>
          <h3>Tap the button above</h3>
          <p>Opens WhatsApp and connects you straight to The Foreman. No app to download, no account to create.</p>
        </div>
        <div class="step">
          <div class="step-number">2</div>
          <h3>Quick setup</h3>
          <p>The Foreman will ask a few questions to get your business set up — name, trade, bank details. Takes around 30 seconds.</p>
        </div>
        <div class="step">
          <div class="step-number">3</div>
          <h3>Quotes, invoices, done</h3>
          <p>Send professional quotes and invoices as PDFs, track who owes you, chase late payments, and get a morning update on anything overdue — all from WhatsApp.</p>
        </div>
      </div>
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
      <div class="thanks-icon"><img src="/logo.png?v=2" alt="The Foreman" /></div>
      <h1>Request received!</h1>
      <p>Nice one. We'll review your details and get in touch once your WhatsApp number has been activated on The Foreman.</p>
    </div>
  </div>
</body>
</html>`;
}

function buildWhatsAppUrl() {
  const raw = (config.twilio.whatsappNumber || '').replace(/^whatsapp:/, '');
  const digits = raw.replace(/\D/g, '');
  const text = encodeURIComponent('Hi');
  return digits ? `https://wa.me/${digits}?text=${text}` : 'https://wa.me/';
}

function registerSignupRoutes(app) {
  const whatsappUrl = buildWhatsAppUrl();

  app.get('/signup', (req, res) => {
    res.send(renderLandingPage(whatsappUrl));
  });

  app.get('/signup/thanks', (req, res) => {
    res.send(renderThanksPage());
  });
}

module.exports = { registerSignupRoutes };
