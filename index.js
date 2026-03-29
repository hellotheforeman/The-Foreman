const express = require('express');
const config = require('./config');
const { parse } = require('./parser');
const { dispatch } = require('./handlers');
const { logMessage } = require('./db');
const { twimlReply } = require('./messenger');
const scheduler = require('./scheduler');
const db = require('./db');

const app = express();

// Twilio sends form-encoded bodies
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.send('🔨 The Foreman is running.');
});

// Twilio webhook — receives all inbound WhatsApp messages
app.post('/webhook', async (req, res) => {
  try {
    const from = (req.body.From || '').replace('whatsapp:', '');
    const body = req.body.Body || '';
    const messageSid = req.body.MessageSid || null;

    if (!from || !body) {
      return res.status(400).send('Missing From or Body');
    }

    const isForeman = normalisePhone(from) === normalisePhone(config.foremanPhone);

    if (isForeman) {
      // Tradesperson command
      logMessage('IN', 'TRADESPERSON', body, { whatsappMessageId: messageSid });
      const intent = parse(body);
      console.log(`📥 Foreman: "${body}" → ${intent.intent}`);
      await dispatch(intent, res);
    } else {
      // Customer message — log it and notify tradesperson
      logMessage('IN', 'CUSTOMER', body, { whatsappMessageId: messageSid });
      console.log(`📥 Customer (${from}): "${body}"`);

      // Notify the tradesperson
      const { sendToForeman } = require('./messenger');
      await sendToForeman(
        `📩 Message from ${from}:\n\n"${body}"\n\nReply directly from your phone or use *find* to look them up.`
      );

      // Auto-acknowledge to customer
      twimlReply(res, `Thanks for your message! We'll get back to you shortly. 👍`);
    }
  } catch (err) {
    console.error('Webhook error:', err);
    if (!res.headersSent) {
      twimlReply(res, `Something went wrong. Please try again.`);
    }
  }
});

// Twilio status callback (optional)
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

// Start — init DB first, then listen
async function start() {
  await db.init();
  app.listen(config.port, () => {
    console.log(`🔨 The Foreman is running on port ${config.port}`);
    scheduler.start();
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
