# 🔨 The Foreman

A WhatsApp-based business assistant for UK tradespeople. Manage quotes, jobs, scheduling, invoicing, and customer follow-ups — all through WhatsApp.

No app to learn. No dashboard. Just text.

## How It Works

The tradesperson texts The Foreman like they'd text a colleague:

```
new job Mrs Patel 07700900123 boiler service BD7 1AH
quote 1 85 for boiler service
schedule 1 thursday 9am
done 1 service plus replaced valve total 140
paid 1
```

The Foreman drafts professional quotes, invoices, confirmations, and follow-ups — and sends them back to the tradesperson, **ready to copy and paste** into their own WhatsApp conversation with the customer.

This means:
- **No WhatsApp Business API number per customer** — one Twilio number serves the whole platform
- **No messages sent to customers without the tradesperson seeing them first**
- **Works from the tradesperson's existing personal WhatsApp** — no new number for customers to deal with

## Commands

| Command | Example |
|---|---|
| **new job** [name] [phone] [description] [postcode] | `new job Mrs Patel 07700900123 boiler service BD7 1AH` |
| **quote** [job#] [amount] [description] | `quote 1 85 for boiler service` |
| **schedule** [job#] [day] [time] | `schedule 1 thursday 9am` |
| **done** [job#] [notes] total [amount] | `done 1 service plus valve total 140` |
| **invoice** [job#] | `invoice 1` |
| **paid** [job#] | `paid 1` |
| **chase** [job#] | `chase 1` |
| **follow up** [job#] | `follow up 1` |
| **today** / **tomorrow** / **this week** | `tomorrow` |
| **unpaid** | `unpaid` |
| **jobs** | `jobs` |
| **find** [name] | `find patel` |
| **help** | `help` |

## Setup

### Prerequisites

- Node.js 18+
- A Twilio account with WhatsApp Business sender
- A UK phone number for WhatsApp Business

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

Edit `.env` with your details:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_WHATSAPP_NUMBER=+447XXXXXXXXX
FOREMAN_PHONE=+447XXXXXXXXX
BUSINESS_NAME=Dave's Plumbing
BUSINESS_PAYMENT_DETAILS=Bank transfer: Sort 12-34-56, Acc 12345678 (D Smith)
```

- `TWILIO_WHATSAPP_NUMBER` — the number registered with Twilio for WhatsApp Business
- `FOREMAN_PHONE` — the tradesperson's personal WhatsApp number (commands come from here)

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

Set the ngrok URL as your Twilio WhatsApp webhook:
`https://your-id.ngrok.io/webhook`

### 5. Deploy

Works on any Node.js host. Recommended for persistence:

- **Railway** — `railway up`
- **Fly.io** — `fly launch`
- **Any VPS** — Hetzner, DigitalOcean, Oracle free tier

Set environment variables on your host and point Twilio's webhook to your deployed URL.

## Architecture

```
Tradesperson's WhatsApp ──→ Meta ──→ Twilio ──→ The Foreman (Node.js + SQLite)
                                                       │
Customer's WhatsApp    ←── Meta ←── Twilio ←───────────┘
```

- **SQLite** database (no external DB needed)
- **Twilio** as WhatsApp Business API provider
- **node-cron** for scheduled reminders

## Automated Reminders

- **7pm daily** — tomorrow's schedule
- **8am Monday** — weekly summary (jobs, unpaid invoices, pending quotes)
- **10am daily** — overdue invoice alerts (7+ days)

All customer-facing messages require tradesperson approval before sending.

## Licence

MIT
