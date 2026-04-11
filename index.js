const express = require('express');
const config = require('./config');
const { parse } = require('./parser');
const { dispatch, SETTINGS_FIELDS, buildSettingsMenu } = require('./handlers');
const { logMessage, findBusinessByPhone } = require('./db');
const { twimlReply } = require('./messenger');
const scheduler = require('./scheduler');
const db = require('./db');
const { registerAdminRoutes } = require('./admin');
const { registerSignupRoutes } = require('./signup');
const workflowEngine = require('./workflow-engine');
const { getConversationState, setConversationState, clearConversationState } = require('./conversation-state');

const path = require('path');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/pdfs', express.static(path.join(__dirname, 'public', 'pdfs')));

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

    const normPhone = normalisePhone(from);
    const business = await findBusinessByPhone(normPhone);

    if (!business) {
      console.log(`📥 Unregistered sender (${from}) — sending sign-up message`);
      await logMessage('IN', 'TRADESPERSON', body, { whatsappMessageId: messageSid });
      return twimlReply(res, `Your number isn't registered with The Foreman yet.\n\nVisit theforeman.co.uk/signup to get started.`);
    }

    await logMessage('IN', 'TRADESPERSON', body, { businessId: business.id, whatsappMessageId: messageSid });

    if (business.status !== 'active') {
      console.log(`📥 ${from} — account ${business.status}, blocking`);
      return twimlReply(res, `Your Foreman account is ${business.status}. We'll be in touch once it's active.`);
    }

    const intent = parse(body);
    intent.business = business;
    console.log(`📥 ${business.name}: "${body}" → ${intent.intent}`);

    const currentState = await getConversationState(business.id);

    // --- Settings workflow (menu-driven, handled outside the generic workflow engine) ---
    if (intent.intent === 'settings') {
      await setConversationState(business.id, {
        workflow: 'settings',
        focus: {},
        collected: {},
        pending: { type: 'field', field: 'choose' },
        options: [],
      });
      return twimlReply(res, buildSettingsMenu(business));
    }

    if (currentState?.workflow === 'settings') {
      const trimmed = body.trim();

      // Allow cancelling out of settings
      if (/^(cancel|no|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'Settings closed.');
      }

      if (currentState.pending?.field === 'choose') {
        const n = parseInt(trimmed, 10);
        if (!n || n < 1 || n > SETTINGS_FIELDS.length) {
          return twimlReply(res, `Please reply with a number 1–${SETTINGS_FIELDS.length}, or *cancel*.`);
        }
        const setting = SETTINGS_FIELDS[n - 1];
        await setConversationState(business.id, {
          workflow: 'settings',
          focus: {},
          collected: { settingKey: setting.key, settingLabel: setting.label },
          pending: { type: 'field', field: 'value' },
          options: [],
        });
        return twimlReply(res, `What should I change *${setting.label}* to?\n\n(Reply *cancel* to go back)`);
      }

      if (currentState.pending?.field === 'value') {
        const { settingKey, settingLabel } = currentState.collected || {};
        if (settingKey) {
          await db.updateBusiness(business.id, { [settingKey]: trimmed });
          await clearConversationState(business.id);
          return twimlReply(res, `✅ *${settingLabel}* updated to: ${trimmed}`);
        }
      }

      // Fallback — show menu again
      return twimlReply(res, buildSettingsMenu(business));
    }
    // --- End settings workflow ---

    const workflowResult = await workflowEngine.handleMessage({
      business,
      raw: body,
      parsedIntent: intent,
      currentState,
    });

    if (workflowResult?.type === 'prompt') {
      await setConversationState(business.id, workflowResult.state);
      return twimlReply(res, workflowResult.message);
    }

    if (workflowResult?.type === 'cancel') {
      await clearConversationState(business.id);
      return twimlReply(res, workflowResult.message);
    }

    if (workflowResult?.type === 'action') {
      if (workflowResult.clearState === false) {
        // leave existing state for out-of-band help/query handling
      } else if (workflowResult.state) {
        await setConversationState(business.id, workflowResult.state);
      } else {
        await clearConversationState(business.id);
      }

      const nextIntent = { ...workflowResult.intent, business };
      return dispatch(nextIntent, res);
    }

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
