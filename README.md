# The Foreman

A WhatsApp business assistant for UK sole traders. Quotes, invoices, job tracking, and payment chasing — all through plain-English WhatsApp messages. No app, no dashboard, no commands to memorise.

## How It Works

The tradesperson texts The Foreman like they'd text a colleague:

```
Quote for Mrs Smith, boiler service, £350
Invoice James Kelly for the kitchen refit — labour 800, materials 450
Chase Darren
How much have I made this month?
```

The Foreman generates professional PDF quotes and invoices, tracks jobs and payments, and drafts copy for the tradesperson to forward. Customers never interact with The Foreman directly.

## What It Can Do

- **Quotes** — generates a professional PDF quote from a single message
- **Invoices** — same; line items, VAT, logo, bank details all included
- **Job tracking** — open jobs, quotes out, invoiced, paid, cancelled
- **Payment chasing** — drafts a polite reminder to forward to the customer
- **Earnings reports** — this week, this month, this year, any period
- **Payment stats** — average payment time, quote conversion rate, financial summary
- **Morning briefing** — 8am daily summary of overdue invoices and stale quotes
- **Settings** — business name, trade, logo, bank details, VAT, payment terms

## Setup

### Prerequisites

- Node.js 18+
- PostgreSQL database
- Twilio account with WhatsApp Business sender
- OpenAI API key (for natural language parsing)

### 1. Clone and install

```bash
git clone https://github.com/hellotheforeman/the-foreman.git
cd the-foreman
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```
DATABASE_URL=postgresql://...
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_WHATSAPP_NUMBER=+447XXXXXXXXX
OPENAI_API_KEY=sk-...
```

### 3. Run locally

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

### 4. Expose webhook (development)

```bash
npx ngrok http 3000
```

Set the ngrok URL as your Twilio WhatsApp webhook: `https://your-id.ngrok.io/webhook`

### 5. Deploy

Recommended: **Railway** — connect the repo, add a PostgreSQL plugin, set environment variables, deploy.

## Architecture

```
Tradesperson's WhatsApp → Meta → Twilio → The Foreman (Node.js + PostgreSQL)
```

- Multi-business — each WhatsApp number gets its own isolated business account
- Natural language parsing via regex + GPT-4o-mini fallback
- PDF generation with pdfkit, stored in Supabase Storage
- Twilio for WhatsApp Business API

## Licence

MIT
