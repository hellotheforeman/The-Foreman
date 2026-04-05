const express = require('express');
const path = require('path');
const config = require('./config');
const { parse } = require('./parser');
const { dispatch } = require('./handlers');
const { twimlReply } = require('./messenger');
const scheduler = require('./scheduler');
const db = require('./db');
const conversation = require('./conversation');

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(require('./signup'));
app.use(require('./admin'));

// Health check
app.get('/', (req, res) => {
  res.send('🔨 The Foreman is running.');
});

/**
 * Twilio webhook — receives inbound WhatsApp messages from registered tradespeople.
 *
 * Option 2 design: only registered tradespeople text this number.
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

    const phone = normalisePhone(from);
    const business = await db.findBusinessByPhone(phone);

    if (!business) {
      console.log(`📥 Unknown sender (${phone}) — not registered`);
      const signupMsg = config.signupUrl
        ? `You're not set up on The Foreman yet. Sign up at ${config.signupUrl}`
        : `You're not set up on The Foreman yet. Please contact us to get started.`;
      return twimlReply(res, signupMsg);
    }

    if (business.status === 'suspended') {
      console.log(`📥 Suspended business (${phone}) — rejecting`);
      return twimlReply(res, `Your account has been suspended. Please contact support.`);
    }

    await db.logMessage(business.id, 'IN', 'TRADESPERSON', body, { whatsappMessageId: messageSid });
    const parsed = await parse(body);
    const resolved = await conversation.resolveIntent(parsed, business);

    if (resolved.mode === 'prompt') {
      console.log(`📥 [${business.business_name}] "${body}" → prompt`);
      return twimlReply(res, resolved.message);
    }

    const intent = resolved.intent;
    console.log(`📥 [${business.business_name}] "${body}" → ${intent.intent}`);
    await dispatch(intent, res, business);

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
  await conversation.migrate();
  app.listen(config.port, () => {
    console.log(`🔨 The Foreman running on port ${config.port}`);
    scheduler.start();
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
