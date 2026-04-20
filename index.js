const express = require('express');
const config = require('./config');
const { parse, parseLineItems } = require('./parser');
const { dispatch, SETTINGS_FIELDS, buildSettingsMenu } = require('./handlers');
const { logMessage, findBusinessByPhone } = require('./db');
const { twimlReply, twimlReplyPair } = require('./messenger');
const scheduler = require('./scheduler');
const db = require('./db');
const { registerAdminRoutes } = require('./admin');
const { registerSignupRoutes } = require('./signup');
const workflowEngine = require('./workflow-engine');
const templates = require('./templates');
const { getConversationState, setConversationState, clearConversationState } = require('./conversation-state');
const { parseWithAI } = require('./ai-parser');

const twilio = require('twilio');
const https = require('https');
const { uploadLogo } = require('./storage');
const app = express();

// Trust proxy headers so Express reconstructs the correct HTTPS URL behind
// Railway / Heroku / Render — required for Twilio signature validation to work.
app.enable('trust proxy');

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Downloads a Twilio media URL to a Buffer, following redirects.
// Only sends Twilio Basic auth on twilio.com domains.
function downloadToBuffer(mediaUrl) {
  return new Promise((resolve, reject) => {
    function doRequest(urlStr) {
      const url = new URL(urlStr);
      const options = { hostname: url.hostname, path: url.pathname + url.search };
      if (url.hostname.includes('twilio.com')) {
        options.auth = `${config.twilio.accountSid}:${config.twilio.authToken}`;
      }
      https.get(options, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          return doRequest(response.headers.location);
        }
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }).on('error', reject);
    }
    doRequest(mediaUrl);
  });
}

function detectImageExt(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'jpg';
  return null;
}

// Twilio webhook signature validation middleware.
// Skipped automatically in local dev (localhost) so manual testing still works.
const isLocalDev = config.publicUrl.includes('localhost');
const validateTwilioSignature = config.twilio.authToken && !isLocalDev
  ? twilio.webhook(config.twilio.authToken, { url: config.publicUrl + '/webhook' })
  : (req, res, next) => {
      if (!isLocalDev) console.warn('⚠️  Twilio signature validation skipped — TWILIO_AUTH_TOKEN not set');
      next();
    };

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
app.post('/webhook', validateTwilioSignature, async (req, res) => {
  try {
    const from = (req.body.From || '').replace('whatsapp:', '');
    const body = (req.body.Body || '').trim();
    const messageSid = req.body.MessageSid || null;
    const numMedia = parseInt(req.body.NumMedia || '0', 10);
    const mediaUrl = numMedia > 0 ? (req.body.MediaUrl0 || null) : null;
    const mediaContentType = numMedia > 0 ? (req.body.MediaContentType0 || '') : '';

    if (!from || (!body && !mediaUrl)) {
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

    // Fetch conversation state before parsing so we can skip the AI parser when
    // mid-workflow — structured replies (numbers, amounts) must not be misread as commands.
    let currentState = await getConversationState(business.id);

    let intent = parse(body);
    if (intent.intent === 'unknown' && !currentState) {
      const aiIntent = await parseWithAI(body);
      if (aiIntent) intent = aiIntent;
    }
    intent.business = business;
    console.log(`📥 ${business.business_name || business.name}: "${body}" → ${intent.intent}`);

    // Checks for booking overlaps before dispatching schedule/reschedule/add_block.
    // Sets overlap_confirm state and warns if clashes found; otherwise dispatches normally.
    async function scheduleOrDispatch(finalIntent) {
      const isScheduling = ['schedule', 'reschedule', 'add_block'].includes(finalIntent.intent);
      if (!isScheduling || !finalIntent.date) return dispatch(finalIntent, res);

      const endDate = (finalIntent.durationUnit === 'days' && finalIntent.duration > 1)
        ? db.addWorkingDays(finalIntent.date, finalIntent.duration)
        : finalIntent.date;

      const overlaps = await db.getBookingOverlaps(business.id, finalIntent.date, endDate, finalIntent.jobId);
      if (!overlaps.length) {
        // No clash — proceed and set add_block follow-up context as before
        if (['schedule', 'add_block'].includes(finalIntent.intent) && finalIntent.jobId) {
          await setConversationState(business.id, {
            workflow: 'add_block',
            focus: { jobId: finalIntent.jobId },
            collected: { jobId: finalIntent.jobId },
            pending: null,
            options: [],
          });
        }
        return dispatch(finalIntent, res);
      }

      // Clash found — store pending action and warn
      const { business: _b, ...intentWithoutBusiness } = finalIntent;
      await setConversationState(business.id, {
        workflow: 'overlap_confirm',
        focus: { jobId: finalIntent.jobId },
        collected: { pendingIntent: intentWithoutBusiness, overlaps },
        pending: { type: 'choice', field: 'confirm' },
        options: [],
      });
      return twimlReply(res, buildOverlapWarning(overlaps));
    }

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
      if (/^(cancel|back|exit|quit)$/i.test(trimmed)) {
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
          collected: { settingKey: setting.key, settingLabel: setting.label, settingType: setting.type || 'text' },
          pending: { type: 'field', field: 'value' },
          options: [],
        });
        if (setting.type === 'vat') {
          return twimlReply(res, `Are you VAT registered?\n\nReply *yes* or *no*. (Reply *cancel* to go back)`);
        }
        const hint = setting.hint || '(Reply *cancel* to go back)';
        return twimlReply(res, `What should I change *${setting.label}* to?\n\n${hint}`);
      }

      if (currentState.pending?.field === 'value') {
        const { settingKey, settingLabel, settingType } = currentState.collected || {};
        if (settingKey) {
          if (settingType === 'image') {
            if (!mediaUrl) {
              return twimlReply(res, `Please send your logo as a photo or image. (Reply *cancel* to go back)`);
            }
            try {
              const buffer = await downloadToBuffer(mediaUrl);
              const ext = detectImageExt(buffer);
              if (!ext) {
                return twimlReply(res, `❌ That file type isn't supported. Please send a photo or image.`);
              }
              const logoUrl = await uploadLogo(business.id, buffer, ext);
              await db.updateBusiness(business.id, { logo_path: logoUrl });
              await clearConversationState(business.id);
              return twimlReply(res, `✅ Logo saved — it'll appear on all your quotes and invoices.`);
            } catch (err) {
              console.error('Logo upload failed:', err);
              return twimlReply(res, `❌ Couldn't save that image. Please try again.`);
            }
          }

          if (settingType === 'vat') {
            const isYes = /^(yes|y|yep|yeah)$/i.test(trimmed);
            const isNo = /^(no|n|nope|nah)$/i.test(trimmed);
            if (!isYes && !isNo) {
              return twimlReply(res, `Reply *yes* if you're VAT registered, or *no* if not.`);
            }
            if (isNo) {
              await db.updateBusiness(business.id, { vat_registered: false, vat_number: null });
              await clearConversationState(business.id);
              return twimlReply(res, `✅ VAT updated — not registered.`);
            }
            // Yes — ask for the number
            await db.updateBusiness(business.id, { vat_registered: true });
            await setConversationState(business.id, {
              ...currentState,
              pending: { type: 'field', field: 'vat_number' },
            });
            return twimlReply(res, `What's your VAT number?`);
          }

          const isBoolean = settingType === 'boolean';
          const value = isBoolean ? /^(yes|y|true|1)$/i.test(trimmed) : trimmed;
          const displayValue = isBoolean ? (value ? 'Yes' : 'No') : trimmed;
          await db.updateBusiness(business.id, { [settingKey]: value });
          await clearConversationState(business.id);
          return twimlReply(res, `✅ *${settingLabel}* updated to: ${displayValue}`);
        }
      }

      if (currentState.pending?.field === 'vat_number') {
        await db.updateBusiness(business.id, { vat_number: trimmed });
        await clearConversationState(business.id);
        return twimlReply(res, `✅ VAT updated — registered, ${trimmed}.`);
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
      if (!job) return twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);

      if (job.quoted_amount) {
        const quotedStr = `£${Number(job.quoted_amount).toFixed(2)}`;
        await setConversationState(business.id, {
          workflow: 'quote_guided',
          focus: { jobId: job.id },
          collected: {
            jobId: job.id,
            quoted_amount: Number(job.quoted_amount),
            quote_items: job.quote_items || null,
            quote_line_items_json: job.quote_line_items_json || null,
          },
          pending: { type: 'choice', field: 'quote_mode' },
          options: [],
        });
        return twimlReply(res,
          `📋 *${job.description}* — ${job.customer.name}\n\n` +
          `There's already a quote for *${quotedStr}*. What would you like to do?\n\n` +
          `1. Resend existing quote\n` +
          `2. Amend the quote\n` +
          `3. Start from scratch\n\n` +
          `Reply *1*, *2*, or *3*, or *cancel* to dismiss.`
        );
      }

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
        `2. Detailed — break it down (e.g. labour 250, parts 100)\n\n` +
        `Reply *1* or *2*, or *cancel* to dismiss.`
      );
    }

    if (currentState?.workflow === 'quote_guided') {
      const trimmed = body.trim();

      if (/^(cancel|no|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'Quote cancelled.');
      }

      if (isWorkflowInterrupt(intent)) {
        await clearConversationState(business.id);
        return dispatch({ ...intent, business }, res);
      }

      if (currentState.pending?.field === 'quote_mode') {
        const n = parseInt(trimmed, 10);
        if (!n || n < 1 || n > 3) {
          return twimlReply(res, 'Reply *1*, *2*, or *3*, or *cancel* to dismiss.');
        }
        if (n === 1) {
          // Resend existing quote as-is
          await clearConversationState(business.id);
          return dispatch({
            kind: 'command', intent: 'quote',
            jobId: currentState.focus.jobId,
            amount: currentState.collected.quoted_amount,
            items: currentState.collected.quote_items || null,
            lineItems: currentState.collected.quote_line_items_json || null,
            business,
          }, res);
        }
        if (n === 2) {
          // Amend — show existing items for easy editing
          const currentItemsStr = formatItemsForCopy(
            currentState.collected.quote_line_items_json,
            currentState.collected.quote_items,
            currentState.collected.quoted_amount
          );
          await setConversationState(business.id, {
            ...currentState,
            pending: { type: 'field', field: 'amend_items' },
          });
          return twimlReplyPair(
            res,
            `What should the quote show instead? Currently:`,
            currentItemsStr
          );
        }
        // Option 3 — start fresh
        await setConversationState(business.id, {
          ...currentState,
          collected: { jobId: currentState.focus.jobId },
          pending: { type: 'choice', field: 'quote_type' },
        });
        return twimlReply(res,
          `How do you want to quote this?\n\n` +
          `1. Quick — one price\n` +
          `2. Detailed — break it down (e.g. labour 250, parts 100)\n\n` +
          `Reply *1* or *2*, or *cancel* to dismiss.`
        );
      }

      if (currentState.pending?.field === 'amend_items') {
        let lineItems = parseLineItems(trimmed);
        if (lineItems && lineItems.length === 1 && /^total$/i.test(lineItems[0].description)) {
          lineItems = null; // "Total £480" copy-back — treat as plain amount
        }
        if (lineItems) {
          const amount = lineItems.reduce((sum, i) => sum + i.amount, 0);
          await clearConversationState(business.id);
          return dispatch({ kind: 'command', intent: 'quote', jobId: currentState.focus.jobId, amount, items: trimmed, lineItems, business }, res);
        }
        const m = trimmed.match(/^£?(\d+(?:\.\d{1,2})?)\s*$/);
        if (!m) {
          // Try stripping a leading "Total" label: "Total £480" or "Total 480"
          const totalM = trimmed.match(/^total\s+£?(\d+(?:\.\d{1,2})?)\s*$/i);
          if (totalM) {
            await clearConversationState(business.id);
            return dispatch({ kind: 'command', intent: 'quote', jobId: currentState.focus.jobId, amount: parseFloat(totalM[1]), items: null, lineItems: null, business }, res);
          }
          return twimlReply(res, 'Please enter an amount, e.g. *450*, or items: *service 250, parts 45*');
        }
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'quote', jobId: currentState.focus.jobId, amount: parseFloat(m[1]), items: null, lineItems: null, business }, res);
      }

      if (currentState.pending?.field === 'quote_type') {
        const n = parseInt(trimmed, 10);
        if (n !== 1 && n !== 2) {
          return twimlReply(res, 'Reply *1* for a quick quote or *2* for a detailed breakdown, or *cancel* to dismiss.');
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
          return twimlReply(res, 'List your items:\n\n*Boiler service 250, Parts 45, Callout fee 50*\n\nSeparate each item with a comma.');
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
          return twimlReply(res, "I couldn't parse those items. Try:\n*Boiler service 250, Parts 45*\n\nEach item needs a description and an amount.");
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
      if (!job) return twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);

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
          collected: {
            jobId: job.id,
            quoted_amount: Number(job.quoted_amount),
            quote_items: job.quote_items || null,
            quote_line_items_json: job.quote_line_items_json || null,
          },
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
          `2. Detailed — break it down (e.g. labour 250, parts 100)\n\n` +
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

      if (isWorkflowInterrupt(intent)) {
        await clearConversationState(business.id);
        return dispatch({ ...intent, business }, res);
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
          const currentItemsStr = formatItemsForCopy(
            currentState.collected.quote_line_items_json,
            currentState.collected.quote_items,
            currentState.collected.quoted_amount
          );
          return twimlReplyPair(
            res,
            `What should the invoice show instead? Currently:`,
            currentItemsStr
          );
        }
        if (n === 3) {
          await setConversationState(business.id, {
            ...currentState,
            pending: { type: 'field', field: 'manual_amount' },
          });
          return twimlReply(res, 'What amount?\n\n(Or list items: *service 250, parts 45*)');
        }
      }

      // No quote — mode selection
      if (currentState.pending?.field === 'invoice_mode_new') {
        const n = parseInt(trimmed, 10);
        if (n !== 1 && n !== 2) {
          return twimlReply(res, 'Reply *1* for quick or *2* for a detailed breakdown, or *cancel* to dismiss.');
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
          return twimlReply(res, 'List your items:\n\n*Boiler service 250, Parts 45, Callout fee 50*');
        }
      }

      // Collect amount for amend or manual (accepts single amount or line items)
      if (currentState.pending?.field === 'amend_items' || currentState.pending?.field === 'manual_amount') {
        let lineItems = parseLineItems(trimmed);
        if (lineItems && lineItems.length === 1 && /^total$/i.test(lineItems[0].description)) {
          lineItems = null; // "Total £480" copy-back — treat as plain amount
        }
        if (lineItems) {
          const amount = lineItems.reduce((sum, i) => sum + i.amount, 0);
          await clearConversationState(business.id);
          return dispatch({ kind: 'command', intent: 'send_invoice', jobId: currentState.focus.jobId, amount, items: trimmed, lineItems, business }, res);
        }
        const m = trimmed.match(/^£?(\d+(?:\.\d{1,2})?)\s*$/);
        if (!m) {
          const totalM = trimmed.match(/^total\s+£?(\d+(?:\.\d{1,2})?)\s*$/i);
          if (totalM) {
            await clearConversationState(business.id);
            return dispatch({ kind: 'command', intent: 'send_invoice', jobId: currentState.focus.jobId, amount: parseFloat(totalM[1]), items: null, lineItems: null, business }, res);
          }
          return twimlReply(res, 'Please enter an amount, e.g. *450*, or items: *service 250, parts 45*');
        }
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'send_invoice', jobId: currentState.focus.jobId, amount: parseFloat(m[1]), items: null, lineItems: null, business }, res);
      }

      // Collect itemised line items
      if (currentState.pending?.field === 'items') {
        const lineItems = parseLineItems(trimmed);
        if (!lineItems) {
          return twimlReply(res, "I couldn't parse those items. Try:\n*Boiler service 250, Parts 45*\n\nEach item needs a description and an amount.");
        }
        const amount = lineItems.reduce((sum, i) => sum + i.amount, 0);
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'send_invoice', jobId: currentState.focus.jobId, amount, items: trimmed, lineItems, business }, res);
      }

      await clearConversationState(business.id);
      return twimlReply(res, 'Invoice flow cancelled. Start again with *invoice [job#]*.');
    }
    // --- End invoice guided workflow ---

    // --- Overlap confirmation ---
    // Entered when a scheduling action was blocked pending the tradesperson's confirmation.
    if (currentState?.workflow === 'overlap_confirm') {
      const trimmed = body.trim();
      const pendingIntent = currentState.collected?.pendingIntent;
      const overlaps = currentState.collected?.overlaps || [];

      if (/^(no|nope|cancel|forget it|never mind)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'Got it — not booked.');
      }

      if (/^(yes|yeah|yep|go ahead|do it|book it|book it in|ok|okay|sure|confirm|proceed)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        // Restore add_block follow-up context so "and then X" still works
        if (['schedule', 'reschedule', 'add_block'].includes(pendingIntent?.intent) && pendingIntent?.jobId) {
          await setConversationState(business.id, {
            workflow: 'add_block',
            focus: { jobId: pendingIntent.jobId },
            collected: { jobId: pendingIntent.jobId },
            pending: null,
            options: [],
          });
        }
        return dispatch({ ...pendingIntent, business }, res);
      }

      if (intent.kind === 'query') {
        // Show whatever they asked for, but keep the pending confirmation alive
        return dispatch({ ...intent, business }, res);
      }

      // Any other command: clear pending and re-process as a new intent
      await clearConversationState(business.id);
      currentState = null;
    }
    // --- End overlap confirmation ---

    // Inject jobId from follow-up context for add_block when user sent "and then X"
    // after a successful schedule/add_block action
    let resolvedIntent = intent;
    if (
      intent.intent === 'add_block' &&
      !intent.jobId &&
      currentState?.workflow === 'add_block' &&
      currentState.focus?.jobId
    ) {
      resolvedIntent = { ...intent, jobId: currentState.focus.jobId };
    }

    const workflowResult = await workflowEngine.handleMessage({
      business,
      raw: body,
      parsedIntent: resolvedIntent,
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
      const completedIntent = workflowResult.intent;

      if (workflowResult.clearState === false) {
        // leave existing state for out-of-band help/query handling
      } else if (workflowResult.state) {
        await setConversationState(business.id, workflowResult.state);
      } else {
        await clearConversationState(business.id);
      }

      const nextIntent = { ...completedIntent, business };
      return scheduleOrDispatch(nextIntent);
    }

    await scheduleOrDispatch(intent);

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

function toTitleCase(str) {
  return str.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function formatItemsForCopy(lineItemsJson, quoteItems, quotedAmount) {
  let items = lineItemsJson;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { items = null; }
  }
  if (Array.isArray(items) && items.length) {
    return items.map((i) => `${toTitleCase(String(i.description))} £${Number(i.amount).toFixed(2)}`).join(', ');
  }
  if (quoteItems) return quoteItems;
  if (quotedAmount) return `Total £${Number(quotedAmount).toFixed(2)}`;
  return '';
}

function buildOverlapWarning(overlaps) {
  const lines = overlaps.map((o) => {
    const dateRange = o.start_date === o.end_date
      ? templates.formatDate(o.start_date)
      : `${templates.formatDate(o.start_date)} – ${templates.formatDate(o.end_date)}`;
    return `• ${dateRange} — ${toTitleCase(o.description)} (${o.customer_name})`;
  }).join('\n');
  return `⚠️ You've already got jobs on those dates:\n\n${lines}\n\nBook it in anyway? Reply *yes* to confirm or *cancel* if it's a mistake.`;
}

const WORKFLOW_INTENTS = new Set(['new_customer', 'new_job', 'quote', 'schedule', 'reschedule', 'add_block', 'settings']);

function isWorkflowInterrupt(intent) {
  return intent?.kind === 'query' || (intent?.kind === 'command' && !WORKFLOW_INTENTS.has(intent.intent));
}

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
