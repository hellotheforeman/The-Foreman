const express = require('express');
const config = require('./config');
const { parse, parseLineItems } = require('./parser');
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

    // --- Quote guided workflow ---
    // Triggered when: "quote 14" — job ID known but no amount/items provided.
    // Guides the user through quick vs itemised, then dispatches to handleQuote.
    if (!currentState && intent.intent === 'quote' && intent.jobId && intent.amount == null) {
      const job = await db.getJobWithCustomer(intent.jobId, business.id);
      if (!job) return twimlReply(res, `❌ Job ${db.formatJobId(intent.jobId)} not found.`);

      await setConversationState(business.id, {
        workflow: 'quote_guided',
        focus: { jobId: job.id },
        collected: { jobId: job.id },
        pending: { type: 'choice', field: 'quote_type' },
        options: [],
      });
      return twimlReply(res,
        `📋 *${job.description}* — ${job.customer.name}\n\n` +
        `How do you want to quote this?\n\n` +
        `1. Quick — one price\n` +
        `2. Itemised — list of line items\n\n` +
        `Reply *1* or *2*, or *cancel* to dismiss.`
      );
    }

    if (currentState?.workflow === 'quote_guided') {
      const trimmed = body.trim();

      if (/^(cancel|no|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'Quote cancelled.');
      }

      if (currentState.pending?.field === 'quote_type') {
        const n = parseInt(trimmed, 10);
        if (n !== 1 && n !== 2) {
          return twimlReply(res, 'Reply *1* for a quick quote or *2* for itemised, or *cancel* to dismiss.');
        }
        if (n === 1) {
          await setConversationState(business.id, {
            ...currentState,
            collected: { ...currentState.collected, quote_type: 'quick' },
            pending: { type: 'field', field: 'amount' },
          });
          return twimlReply(res, 'What price should I use?');
        } else {
          await setConversationState(business.id, {
            ...currentState,
            collected: { ...currentState.collected, quote_type: 'itemised' },
            pending: { type: 'field', field: 'items' },
          });
          return twimlReply(res, 'List your items:\n\n*Boiler service 250 | Parts 45 | Callout fee 50*\n\nFormat: description amount, separated by |');
        }
      }

      if (currentState.pending?.field === 'amount') {
        const m = trimmed.match(/^£?(\d+(?:\.\d{1,2})?)\s*$/);
        if (!m) return twimlReply(res, 'Please enter a number, e.g. *450*');
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'quote', jobId: currentState.collected.jobId, amount: parseFloat(m[1]), items: null, lineItems: null, business }, res);
      }

      if (currentState.pending?.field === 'items') {
        const lineItems = parseLineItems(trimmed);
        if (!lineItems) {
          return twimlReply(res, "I couldn't parse those items. Try:\n*Boiler service 250 | Parts 45*\n\nEach item needs a description and an amount.");
        }
        const amount = lineItems.reduce((sum, i) => sum + i.amount, 0);
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'quote', jobId: currentState.collected.jobId, amount, items: trimmed, lineItems, business }, res);
      }

      await clearConversationState(business.id);
      return twimlReply(res, 'Quote cancelled. Start again with *quote [job#]*.');
    }
    // --- End quote guided workflow ---

    // --- Invoice guided workflow ---
    // Triggered when: "invoice 14" — no amount provided.
    // Checks for existing quote and guides accordingly.
    if (!currentState && intent.intent === 'send_invoice' && intent.amount == null) {
      const job = await db.getJobWithCustomer(intent.jobId, business.id);
      if (!job) return twimlReply(res, `❌ Job ${db.formatJobId(intent.jobId)} not found.`);

      // If invoice already exists, just resend it — no need to guide
      const existingInvoice = await db.getInvoiceByJob(job.id, business.id);
      if (existingInvoice) {
        return dispatch({ ...intent, business }, res);
      }

      if (job.quoted_amount) {
        const quotedStr = `£${Number(job.quoted_amount).toFixed(2)}`;
        await setConversationState(business.id, {
          workflow: 'invoice_guided',
          focus: { jobId: job.id },
          collected: { jobId: job.id, quoted_amount: Number(job.quoted_amount) },
          pending: { type: 'choice', field: 'invoice_mode' },
          options: [],
        });
        return twimlReply(res,
          `🧾 *${job.description}* — ${job.customer.name}\n\n` +
          `There's a quote for *${quotedStr}*. What would you like to do?\n\n` +
          `1. Invoice from quote (${quotedStr})\n` +
          `2. Amend before invoicing\n` +
          `3. Create manually\n\n` +
          `Reply *1*, *2*, or *3*, or *cancel* to dismiss.`
        );
      } else {
        await setConversationState(business.id, {
          workflow: 'invoice_guided',
          focus: { jobId: job.id },
          collected: { jobId: job.id },
          pending: { type: 'choice', field: 'invoice_mode_new' },
          options: [],
        });
        return twimlReply(res,
          `🧾 *${job.description}* — ${job.customer.name}\n\n` +
          `No quote on file. How would you like to invoice?\n\n` +
          `1. Quick — one amount\n` +
          `2. Itemised — list of line items\n\n` +
          `Reply *1* or *2*, or *cancel* to dismiss.`
        );
      }
    }

    if (currentState?.workflow === 'invoice_guided') {
      const trimmed = body.trim();

      if (/^(cancel|no|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'Invoice flow cancelled.');
      }

      // Has a quote — mode selection
      if (currentState.pending?.field === 'invoice_mode') {
        const n = parseInt(trimmed, 10);
        if (!n || n < 1 || n > 3) {
          return twimlReply(res, 'Reply *1*, *2*, or *3*, or *cancel* to dismiss.');
        }
        if (n === 1) {
          // Use quote as-is — handleSendInvoice will pick up the quoted amount
          await clearConversationState(business.id);
          return dispatch({ kind: 'command', intent: 'send_invoice', jobId: currentState.focus.jobId, business }, res);
        }
        if (n === 2) {
          await setConversationState(business.id, {
            ...currentState,
            pending: { type: 'field', field: 'amend_items' },
          });
          const quotedStr = `£${Number(currentState.collected.quoted_amount).toFixed(2)}`;
          return twimlReply(res, `What should the invoice show instead?\n\n*Boiler service 280 | Parts 55*\nor just *480*\n\n(Quote was ${quotedStr})`);
        }
        if (n === 3) {
          await setConversationState(business.id, {
            ...currentState,
            pending: { type: 'field', field: 'manual_amount' },
          });
          return twimlReply(res, 'What amount?\n\n(Or list items: *service 250 | parts 45*)');
        }
      }

      // No quote — mode selection
      if (currentState.pending?.field === 'invoice_mode_new') {
        const n = parseInt(trimmed, 10);
        if (n !== 1 && n !== 2) {
          return twimlReply(res, 'Reply *1* for quick or *2* for itemised, or *cancel* to dismiss.');
        }
        if (n === 1) {
          await setConversationState(business.id, {
            ...currentState,
            pending: { type: 'field', field: 'manual_amount' },
          });
          return twimlReply(res, 'What amount?');
        } else {
          await setConversationState(business.id, {
            ...currentState,
            pending: { type: 'field', field: 'items' },
          });
          return twimlReply(res, 'List your items:\n\n*Boiler service 250 | Parts 45 | Callout fee 50*');
        }
      }

      // Collect amount for amend or manual (accepts single amount or line items)
      if (currentState.pending?.field === 'amend_items' || currentState.pending?.field === 'manual_amount') {
        const lineItems = parseLineItems(trimmed);
        if (lineItems) {
          const amount = lineItems.reduce((sum, i) => sum + i.amount, 0);
          await clearConversationState(business.id);
          return dispatch({ kind: 'command', intent: 'send_invoice', jobId: currentState.focus.jobId, amount, items: trimmed, lineItems, business }, res);
        }
        const m = trimmed.match(/^£?(\d+(?:\.\d{1,2})?)\s*(.*)$/);
        if (!m) return twimlReply(res, 'Please enter an amount, e.g. *450*, or items: *service 250 | parts 45*');
        const amount = parseFloat(m[1]);
        const desc = m[2].trim() || null;
        const li = desc ? [{ description: desc, amount }] : null;
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'send_invoice', jobId: currentState.focus.jobId, amount, items: desc, lineItems: li, business }, res);
      }

      // Collect itemised line items
      if (currentState.pending?.field === 'items') {
        const lineItems = parseLineItems(trimmed);
        if (!lineItems) {
          return twimlReply(res, "I couldn't parse those items. Try:\n*Boiler service 250 | Parts 45*\n\nEach item needs a description and an amount.");
        }
        const amount = lineItems.reduce((sum, i) => sum + i.amount, 0);
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'send_invoice', jobId: currentState.focus.jobId, amount, items: trimmed, lineItems, business }, res);
      }

      await clearConversationState(business.id);
      return twimlReply(res, 'Invoice flow cancelled. Start again with *invoice [job#]*.');
    }
    // --- End invoice guided workflow ---

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
