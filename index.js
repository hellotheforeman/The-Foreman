const express = require('express');
const config = require('./config');
const { parse } = require('./parser');
const { dispatch } = require('./handlers');
const { logMessage, findBusinessByPhone } = require('./db');
const { twimlReply } = require('./messenger');
const scheduler = require('./scheduler');
const db = require('./db');
const { registerAdminRoutes } = require('./admin');
const { registerSignupRoutes } = require('./signup');

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

registerSignupRoutes(app);
registerAdminRoutes(app);

// Health check
app.get('/', (req, res) => {
  res.send('🔨 The Foreman is running.');
});

/**
 * Twilio webhook — receives inbound WhatsApp messages from the tradesperson.
 *
 * Option 2 design: only the tradesperson texts this number.
 * The bot never messages customers — it drafts messages for the
 * tradesperson to copy and send from their own WhatsApp.
 */
app.post('/webhook', async (req, res) => {
  try {
    const from = (req.body.From || '').replace('whatsapp:', '');
    const body = (req.body.Body || '').trim();
    const messageSid = req.body.MessageSid || null;

    if (!from || !body) {
      return res.status(400).send('Missing From or Body');
    }

    const isForeman = normalisePhone(from) === normalisePhone(config.foremanPhone);

    if (!isForeman) {
      // Unknown sender — ignore silently (no customer-facing messages)
      console.log(`📥 Unknown sender (${from}) — ignoring`);
      return res.sendStatus(200);
    }

    const business = await findBusinessByPhone(normalisePhone(from));
    await logMessage('IN', 'TRADESPERSON', body, { businessId: business?.id, whatsappMessageId: messageSid });
    const intent = parse(body);
    if (business) intent.business = business;
    console.log(`📥 Foreman: "${body}" → ${intent.intent}`);
    await dispatch(intent, res);

  } catch (err) {
    console.error('Webhook error:', err);
    if (!res.headersSent) {
      twimlReply(res, `Something went wrong. Please try again.`);
    }
  }
});

// Twilio status callback
app.post('/status', (req, res) => {
  const { MessageSid, MessageStatus } = req.body;
  console.log(`📊 Status: ${MessageSid} → ${MessageStatus}`);
  res.sendStatus(200);
});

function normalisePhone(phone) {
  let p = phone.replace(/\s+/g, '').replace('whatsapp:', '');
  if (p.startsWith('0')) p = '+44' + p.slice(1);
  else if (p.startsWith('44') && !p.startsWith('+')) p = '+' + p;
  return p;
}

async function start() {
  await db.init();
  app.listen(config.port, () => {
    console.log(`🔨 The Foreman running on port ${config.port}`);
    scheduler.start();
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
