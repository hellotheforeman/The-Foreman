const express = require('express');
const config = require('./config');
const { normalisePhone } = require('./phone');
const { parse, parseLineItems, extractAmount } = require('./parser');
const { dispatch, SETTINGS_FIELDS, buildSettingsMenu, openJobsSuggestion } = require('./handlers');
const { logMessage, findBusinessByPhone } = require('./db');
const { twimlReply, twimlReplyPair, sendToForeman } = require('./messenger');
const scheduler = require('./scheduler');
const db = require('./db');
const { registerAdminRoutes } = require('./admin');
const { registerSignupRoutes } = require('./signup');
const workflowEngine = require('./workflow-engine');
const templates = require('./templates');
const { getConversationState, setConversationState, clearConversationState } = require('./conversation-state');
const { parseWithAI } = require('./ai-parser');
const { resolveSingleJobReference } = require('./entity-resolver');

const twilio = require('twilio');
const https = require('https');
const { uploadLogo } = require('./storage');
const app = express();

// Strip document words and possessives so "Chloe's invoice" → "Chloe", "Smith's quote" → "Smith"
function extractCustomerName(input) {
  return input
    .replace(/['']s\s*(invoice|quote)?\s*$/i, '')
    .replace(/\s+(invoice|quote)\s*$/i, '')
    .replace(/^(?:the|for|an?\s+)\s*/i, '')
    .trim();
}

// Trust proxy headers so Express reconstructs the correct HTTPS URL behind
// Railway / Heroku / Render — required for Twilio signature validation to work.
app.enable('trust proxy');

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(require('path').join(__dirname, 'public')));

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
if (!config.twilio.authToken && !isLocalDev) {
  console.error('FATAL: TWILIO_AUTH_TOKEN is not set. Refusing to start without webhook validation in production.');
  process.exit(1);
}
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
const SETUP_QUESTIONS = {
  trade:    `What's your trade? (e.g. Plumber, Electrician, Builder)\n\nReply *skip* to do this later.`,
  email:    `What's your email address?\n\nReply *skip* to do this later.`,
  address:  `What's your business address?\n\nReply *skip* to do this later.`,
  logo_path: `Last one — send your logo as a photo and it'll appear on all your quotes and invoices.\n\nReply *skip* to do this later.`,
};

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

    // Idempotency — Twilio retries webhooks on timeout; ignore duplicates
    if (messageSid && await db.hasProcessedMessage(messageSid)) {
      console.log(`⚠️ Duplicate webhook ${messageSid} — skipping`);
      return res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    }

    const normPhone = normalisePhone(from);
    let business = await findBusinessByPhone(normPhone);

    if (!business) {
      console.log(`📥 New user (${from}) — auto-creating account`);
      business = await db.createBusinessFromPhone(normPhone);
      await logMessage('IN', 'TRADESPERSON', body, { businessId: business.id, whatsappMessageId: messageSid });
      return handleOnboarding({ business, body, mediaUrl, res });
    }

    await logMessage('IN', 'TRADESPERSON', body, { businessId: business.id, whatsappMessageId: messageSid });

    if (business.status !== 'active') {
      console.log(`📥 ${from} — account ${business.status}, blocking`);
      return twimlReply(res, `Your Foreman account is ${business.status}. We'll be in touch once it's active.`);
    }

    // --- Onboarding ---
    if (!business.onboarded) {
      // Clear any stale non-onboarding state (e.g. from a restart mid-session)
      const preOnboardState = await getConversationState(business.id);
      if (preOnboardState && preOnboardState.workflow !== 'onboarding') {
        await clearConversationState(business.id);
      }
      return handleOnboarding({ business, body, mediaUrl, res });
    }
    // --- End onboarding ---

    // Fetch conversation state before parsing so we can skip the AI parser when
    // mid-workflow — structured replies (numbers, amounts) must not be misread as commands.
    let currentState = await getConversationState(business.id);

    let intent = parse(body);
    if (intent.intent === 'unknown' && (!currentState || currentState.workflow === 'quote_focus' || currentState.workflow === 'invoice_focus' || currentState.workflow === 'amend_pending' || currentState.workflow === 'morning_briefing' || (currentState.workflow === 'quote_flow' && currentState.collected?.step === 'customer_name'))) {
      const aiResult = await parseWithAI(body, { onboarded: business.onboarded, businessName: business.business_name });
      if (aiResult) {
        if (aiResult.type === 'reply') return twimlReply(res, aiResult.message);
        intent = aiResult;
      }
    }
    intent.business = business;
    console.log(`📥 ${business.business_name || business.name}: "${body}" → ${intent.intent}`);

    // --- Context resolution ---
    // quote_focus / invoice_focus carry the last discussed job. When the next message is
    // contextual (no explicit customer name or job ID), inject the focus job so the user
    // can say "he paid", "chase him", "he accepted" without repeating the name.
    // Context expires after 30 minutes to avoid stale matches.
    {
      const ctx = currentState?.workflow === 'quote_focus' || currentState?.workflow === 'invoice_focus' ? currentState : null;
      if (ctx && !intent.jobId && !intent.jobRef) {
        const focusJobId = ctx.focus?.jobId;
        const focusSetAt = ctx.focus?.setAt;
        const expired = focusSetAt && (Date.now() - focusSetAt > 30 * 60 * 1000);
        if (expired) {
          await clearConversationState(business.id);
          currentState = null;
        } else if (focusJobId) {
          const CONTEXT_INTENTS = ['paid', 'chase', 'cancel_job'];
          const isQuoteAcceptance = intent.intent === 'send_invoice' && intent.fromQuote && ctx.workflow === 'quote_focus';
          if (CONTEXT_INTENTS.includes(intent.intent) || isQuoteAcceptance) {
            intent = { ...intent, jobId: focusJobId };
            await clearConversationState(business.id);
            currentState = null;
          }
        }
      }
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
          return twimlReply(res, `Pick a number from the list above, or say *cancel* to close.`);
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
          return twimlReply(res, `Are you VAT registered? Reply *yes* or *no*.`);
        }
        if (setting.type === 'bank') {
          return twimlReply(res, `What's your sort code? I'll grab the account number straight after. (e.g. 12-34-56)`);
        }
        if (setting.type === 'image') {
          if (business.logo_path) {
            return twimlReply(res, `Send a new photo to replace your logo, or reply *remove* to delete it.`);
          }
          return twimlReply(res, `Send your logo as a photo — it'll appear on all your quotes and invoices.`);
        }
        return twimlReply(res, `What should *${setting.label}* be?`);
      }

      if (currentState.pending?.field === 'value') {
        const { settingKey, settingLabel, settingType } = currentState.collected || {};
        if (settingKey) {
          if (settingType === 'image') {
            if (/^remove$/i.test(trimmed)) {
              await db.updateBusiness(business.id, { logo_path: null });
              await clearConversationState(business.id);
              return twimlReply(res, `✅ Logo removed.`);
            }
            if (!mediaUrl) {
              const hint = business.logo_path
                ? `Send a new photo to replace it, or reply *remove* to delete it.`
                : `Send your logo as a photo — it'll appear on all your quotes and invoices.`;
              return twimlReply(res, hint);
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

          if (settingType === 'bank') {
            // Step 1: collect sort code, move to account_number step
            await setConversationState(business.id, {
              ...currentState,
              collected: { ...currentState.collected, sortCode: trimmed },
              pending: { type: 'field', field: 'account_number' },
            });
            return twimlReply(res, `Got it. Now what's the account number?`);
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

          if (settingType === 'number') {
            const n = parseInt(trimmed, 10);
            if (!n || n < 1 || n > 365 || String(n) !== trimmed.trim()) {
              return twimlReply(res, `Enter a number of days, e.g. *14* or *30*.`);
            }
            await db.updateBusiness(business.id, { [settingKey]: n });
            await clearConversationState(business.id);
            return twimlReply(res, `Done — payment terms set to ${n} days.`);
          }

          const isBoolean = settingType === 'boolean';
          const value = isBoolean ? /^(yes|y|true|1)$/i.test(trimmed) : trimmed;
          await db.updateBusiness(business.id, { [settingKey]: value });
          await clearConversationState(business.id);
          let confirmMsg;
          if (settingKey === 'business_name') confirmMsg = `Got it — trading as ${value} from now on.`;
          else if (settingKey === 'trade') confirmMsg = `Got it — I'll use that on your quotes and invoices.`;
          else if (settingKey === 'email') confirmMsg = `Got it — ${value} is on your quotes and invoices.`;
          else if (settingKey === 'address') confirmMsg = `Done — address updated.`;
          else confirmMsg = `Done — ${settingLabel.toLowerCase()} updated.`;
          return twimlReply(res, confirmMsg);
        }
      }

      if (currentState.pending?.field === 'vat_number') {
        await db.updateBusiness(business.id, { vat_number: trimmed });
        await clearConversationState(business.id);
        return twimlReply(res, `Done — VAT registered, ${trimmed}.`);
      }

      if (currentState.pending?.field === 'account_number') {
        const { sortCode } = currentState.collected || {};
        const paymentDetails = `Sort code: ${sortCode}\nAccount number: ${trimmed}`;
        await db.updateBusiness(business.id, { payment_details: paymentDetails });
        await clearConversationState(business.id);
        return twimlReply(res, `Done — bank details saved. These will appear on all your invoices.`);
      }

      // Fallback — show menu again
      return twimlReply(res, buildSettingsMenu(business));
    }
    // --- End settings workflow ---

    // --- VAT gate ---
    // If VAT status has never been set, collect it before creating any financial document.
    if ((business.vat_registered === null || business.vat_registered === undefined)
        && (intent.intent === 'quote' || intent.intent === 'send_invoice')
        && currentState?.workflow !== 'vat_gate'
        && !['quote_flow', 'quote_focus', 'invoice_flow', 'invoice_guided', 'invoice_pick', 'invoice_focus', 'paid_pick'].includes(currentState?.workflow)) {
      await setConversationState(business.id, {
        workflow: 'vat_gate',
        focus: {},
        collected: {
          pendingIntent: {
            kind: intent.kind, intent: intent.intent,
            jobId: intent.jobId || null, jobRef: intent.jobRef || null,
            amount: intent.amount != null ? intent.amount : null,
            items: intent.items || null, lineItems: intent.lineItems || null,
            name: intent.name || null,
          },
        },
        pending: { type: 'field', field: 'vat_registered' },
        options: [],
      });
      return twimlReply(res, `Quick one before I put this together — are you VAT registered? Reply *yes* or *no*.`);
    }

    if (currentState?.workflow === 'vat_gate') {
      const trimmed = body.trim();

      if (currentState.pending?.field === 'vat_registered') {
        const isYes = /^(yes|y|yep|yeah)$/i.test(trimmed);
        const isNo = /^(no|n|nope|nah)$/i.test(trimmed);
        if (!isYes && !isNo) {
          return twimlReply(res, `Reply *yes* if you're VAT registered, or *no* if not.`);
        }
        await db.updateBusiness(business.id, { vat_registered: isYes, ...(isNo && { vat_number: null }) });
        business = { ...business, vat_registered: isYes };
        if (isYes) {
          await setConversationState(business.id, {
            ...currentState,
            pending: { type: 'field', field: 'vat_number' },
          });
          return twimlReply(res, `What's your VAT number? Reply *skip* to continue without it for now.`);
        }
        const pending = currentState.collected?.pendingIntent;
        await clearConversationState(business.id);
        return pending ? dispatch({ ...pending, business }, res) : twimlReply(res, `Got it — not VAT registered.`);
      }

      if (currentState.pending?.field === 'vat_number') {
        const isSkip = /^skip$/i.test(trimmed);
        if (!isSkip) await db.updateBusiness(business.id, { vat_number: trimmed });
        business = { ...business, vat_number: isSkip ? null : trimmed };
        const pending = currentState.collected?.pendingIntent;
        await clearConversationState(business.id);
        return pending ? dispatch({ ...pending, business }, res) : twimlReply(res, `Got it — VAT number saved.`);
      }

      await clearConversationState(business.id);
      return twimlReply(res, `Something went wrong — what did you need?`);
    }
    // --- End VAT gate ---

    // --- Bank details gate ---
    if (currentState?.workflow === 'bank_gate') {
      const trimmed = body.trim();

      if (currentState.pending?.field === 'bank_confirm') {
        if (/^(skip|no|nope|later|s|n)$/i.test(trimmed)) {
          const { pendingIntent } = currentState.collected;
          await clearConversationState(business.id);
          res.on('finish', () => {
            sendToForeman(
              `No problem — you can add them anytime in *settings* if you change your mind.`,
              { businessId: business.id, businessPhone: business.phone }
            ).catch(err => console.error('Bank details nudge failed:', err.message));
          });
          return pendingIntent
            ? dispatch({ ...pendingIntent, skipBankGate: true, business }, res)
            : twimlReply(res, `No problem — just let me know what you need.`);
        }
        if (/^(yes|y|yep|yeah)$/i.test(trimmed)) {
          await setConversationState(business.id, {
            ...currentState,
            pending: { type: 'field', field: 'sort_code' },
          });
          return twimlReply(res, `Start with your sort code (e.g. 12-34-56) — or reply *Skip* to leave bank details off.`);
        }
        return twimlReply(res, `Reply *Yes* to add your bank details, or *Skip* to send the invoice without.`);
      }

      if (currentState.pending?.field === 'sort_code') {
        await setConversationState(business.id, {
          ...currentState,
          collected: { ...currentState.collected, sortCode: trimmed },
          pending: { type: 'field', field: 'account_number' },
        });
        return twimlReply(res, `And the account number?`);
      }

      if (currentState.pending?.field === 'account_number') {
        const { sortCode, pendingIntent } = currentState.collected;
        const paymentDetails = `Sort code: ${sortCode}\nAccount number: ${trimmed}`;
        await db.updateBusiness(business.id, { payment_details: paymentDetails });
        business = { ...business, payment_details: paymentDetails };
        await clearConversationState(business.id);
        return pendingIntent ? dispatch({ ...pendingIntent, business }, res) : twimlReply(res, `Bank details saved.`);
      }

      await clearConversationState(business.id);
      return twimlReply(res, `Something went wrong — what did you need?`);
    }
    // --- End bank details gate ---

    // --- Profile setup offered ---
    // Sent as a proactive second message after first quote/invoice. Handles the yes/skip response.
    if (currentState?.workflow === 'profile_setup_offered') {
      const trimmed = body.trim();
      const fields = currentState.collected?.fields || [];

      if (/^(yes|y|yep|yeah)$/i.test(trimmed)) {
        await setConversationState(business.id, {
          workflow: 'profile_setup',
          focus: {},
          collected: { fields },
          pending: { type: 'field', field: fields[0] },
          options: [],
        });
        return twimlReply(res, SETUP_QUESTIONS[fields[0]]);
      }

      await clearConversationState(business.id);
      if (/^(skip|no|nope|later|not now)$/i.test(trimmed)) {
        return twimlReply(res, `No problem — you can update your profile any time by saying *settings*.`);
      }
      // Any other message (e.g. "jobs", "quote for Smith") — dispatch it normally
      return dispatch({ ...intent, business }, res);
    }

    // --- Profile setup flow ---
    if (currentState?.workflow === 'profile_setup') {
      const trimmed = body.trim();
      const fields = currentState.collected?.fields || [];
      const currentField = fields[0];

      if (!currentField) {
        await clearConversationState(business.id);
        return twimlReply(res, `All set — your profile is updated. 🎉 It'll show on all your quotes and invoices.`);
      }

      const isSkip = /^skip$/i.test(trimmed);

      if (currentField === 'logo_path') {
        if (!isSkip && !mediaUrl) {
          return twimlReply(res, `Please send your logo as a photo, or say *skip* to do it later.`);
        }
        if (!isSkip && mediaUrl) {
          try {
            const buffer = await downloadToBuffer(mediaUrl);
            const ext = detectImageExt(buffer);
            if (!ext) {
              return twimlReply(res, `That file type isn't supported — please send a JPEG or PNG, or say *skip*.`);
            }
            const logoUrl = await uploadLogo(business.id, buffer, ext);
            await db.updateBusiness(business.id, { logo_path: logoUrl });
          } catch (err) {
            console.error('Profile setup logo upload failed:', err);
            return twimlReply(res, `Couldn't save that image — try again or say *skip*.`);
          }
        }
      } else if (!isSkip) {
        await db.updateBusiness(business.id, { [currentField]: trimmed });
      }

      const remaining = fields.slice(1);
      if (!remaining.length) {
        await clearConversationState(business.id);
        return twimlReply(res, `All set — your profile is updated. 🎉 It'll show on all your quotes and invoices.`);
      }

      await setConversationState(business.id, {
        ...currentState,
        collected: { fields: remaining },
        pending: { type: 'field', field: remaining[0] },
      });
      return twimlReply(res, SETUP_QUESTIONS[remaining[0]]);
    }
    // --- End profile setup ---

    // --- Unified quote flow ---
    // Triggered by: bare "quote", "quote for Mrs Smith", "quote Mrs Smith" — no job ID, no amount.
    // Silently creates customer + job, then hands off to handleQuote.
    // If the user was mid-way through an unrelated flow (e.g. new_customer), clear it so
    // the quote flow can start fresh rather than falling through to the workflow engine.
    if (intent.intent === 'quote' && !intent.jobId
        && currentState && currentState.workflow !== 'quote_flow') {
      await clearConversationState(business.id);
      currentState = null;
    }
    if (!currentState && intent.intent === 'quote' && !intent.jobId) {
      // jobRef or items contains digits → regex captured more than a clean name; use AI for field extraction
      if (
        (typeof intent.jobRef === 'string' && /\d/.test(intent.jobRef)) ||
        (!intent.jobRef && typeof intent.items === 'string' && /\d/.test(intent.items))
      ) {
        const aiResult = await parseWithAI(body, { onboarded: business.onboarded, businessName: business.business_name });
        if (aiResult && !aiResult.type && aiResult.intent === 'quote' && aiResult.jobRef) {
          intent = { ...intent, ...aiResult };
        }
      }
      const { customerRef: rawCustomerRef, prefilledDescription: descFromParts } = extractQuoteParts(intent);
      let prefilledItems = intent.items ?? null;
      const _qParsedItems = prefilledItems ? parseLineItems(prefilledItems) : null;
      let prefilledLineItems = intent.lineItems ?? _qParsedItems ?? null;
      let prefilledAmount = _qParsedItems
        ? _qParsedItems.reduce((s, i) => s + i.amount, 0)
        : (intent.amount ?? null);
      const prefilledDescription = descFromParts || null;
      // If what was extracted as a customer ref looks like a sentence rather than a name, try AI before discarding
      let customerRef = (rawCustomerRef && (/^(?:for|to|a|an|the|i|i've)\b/i.test(rawCustomerRef) || rawCustomerRef.split(' ').length > 5))
        ? null
        : rawCustomerRef;
      if (!customerRef) {
        const aiResult = await parseWithAI(body, { onboarded: business.onboarded, businessName: business.business_name });
        if (aiResult && !aiResult.type && aiResult.intent === 'quote' && aiResult.jobRef) {
          customerRef = aiResult.jobRef;
          if (aiResult.amount != null && prefilledAmount == null) prefilledAmount = aiResult.amount;
          if (aiResult.items != null && !prefilledItems) prefilledItems = aiResult.items;
        }
      }

      if (customerRef) {
        const resolved = await resolveSingleJobReference({ businessId: business.id, parsedIntent: { ...intent, jobRef: customerRef }, raw: body, state: null });

        if (resolved.status === 'resolved') {
          if (prefilledItems || prefilledDescription) {
            // Items or description provided = new work, not a re-quote of the existing job
            if (prefilledAmount != null) {
              const { job } = await createCustomerAndJob(business.id, { customerId: resolved.job.customer_id, customerName: resolved.job.customer_name, description: prefilledDescription });
              return dispatch({ kind: 'command', intent: 'quote', jobId: job.id, amount: prefilledAmount, items: prefilledItems, lineItems: prefilledLineItems, business }, res);
            }
            await setConversationState(business.id, {
              workflow: 'quote_flow',
              focus: {},
              collected: { step: 'price', customerId: resolved.job.customer_id, customerName: resolved.job.customer_name, description: prefilledDescription },
              pending: { type: 'field', field: 'price' },
              options: [],
            });
            return twimlReply(res, `Got it — ${resolved.job.customer_name}, ${prefilledDescription}.\n\nEnter the price\nYou can add a total or itemise (e.g. labour £250, materials £45).`);
          }
          return dispatch({ ...intent, jobId: resolved.job.id, business }, res);
        }

        if (resolved.status === 'multiple') {
          const lines = resolved.jobs.slice(0, 5).map((j, i) => `${i + 1}. ${j.customer_name} — ${toTitleCase(j.description)}`).join('\n');
          await setConversationState(business.id, {
            workflow: 'quote_flow',
            focus: {},
            collected: { step: 'pick_job', jobs: resolved.jobs.slice(0, 5) },
            pending: { type: 'selection', field: 'jobId' },
            options: resolved.jobs.slice(0, 5),
          });
          return twimlReply(res, `I found a few matches:\n${lines}\n\nReply with 1, 2 or 3.`);
        }

        // Customer exists but no open job — skip steps we already have data for
        const existingCustomers = await db.findCustomerByName(business.id, customerRef);
        if (existingCustomers.length === 1) {
          const ec = existingCustomers[0];
          if (prefilledDescription && prefilledAmount != null) {
            const { job } = await createCustomerAndJob(business.id, { customerId: ec.id, customerName: ec.name, description: prefilledDescription });
            return dispatch({ kind: 'command', intent: 'quote', jobId: job.id, amount: prefilledAmount, items: prefilledItems, lineItems: prefilledLineItems, business }, res);
          }
          if (prefilledDescription) {
            await setConversationState(business.id, {
              workflow: 'quote_flow',
              focus: {},
              collected: { step: 'price', customerId: ec.id, customerName: ec.name, description: prefilledDescription },
              pending: { type: 'field', field: 'price' },
              options: [],
            });
            return twimlReply(res, `Got it — ${ec.name}, ${prefilledDescription}.\n\nEnter the price\nYou can add a total or itemise (e.g. labour £250, materials £45).`);
          }
          await setConversationState(business.id, {
            workflow: 'quote_flow',
            focus: {},
            collected: { step: 'description', customerId: ec.id, customerName: ec.name },
            pending: { type: 'field', field: 'description' },
            options: [],
          });
          return twimlReply(res, `What's the scope of work for ${ec.name}?`);
        }

        // New customer — ask for address first, then any missing fields
        await setConversationState(business.id, {
          workflow: 'quote_flow',
          focus: {},
          collected: { step: 'address', customerName: customerRef, description: prefilledDescription || null, amount: prefilledAmount, items: prefilledItems, lineItems: prefilledLineItems },
          pending: { type: 'field', field: 'address' },
          options: [],
        });
        return twimlReply(res, `What's ${customerRef}'s address?\n\nReply *skip* to leave blank.`);
      }

      // Bare "quote" — ask for customer name
      await setConversationState(business.id, {
        workflow: 'quote_flow',
        focus: {},
        collected: { step: 'customer_name' },
        pending: { type: 'field', field: 'customer_name' },
        options: [],
      });
      return twimlReply(res, `Who's this quote for?`);
    }

    if (currentState?.workflow === 'quote_flow') {
      const trimmed = body.trim();
      const c = currentState.collected || {};

      if (/^(cancel|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'No problem — quote dropped.');
      }

      if (isWorkflowInterrupt(intent)) {
        await clearConversationState(business.id);
        return dispatch({ ...intent, business }, res);
      }

      // Step: pick from multiple job matches
      if (c.step === 'pick_job') {
        const n = parseInt(trimmed, 10);
        const jobs = c.jobs || [];
        if (!n || n < 1 || n > jobs.length) {
          return twimlReply(res, `Pick a number from the list above.`);
        }
        const job = jobs[n - 1];
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'quote', jobId: job.id, amount: null, items: null, lineItems: null, business }, res);
      }

      // Step: customer name (bare "quote" trigger)
      if (c.step === 'customer_name') {
        // Prefer AI-extracted name (handles complex sentences like "£700 for hedge cutting, customer is Jan Raymond")
        const rawName = intent.jobRef || intent.name || trimmed;
        const customerName = extractCustomerName(rawName);

        // Re-prompt if result looks wrong — starts with £/$, too many words, or clearly a sentence
        if (!customerName || /^[£$\d]/.test(customerName) || customerName.split(/\s+/).length > 5 || /\b(it|is|are|for|and|new|quote|invoice)\b/i.test(customerName)) {
          return twimlReply(res, `Who's this quote for? Just the customer's name.`);
        }

        // Carry forward any extra fields the AI spotted in the same message
        const _csnParsed = intent.items ? parseLineItems(intent.items) : null;
        const csnAmount = intent.amount != null ? intent.amount : (_csnParsed ? _csnParsed.reduce((s, i) => s + i.amount, 0) : null);
        const csnDesc = _csnParsed ? _csnParsed.map(i => i.description).join(', ') : (intent.items || intent.description);
        const extraCollected = {
          ...(csnAmount != null && c.amount == null ? { amount: csnAmount } : {}),
          ...(csnDesc && !c.description ? { description: csnDesc, ...(_csnParsed ? { lineItems: _csnParsed, items: intent.items } : {}) } : {}),
        };

        const existingCustomers = await db.findCustomerByName(business.id, customerName);
        if (existingCustomers.length === 1) {
          const existing = existingCustomers[0];
          if (extraCollected.description && extraCollected.amount != null) {
            const { job } = await createCustomerAndJob(business.id, { customerId: existing.id, customerName: existing.name, description: extraCollected.description });
            return dispatch({ kind: 'command', intent: 'quote', jobId: job.id, amount: extraCollected.amount, items: extraCollected.items || null, lineItems: extraCollected.lineItems || null, business }, res);
          }
          await setConversationState(business.id, {
            ...currentState,
            collected: { step: extraCollected.description ? 'price' : 'description', customerId: existing.id, customerName: existing.name, ...extraCollected },
          });
          return twimlReply(res, extraCollected.description
            ? `Got it — ${existing.name}, ${extraCollected.description}.\n\nEnter the price\nYou can add a total or itemise (e.g. labour £250, materials £45).`
            : `Got it — what's the work for ${existing.name}?`);
        }
        await setConversationState(business.id, {
          ...currentState,
          collected: { step: 'address', customerName, ...extraCollected },
        });
        return twimlReply(res, `What's ${customerName}'s address?\n\nReply *skip* to leave blank.`);
      }

      // Step: address (new customers only)
      if (c.step === 'address') {
        // Re-prompt if reply looks like confusion rather than an address
        if (/\b(quote|invoice|new|job)\b/i.test(trimmed) && !/\d/.test(trimmed)) {
          return twimlReply(res, `What's ${c.customerName}'s address?\n\nReply *skip* to leave blank.`);
        }
        const address = /^skip$/i.test(trimmed) ? null : formatAddress(trimmed);
        if (c.description && c.amount != null) {
          await clearConversationState(business.id);
          const { job } = await createCustomerAndJob(business.id, { ...c, address });
          return dispatch({ kind: 'command', intent: 'quote', jobId: job.id, amount: c.amount, items: c.items || null, lineItems: c.lineItems || null, business }, res);
        }
        if (c.description) {
          await setConversationState(business.id, { ...currentState, collected: { ...c, step: 'price', address } });
          return twimlReply(res, `What's the price?\nYou can give a total or itemise (e.g. labour £250, materials £45).`);
        }
        await setConversationState(business.id, { ...currentState, collected: { ...c, step: 'description', address } });
        return twimlReply(res, `What's the scope of work for ${c.customerName}?`);
      }

      // Step: job description
      if (c.step === 'description') {
        const description = trimmed;
        if (c.amount != null) {
          await clearConversationState(business.id);
          const { job } = await createCustomerAndJob(business.id, { ...c, description });
          return dispatch({ kind: 'command', intent: 'quote', jobId: job.id, amount: c.amount, items: c.items || null, lineItems: c.lineItems || null, business }, res);
        }
        await setConversationState(business.id, {
          ...currentState,
          collected: { ...c, step: 'price', description },
        });
        return twimlReply(res, `What's the price?\nYou can give a total or itemise (e.g. labour £250, materials £45).`);
      }

      // Step: price or line items — detect format automatically
      if (c.step === 'price') {
        const lineItems = parseLineItems(trimmed);
        if (lineItems) {
          const amount = lineItems.reduce((sum, i) => sum + i.amount, 0);
          await clearConversationState(business.id);
          const { job } = await createCustomerAndJob(business.id, c);
          return dispatch({ kind: 'command', intent: 'quote', jobId: job.id, amount, items: trimmed, lineItems, business }, res);
        }
        const m = trimmed.match(/^£?(\d+(?:\.\d{1,2})?)\s*$/);
        if (!m) return twimlReply(res, `What's the price? (e.g. *450*, or itemised: *labour 250, parts 45*)`);
        const amount = parseFloat(m[1]);
        await clearConversationState(business.id);
        const { job } = await createCustomerAndJob(business.id, c);
        return dispatch({ kind: 'command', intent: 'quote', jobId: job.id, amount, items: null, lineItems: null, business }, res);
      }

      await clearConversationState(business.id);
      return twimlReply(res, 'Quote cancelled.');
    }
    // --- End unified quote flow ---

    // --- Invoice flow ---
    // Entered from invoice_pick after a name is typed. Collects phone, address,
    // description, and price for a new or existing customer, then creates the job and invoice.
    if (currentState?.workflow === 'invoice_flow') {
      const trimmed = body.trim();
      const c = currentState.collected || {};

      if (/^(cancel|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'No problem — invoice dropped.');
      }

      if (isWorkflowInterrupt(intent)) {
        await clearConversationState(business.id);
        return dispatch({ ...intent, business }, res);
      }

      if (c.step === 'address') {
        const address = /^skip$/i.test(trimmed) ? null : trimmed;
        if (c.description && c.amount != null) {
          await clearConversationState(business.id);
          const { job } = await createCustomerAndJob(business.id, { ...c, address });
          return dispatch({ kind: 'command', intent: 'send_invoice', jobId: job.id, amount: c.amount, items: c.items || null, lineItems: c.lineItems || null, business }, res);
        }
        if (c.description) {
          await setConversationState(business.id, { ...currentState, collected: { ...c, step: 'price', address } });
          return twimlReply(res, `What's the price?\nYou can give a total or itemise (e.g. labour £250, materials £45).`);
        }
        await setConversationState(business.id, { ...currentState, collected: { ...c, step: 'description', address } });
        return twimlReply(res, `What's the scope of work for ${c.customerName}?`);
      }

      if (c.step === 'description') {
        const description = trimmed;
        if (c.amount != null) {
          await clearConversationState(business.id);
          const { job } = await createCustomerAndJob(business.id, { ...c, description });
          return dispatch({ kind: 'command', intent: 'send_invoice', jobId: job.id, amount: c.amount, items: c.items || null, lineItems: c.lineItems || null, business }, res);
        }
        await setConversationState(business.id, { ...currentState, collected: { ...c, step: 'price', description } });
        return twimlReply(res, `What's the price?\nYou can give a total or itemise (e.g. labour £250, materials £45).`);
      }

      if (c.step === 'price') {
        const lineItems = parseLineItems(trimmed);
        if (lineItems) {
          const amount = lineItems.reduce((sum, i) => sum + i.amount, 0);
          await clearConversationState(business.id);
          const { job } = await createCustomerAndJob(business.id, c);
          return dispatch({ kind: 'command', intent: 'send_invoice', jobId: job.id, amount, items: trimmed, lineItems, business }, res);
        }
        const amount = extractAmount(trimmed);
        if (amount == null) return twimlReply(res, `What's the price? (e.g. *450*, or itemised: *labour 250, parts 45*)`);
        await clearConversationState(business.id);
        const { job } = await createCustomerAndJob(business.id, c);
        return dispatch({ kind: 'command', intent: 'send_invoice', jobId: job.id, amount, items: null, lineItems: null, business }, res);
      }

      await clearConversationState(business.id);
      return twimlReply(res, 'No problem — invoice dropped.');
    }
    // --- End invoice flow ---

    // --- Resend invoice — remap early so the invoice-by-name block below can handle it ---
    if (intent.intent === 'resend_invoice') {
      intent = { ...intent, intent: 'send_invoice' };
    }

    // --- Quote accepted (go ahead / accepted / confirmed) ---
    // No customer name given — find the one quoted job, or show a short list
    if (!currentState && intent.intent === 'send_invoice' && !intent.jobId && !intent.jobRef && intent.fromQuote) {
      const quotedJobs = await db.getJobsByStatus(business.id, 'quoted');
      if (!quotedJobs.length) {
        return twimlReply(res, `No quotes out at the moment — say *quote* to create one.`);
      }
      if (quotedJobs.length === 1) {
        return dispatch({ kind: 'command', intent: 'send_invoice', jobId: quotedJobs[0].id, business }, res);
      }
      const lines = quotedJobs.slice(0, 5).map((j, i) => `${i + 1}. ${j.customer_name} — ${toTitleCase(j.description)}`).join('\n');
      await setConversationState(business.id, {
        workflow: 'invoice_pick',
        focus: {},
        collected: { jobs: quotedJobs.slice(0, 5) },
        pending: { type: 'selection', field: 'jobId' },
        options: quotedJobs.slice(0, 5),
      });
      return twimlReply(res, `Which quote was accepted?\n\n${lines}\n\nReply with a number or name.`);
    }

    // --- Invoice by name ---
    // Same guard — clear stale unrelated state so the invoice flow isn't bypassed.
    if (intent.intent === 'send_invoice' && !intent.jobId
        && currentState && !['invoice_flow', 'invoice_guided', 'invoice_pick'].includes(currentState.workflow)) {
      await clearConversationState(business.id);
      currentState = null;
    }
    if (!currentState && intent.intent === 'send_invoice' && !intent.jobId && intent.jobRef) {
      // jobRef or items contains digits → regex captured more than a clean name; use AI for field extraction
      if (
        (typeof intent.jobRef === 'string' && /\d/.test(intent.jobRef)) ||
        (typeof intent.items === 'string' && /\d/.test(intent.items))
      ) {
        const aiResult = await parseWithAI(body, { onboarded: business.onboarded, businessName: business.business_name });
        if (aiResult && !aiResult.type && aiResult.intent === 'send_invoice' && aiResult.jobRef) {
          intent = { ...intent, ...aiResult };
        }
      }
      const resolved = await resolveSingleJobReference({ businessId: business.id, parsedIntent: intent, raw: body, state: null, includeAll: true });
      if (resolved.status === 'resolved') {
        if (intent.items) {
          const _iResDesc = parseLineItems(intent.items);
          const iResLineItems = intent.lineItems ?? _iResDesc ?? null;
          const iResAmt = _iResDesc
            ? _iResDesc.reduce((s, i) => s + i.amount, 0)
            : (intent.amount ?? null);
          const iResCleanDesc = null;
          if (iResAmt != null) {
            const { job } = await createCustomerAndJob(business.id, { customerId: resolved.job.customer_id, customerName: resolved.job.customer_name, description: iResCleanDesc });
            return dispatch({ kind: 'command', intent: 'send_invoice', jobId: job.id, amount: iResAmt, items: intent.items, lineItems: iResLineItems, business }, res);
          }
          await setConversationState(business.id, {
            workflow: 'invoice_flow', focus: {},
            collected: { step: 'price', customerId: resolved.job.customer_id, customerName: resolved.job.customer_name, description: iResCleanDesc, items: intent.items },
            pending: { type: 'field', field: 'price' }, options: [],
          });
          return twimlReply(res, `What's the price?\nYou can give a total or itemise (e.g. labour £250, materials £45).`);
        }
        return dispatch({ ...intent, jobId: resolved.job.id, business }, res);
      }
      if (resolved.status === 'multiple') {
        const lines = resolved.jobs.slice(0, 5).map((j, i) => `${i + 1}. ${j.customer_name} — ${toTitleCase(j.description)}`).join('\n');
        await setConversationState(business.id, {
          workflow: 'invoice_pick',
          focus: {},
          collected: { jobs: resolved.jobs.slice(0, 5) },
          pending: { type: 'selection', field: 'jobId' },
          options: resolved.jobs.slice(0, 5),
        });
        return twimlReply(res, `I found a few matches:\n${lines}\n\nReply with 1, 2 or 3.`);
      }
      // jobRef didn't resolve — enter invoice_flow directly (we already have the name)
      {
        const preDesc = intent.items || null;
        const _iParsedItems = preDesc ? parseLineItems(preDesc) : null;
        const preLineItems = intent.lineItems ?? _iParsedItems ?? null;
        const preAmt = intent.amount ?? (_iParsedItems ? _iParsedItems.reduce((s, i) => s + i.amount, 0) : null);
        // Job description stores only item names (no £ amounts) — PDF uses the structured line items for the table
        const cleanPreDesc = _iParsedItems ? _iParsedItems.map(i => i.description).join(', ') : preDesc;
        const existingCustomers = await db.findCustomerByName(business.id, intent.jobRef);
        const baseCollected = existingCustomers.length === 1
          ? { customerId: existingCustomers[0].id, customerName: existingCustomers[0].name }
          : { customerName: intent.jobRef };
        // Fast path: name + description + amount all present — create invoice without asking for phone/address
        if (preDesc && preAmt != null) {
          const { job } = await createCustomerAndJob(business.id, { ...baseCollected, description: cleanPreDesc });
          return dispatch({ kind: 'command', intent: 'send_invoice', jobId: job.id, amount: preAmt, items: preDesc, lineItems: preLineItems, business }, res);
        }
        await setConversationState(business.id, {
          workflow: 'invoice_flow',
          focus: {},
          collected: { step: 'address', ...baseCollected, description: cleanPreDesc, amount: preAmt, items: preDesc, lineItems: preLineItems },
          pending: { type: 'field', field: 'address' },
          options: [],
        });
        return twimlReply(res, `What's their address?\n\nReply *skip* to leave blank.`);
      }
    }

    if (currentState?.workflow === 'paid_pick') {
      const trimmed = body.trim();
      const invoices = currentState.collected?.invoices || [];
      if (/^(cancel|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'Cancelled.');
      }
      // Numeric selection
      const n = parseInt(trimmed, 10);
      if (!isNaN(n) && n >= 1 && n <= invoices.length) {
        const chosen = invoices[n - 1];
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'paid', jobId: chosen.job_id, business }, res);
      }
      // Name-based: find first invoice whose customer name includes the reply
      const nameLower = trimmed.toLowerCase();
      const nameMatches = invoices.filter(i => i.customer_name.toLowerCase().includes(nameLower));
      if (nameMatches.length === 1) {
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'paid', jobId: nameMatches[0].job_id, business }, res);
      }
      if (nameMatches.length > 1) {
        const list = nameMatches.slice(0, 5).map((i, idx) => `${idx + 1}. ${i.customer_name} — £${Number(i.amount).toFixed(2)}`).join('\n');
        return twimlReply(res, `Still a few matches — reply with a number:\n\n${list}`);
      }
      // New command — abandon pick and handle it
      if (intent.kind === 'command' && intent.intent !== 'paid') {
        await clearConversationState(business.id);
        return dispatch({ ...intent, business }, res);
      }
      const list = invoices.map((i, idx) => `${idx + 1}. ${i.customer_name} — £${Number(i.amount).toFixed(2)}`).join('\n');
      return twimlReply(res, `Didn't catch that — reply with a name or number:\n\n${list}`);
    }

    if (currentState?.workflow === 'invoice_pick') {
      const trimmed = body.trim();
      const jobs = currentState.collected?.jobs || [];
      if (/^(cancel|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'Cancelled.');
      }
      // If the user has issued a new command, abandon the pick and handle it.
      if (intent.kind === 'command' && intent.intent !== 'send_invoice') {
        await clearConversationState(business.id);
        return dispatch({ ...intent, business }, res);
      }
      // "Invoice" with no job ID while already in invoice_pick — re-show the full picker.
      if (intent.intent === 'send_invoice' && !intent.jobId && !intent.jobRef) {
        const suggestion = await openJobsSuggestion(business.id);
        return twimlReply(res, suggestion
          ? `Who's this invoice for? Here's what's outstanding:\n\n${suggestion}\n\nOr type a name to start a new one.`
          : `Who's this invoice for? Type a name or say *open* to see what's on.`
        );
      }
      // Numeric selection from a presented list
      if (jobs.length) {
        const n = parseInt(trimmed, 10);
        if (n >= 1 && n <= jobs.length) {
          await clearConversationState(business.id);
          return dispatch({ kind: 'command', intent: 'send_invoice', jobId: jobs[n - 1].id, business }, res);
        }
      }
      // Name-based resolution — strip document words so "Chloe's invoice" resolves as "Chloe"
      const customerName = extractCustomerName(trimmed);
      const resolved = await resolveSingleJobReference({ businessId: business.id, parsedIntent: { jobRef: customerName }, raw: body, state: null, includeAll: true });
      if (resolved.status === 'resolved') {
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'send_invoice', jobId: resolved.job.id, business }, res);
      }
      if (resolved.status === 'multiple') {
        const lines = resolved.jobs.slice(0, 5).map((j, i) => `${i + 1}. ${j.customer_name} — ${toTitleCase(j.description)}`).join('\n');
        await setConversationState(business.id, {
          workflow: 'invoice_pick',
          focus: {},
          collected: { jobs: resolved.jobs.slice(0, 5) },
          pending: { type: 'selection', field: 'jobId' },
          options: resolved.jobs.slice(0, 5),
        });
        return twimlReply(res, `Found a few matches:\n${lines}\n\nReply with 1–${resolved.jobs.slice(0, 5).length}.`);
      }
      // No existing job matched — check if customer exists at all (just no open job)
      const existingCustomers = await db.findCustomerByName(business.id, customerName);
      const collected = existingCustomers.length === 1
        ? { step: 'address', customerId: existingCustomers[0].id, customerName: existingCustomers[0].name }
        : { step: 'address', customerName };
      await setConversationState(business.id, {
        workflow: 'invoice_flow',
        focus: {},
        collected,
        pending: { type: 'field', field: 'address' },
        options: [],
      });
      return twimlReply(res, `What's their address?\n\nReply *skip* to leave blank.`);
    }
    // --- End invoice by name ---

    // --- Resend quote by name ---
    if (!currentState && intent.intent === 'resend_quote' && !intent.jobId && intent.jobRef) {
      const resolved = await resolveSingleJobReference({ businessId: business.id, parsedIntent: intent, raw: body, state: null, includeAll: true });
      if (resolved.status === 'resolved') {
        return dispatch({ ...intent, jobId: resolved.job.id, business }, res);
      }
      if (resolved.status === 'multiple') {
        const lines = resolved.jobs.slice(0, 5).map((j, i) => `${i + 1}. ${j.customer_name} — ${toTitleCase(j.description)}`).join('\n');
        await setConversationState(business.id, {
          workflow: 'resend_quote_pick',
          focus: {},
          collected: { jobs: resolved.jobs.slice(0, 5) },
          pending: { type: 'selection', field: 'jobId' },
          options: resolved.jobs.slice(0, 5),
        });
        return twimlReply(res, `I found a few matches:\n${lines}\n\nReply with 1–${resolved.jobs.slice(0, 5).length}.`);
      }
      return twimlReply(res, `Can't find anything for "${intent.jobRef}" — say *jobs* to see what's on.`);
    }

    if (currentState?.workflow === 'resend_quote_pick') {
      const trimmed = body.trim();
      const jobs = currentState.collected?.jobs || [];
      if (/^(cancel|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'Cancelled.');
      }
      if (intent.kind === 'command') {
        await clearConversationState(business.id);
        return dispatch({ ...intent, business }, res);
      }
      if (jobs.length) {
        const n = parseInt(trimmed, 10);
        if (n >= 1 && n <= jobs.length) {
          await clearConversationState(business.id);
          return dispatch({ kind: 'command', intent: 'resend_quote', jobId: jobs[n - 1].id, business }, res);
        }
      }
      return twimlReply(res, `Pick a number from the list above, or say *cancel*.`);
    }
    // --- End resend quote by name ---

    // --- View job by name ---
    if (!currentState && intent.intent === 'view_job' && !intent.jobId && intent.jobRef) {
      const resolved = await resolveSingleJobReference({ businessId: business.id, parsedIntent: intent, raw: body, state: null, includeAll: true });
      if (resolved.status === 'resolved') {
        return dispatch({ ...intent, jobId: resolved.job.id, business }, res);
      }
      if (resolved.status === 'multiple') {
        const lines = resolved.jobs.slice(0, 5).map((j, i) => `${i + 1}. ${j.customer_name} — ${toTitleCase(j.description)}`).join('\n');
        await setConversationState(business.id, {
          workflow: 'view_job_pick',
          focus: {},
          collected: { jobs: resolved.jobs.slice(0, 5) },
          pending: { type: 'selection', field: 'jobId' },
          options: resolved.jobs.slice(0, 5),
        });
        return twimlReply(res, `I found a few matches:\n${lines}\n\nReply with 1–${resolved.jobs.slice(0, 5).length}.`);
      }
      return twimlReply(res, `Can't find anything for "${intent.jobRef}" — say *jobs* to see what's on.`);
    }

    if (currentState?.workflow === 'view_job_pick') {
      const trimmed = body.trim();
      const jobs = currentState.collected?.jobs || [];
      if (/^(cancel|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'Cancelled.');
      }
      if (intent.kind === 'command') {
        await clearConversationState(business.id);
        return dispatch({ ...intent, business }, res);
      }
      if (jobs.length) {
        const n = parseInt(trimmed, 10);
        if (n >= 1 && n <= jobs.length) {
          await clearConversationState(business.id);
          return dispatch({ kind: 'query', intent: 'view_job', jobId: jobs[n - 1].id, business }, res);
        }
      }
      const resolved = await resolveSingleJobReference({ businessId: business.id, parsedIntent: { jobRef: trimmed }, raw: body, state: null, includeAll: true });
      if (resolved.status === 'resolved') {
        await clearConversationState(business.id);
        return dispatch({ kind: 'query', intent: 'view_job', jobId: resolved.job.id, business }, res);
      }
      return twimlReply(res, `Pick a number from the list above, or say *cancel*.`);
    }
    // --- End view job by name ---

    // --- Quoted list / Invoiced list context ---
    // Set after handleJobsByStatus so a bare name retrieves the document directly.
    if (currentState?.workflow === 'quoted_list' || currentState?.workflow === 'invoiced_list') {
      const trimmed = body.trim();
      const isInvoiced = currentState.workflow === 'invoiced_list';

      if (/^(cancel|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'No problem.');
      }

      // Chase/cancel with a name — clear context and let normal handler take over
      if ((intent.intent === 'chase' || intent.intent === 'cancel_job') && intent.jobRef) {
        await clearConversationState(business.id);
        return dispatch({ ...intent, business }, res);
      }

      // Any other new command — abandon list context
      if (intent.kind === 'command' && !['send_invoice', 'resend_quote'].includes(intent.intent)) {
        await clearConversationState(business.id);
        return dispatch({ ...intent, business }, res);
      }

      const customerName = extractCustomerName(trimmed);
      const resolved = await resolveSingleJobReference({
        businessId: business.id,
        parsedIntent: { jobRef: customerName },
        raw: body,
        state: null,
        includeAll: true,
      });

      if (resolved.status === 'resolved') {
        await clearConversationState(business.id);
        if (isInvoiced) {
          return dispatch({ kind: 'command', intent: 'send_invoice', jobId: resolved.job.id, business }, res);
        }
        return dispatch({ kind: 'command', intent: 'resend_quote', jobId: resolved.job.id, business }, res);
      }

      if (resolved.status === 'multiple') {
        const lines = resolved.jobs.slice(0, 5).map((j, i) => `${i + 1}. ${j.customer_name} — ${toTitleCase(j.description)}`).join('\n');
        await setConversationState(business.id, { ...currentState, collected: { jobs: resolved.jobs.slice(0, 5) } });
        return twimlReply(res, `Found a few matches:\n${lines}\n\nReply with a number.`);
      }

      await clearConversationState(business.id);
      return twimlReply(res, `Couldn't find that one — say *quotes* or *invoices* to see the full list.`);
    }
    // --- End quoted/invoiced list context ---

    // --- Invoice guided workflow ---
    // Triggered when: "invoice 14" — no amount provided.
    // Checks for existing quote and guides accordingly.
    if (!currentState && intent.intent === 'send_invoice' && intent.amount == null) {
      if (!intent.jobId) {
        const suggestion = await openJobsSuggestion(business.id);
        await setConversationState(business.id, {
          workflow: 'invoice_pick',
          focus: {},
          collected: {},
          pending: { type: 'field', field: 'jobRef' },
          options: [],
        });
        return twimlReply(res, suggestion
          ? `Who's this invoice for? Here's what's outstanding:\n\n${suggestion}\n\nOr type a name to start a new one.`
          : `Who's this invoice for? Type a name or say *open* to see what's on.`
        );
      }

      const job = await db.getJobWithCustomer(intent.jobId, business.id);
      if (!job) return twimlReply(res, `❌ Couldn't find that one.`);

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
          `Reply with 1, 2 or 3.`
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
          `2. Detailed — break it down (e.g. labour 250, parts 100)`
        );
      }
    }

    if (currentState?.workflow === 'invoice_guided') {
      const trimmed = body.trim();

      if (/^(cancel|no|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'No problem — invoice dropped.');
      }

      if (isWorkflowInterrupt(intent)) {
        await clearConversationState(business.id);
        return dispatch({ ...intent, business }, res);
      }

      // Has a quote — mode selection
      if (currentState.pending?.field === 'invoice_mode') {
        const n = parseInt(trimmed, 10);
        if (!n || n < 1 || n > 3) {
          return twimlReply(res, 'Reply with 1, 2 or 3.');
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
            `What do you want to change it to? It currently shows:`,
            currentItemsStr
          );
        }
        if (n === 3) {
          await setConversationState(business.id, {
            ...currentState,
            pending: { type: 'field', field: 'manual_amount' },
          });
          return twimlReply(res, 'What\'s the amount? You can also itemise — e.g. *service 250, parts 45*');
        }
      }

      // No quote — mode selection
      if (currentState.pending?.field === 'invoice_mode_new') {
        const n = parseInt(trimmed, 10);
        if (n !== 1 && n !== 2) {
          return twimlReply(res, 'Reply 1 for a quick invoice or 2 to break it down.');
        }
        if (n === 1) {
          await setConversationState(business.id, {
            ...currentState,
            pending: { type: 'field', field: 'manual_amount' },
          });
          return twimlReply(res, 'What\'s the amount?');
        } else {
          await setConversationState(business.id, {
            ...currentState,
            pending: { type: 'field', field: 'items' },
          });
          return twimlReply(res, 'List the items, separated by commas:\n\n*Boiler service 250, Parts 45, Callout fee 50*');
        }
      }

      // Amend existing invoice — re-dispatches to amend_invoice handler
      if (currentState.pending?.field === 'amend_existing_invoice') {
        let lineItems = parseLineItems(trimmed);
        if (lineItems && lineItems.length === 1 && /^total$/i.test(lineItems[0].description)) lineItems = null;
        const amount = lineItems ? lineItems.reduce((s, i) => s + i.amount, 0) : extractAmount(trimmed);
        if (amount == null) return twimlReply(res, 'What\'s the amount? (e.g. *450*, or itemised: *service 250, parts 45*)');
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'amend_invoice', jobId: currentState.focus.jobId, amount, items: lineItems ? trimmed : null, lineItems: lineItems || null, business }, res);
      }

      // Amend existing quote price — re-dispatches to quote handler
      if (currentState.pending?.field === 'amend_existing_quote') {
        let lineItems = parseLineItems(trimmed);
        if (lineItems && lineItems.length === 1 && /^total$/i.test(lineItems[0].description)) lineItems = null;
        const amount = lineItems ? lineItems.reduce((s, i) => s + i.amount, 0) : extractAmount(trimmed);
        if (amount == null) return twimlReply(res, 'What\'s the amount? (e.g. *450*, or itemised: *service 250, parts 45*)');
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'quote', jobId: currentState.focus.jobId, amount, items: lineItems ? trimmed : null, lineItems: lineItems || null, business }, res);
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
        const amount = extractAmount(trimmed);
        if (amount == null) return twimlReply(res, 'What\'s the amount? (e.g. *450*, or itemised: *service 250, parts 45*)');
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'send_invoice', jobId: currentState.focus.jobId, amount, items: null, lineItems: null, business }, res);
      }

      // Collect itemised line items
      if (currentState.pending?.field === 'items') {
        const lineItems = parseLineItems(trimmed);
        if (!lineItems) {
          return twimlReply(res, "Couldn't read those items — make sure each one has a description and a price:\n*Boiler service 250, Parts 45*");
        }
        const amount = lineItems.reduce((sum, i) => sum + i.amount, 0);
        await clearConversationState(business.id);
        return dispatch({ kind: 'command', intent: 'send_invoice', jobId: currentState.focus.jobId, amount, items: trimmed, lineItems, business }, res);
      }

      await clearConversationState(business.id);
      return twimlReply(res, 'No problem — invoice dropped.');
    }
    // --- End invoice guided workflow ---

    const trimmed = body.trim();

    // --- Amend with context ---
    // Handles "amend" with no job ID. If quote_focus is active (just sent a quote),
    // use that job. Otherwise save amend_pending and ask which job.
    // Must run before the workflow engine, which would otherwise dispatch amend_quote
    // directly to handleQuote and bypass this routing logic.
    if ((intent.intent === 'amend_invoice' || intent.intent === 'amend_quote') && !intent.jobId) {
      const focusJobId = (currentState?.workflow === 'quote_focus' || currentState?.workflow === 'invoice_focus') ? currentState.focus?.jobId : null;
      if (focusJobId) {
        await clearConversationState(business.id);
        return routeAmend(focusJobId, business, res);
      }
      const suggestion = await openJobsSuggestion(business.id);
      await setConversationState(business.id, {
        workflow: 'amend_pending',
        focus: {},
        collected: {},
        pending: { type: 'field', field: 'jobRef' },
        options: [],
      });
      return twimlReply(res, suggestion
        ? `Which quote did you want to change? Here's what you've got open:\n\n${suggestion}`
        : `Which quote did you want to change? Say *jobs* to see what's on.`
      );
    }

    if (currentState?.workflow === 'amend_pending') {
      if (/^(cancel|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'Cancelled.');
      }
      const resolved = await resolveSingleJobReference({ businessId: business.id, parsedIntent: { jobRef: trimmed }, raw: body, state: null });
      if (resolved.status === 'resolved') {
        await clearConversationState(business.id);
        return routeAmend(resolved.job.id, business, res);
      }
      if (resolved.status === 'multiple') {
        const lines = resolved.jobs.slice(0, 5).map((j, i) => `${i + 1}. ${j.customer_name} — ${toTitleCase(j.description)}`).join('\n');
        await setConversationState(business.id, {
          workflow: 'amend_pending',
          focus: {},
          collected: { jobs: resolved.jobs.slice(0, 5) },
          pending: { type: 'selection', field: 'jobId' },
          options: resolved.jobs.slice(0, 5),
        });
        return twimlReply(res, `Found a few matches:\n${lines}\n\nReply with 1–${resolved.jobs.slice(0, 5).length}.`);
      }
      if (currentState.pending?.type === 'selection') {
        const jobs = currentState.collected?.jobs || [];
        const n = parseInt(trimmed, 10);
        if (n >= 1 && n <= jobs.length) {
          await clearConversationState(business.id);
          return routeAmend(jobs[n - 1].id, business, res);
        }
        return twimlReply(res, `Pick a number from the list above.`);
      }
      return twimlReply(res, `Can't find anything for "${trimmed}" — say *jobs* if you want to see what's on.`);
    }
    // --- End amend with context ---

    // --- Feedback pending ---
    if (currentState?.workflow === 'feedback_pending') {
      await clearConversationState(business.id);
      const recentMessages = await db.getRecentMessages(business.id, 5);
      await db.saveFeedback(business.id, trimmed, recentMessages.reverse());
      return twimlReply(res, `Thanks — feedback noted! 👍`);
    }
    // --- End feedback pending ---

    // --- Morning briefing workflow ---
    // User replies with a number from the morning briefing to chase or mark paid.
    if (currentState?.workflow === 'morning_briefing') {
      const n = parseInt(trimmed, 10);
      const items = currentState.collected?.items || [];
      const item = items.find(i => i.n === n);

      if (!item) {
        // Not a number — let natural language fall through to normal dispatch
        await clearConversationState(business.id);
        return dispatch({ ...intent, business }, res);
      }

      await clearConversationState(business.id);

      if (item.type === 'invoice_due' || item.type === 'invoice_overdue') {
        return dispatch({ kind: 'command', intent: 'chase', jobId: item.jobId, business }, res);
      }

      if (item.type === 'stale_quote') {
        return dispatch({ kind: 'command', intent: 'quote', jobId: item.jobId, amount: null, business }, res);
      }
    }
    // --- End morning briefing workflow ---

    // --- Amend menu workflow ---
    if (currentState?.workflow === 'amend_menu') {
      if (/^(cancel|back|exit|quit)$/i.test(trimmed)) {
        await clearConversationState(business.id);
        return twimlReply(res, 'Cancelled.');
      }

      const { jobId: amendJobId, customerId, hasInvoice } = currentState.collected || {};

      // Resends the quote or invoice PDF after a field has been updated.
      const resendDocument = async () => {
        const updatedJob = await db.getJobWithCustomer(amendJobId, business.id);
        await clearConversationState(business.id);
        if (hasInvoice) {
          return dispatch({ kind: 'command', intent: 'send_invoice', jobId: amendJobId, business }, res);
        }
        return dispatch({
          kind: 'command', intent: 'quote',
          jobId: amendJobId,
          amount: Number(updatedJob.quoted_amount),
          items: updatedJob.quote_items || null,
          lineItems: updatedJob.quote_line_items_json || null,
          business,
        }, res);
      };

      if (currentState.pending?.field === 'choose') {
        const n = parseInt(trimmed, 10);
        if (!n || n < 1 || n > 4) {
          return twimlReply(res, `Pick a number from the list above.`);
        }
        if (n === 1) {
          await clearConversationState(business.id);
          return routeAmendPrice(amendJobId, business, res);
        }
        const prompts = {
          2: { field: 'description',      question: `What's the new scope of work?` },
          3: { field: 'customer_name',    question: `What's the new customer name?` },
          4: { field: 'customer_address', question: `What's the new address?\n\nReply *skip* to clear it.` },
        };
        const p = prompts[n];
        await setConversationState(business.id, { ...currentState, pending: { type: 'field', field: p.field } });
        return twimlReply(res, p.question);
      }

      if (currentState.pending?.field === 'description') {
        await db.updateJob(amendJobId, business.id, { description: trimmed });
        return resendDocument();
      }

      if (currentState.pending?.field === 'customer_name') {
        await db.updateCustomer(customerId, business.id, { name: trimmed });
        return resendDocument();
      }

      if (currentState.pending?.field === 'customer_address') {
        const address = /^skip$/i.test(trimmed) ? null : trimmed;
        await db.updateCustomer(customerId, business.id, { address });
        if (!address) {
          await clearConversationState(business.id);
          return twimlReply(res, `✅ Address cleared.`);
        }
        return resendDocument();
      }

      await clearConversationState(business.id);
      return twimlReply(res, 'Cancelled.');
    }
    // --- End amend menu workflow ---

    // amend_quote with a job ID but no amount — show the amend menu
    if (intent.intent === 'amend_quote' && intent.jobId && intent.amount == null) {
      return routeAmend(intent.jobId, business, res);
    }

    // --- Invoice with no job ID and active state ---
    // Handles "invoice" / "create an invoice" when a focus or other state is active,
    // which would otherwise fall through to the workflow engine with no jobId.
    if (intent.intent === 'send_invoice' && !intent.jobId && !intent.jobRef && intent.amount == null) {
      await clearConversationState(business.id);
      const suggestion = await openJobsSuggestion(business.id);
      await setConversationState(business.id, {
        workflow: 'invoice_pick',
        focus: {},
        collected: {},
        pending: { type: 'field', field: 'jobRef' },
        options: [],
      });
      return twimlReply(res, suggestion
        ? `Who's this invoice for? Here's what you've got open:\n\n${suggestion}\n\nOr type a name to start a new one.`
        : `Who's this invoice for? Say *open* to see what's on, or type a name.`
      );
    }

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
      const completedIntent = workflowResult.intent;

      if (workflowResult.clearState === false) {
        // leave existing state for out-of-band help/query handling
      } else if (workflowResult.state) {
        await setConversationState(business.id, workflowResult.state);
      } else {
        await clearConversationState(business.id);
      }

      return dispatch({ ...completedIntent, business }, res);
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

function toTitleCase(str) {
  return str.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// Shows the amend menu — user picks what they want to change.
async function routeAmend(jobId, business, res) {
  const job = await db.getJobWithCustomer(jobId, business.id);
  if (!job) return twimlReply(res, `Couldn't find that one — say *jobs* to see what's on.`);

  const invoice = await db.getInvoiceByJob(job.id, business.id);
  if (invoice?.status === 'PAID') {
    return twimlReply(res, `❌ ${job.customer?.name || 'That one'} is already paid — can't amend it.`);
  }
  if (!job.quoted_amount && !invoice) {
    return twimlReply(res, `No quote on file for ${job.customer?.name || 'that one'} yet — send one first and then you can amend it.`);
  }

  await setConversationState(business.id, {
    workflow: 'amend_menu',
    focus: { jobId: job.id },
    collected: { jobId: job.id, customerId: job.customer.id, hasInvoice: !!invoice },
    pending: { type: 'selection', field: 'choose' },
    options: [],
  });

  return twimlReply(res,
    `*${toTitleCase(job.description)}* — ${job.customer.name}\n\n` +
    `What would you like to change?\n\n` +
    `1. Price / items\n` +
    `2. Scope of work\n` +
    `3. Customer name\n` +
    `4. Customer address\n\n` +
    `Pick a number from the list above, or say *cancel* to dismiss.`
  );
}

// Routes directly to price/items amendment (skips menu — used when option 1 is selected).
async function routeAmendPrice(jobId, business, res) {
  const job = await db.getJobWithCustomer(jobId, business.id);
  if (!job) return twimlReply(res, `Couldn't find that one.`);

  const invoice = await db.getInvoiceByJob(job.id, business.id);
  if (invoice) {
    const currentItemsStr = formatItemsForCopy(invoice.line_items_json, invoice.line_items, invoice.amount);
    await setConversationState(business.id, {
      workflow: 'invoice_guided',
      focus: { jobId: job.id },
      collected: { jobId: job.id },
      pending: { type: 'field', field: 'amend_existing_invoice' },
      options: [],
    });
    return twimlReplyPair(res, `What do you want to change it to? It currently shows:`, currentItemsStr);
  }

  const currentItemsStr = formatItemsForCopy(job.quote_line_items_json, job.quote_items, job.quoted_amount);
  await setConversationState(business.id, {
    workflow: 'invoice_guided',
    focus: { jobId: job.id },
    collected: {
      jobId: job.id,
      quoted_amount: Number(job.quoted_amount),
      quote_items: job.quote_items || null,
      quote_line_items_json: job.quote_line_items_json || null,
    },
    pending: { type: 'field', field: 'amend_existing_quote' },
    options: [],
  });
  return twimlReplyPair(res, `What do you want to change it to? It currently shows:`, currentItemsStr);
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

// ---------------------------------------------------------------------------
// Onboarding flow
// ---------------------------------------------------------------------------

const ONBOARDING_STEPS = [
  { key: 'business_name', label: 'Business name', required: true, prompt: `What's your business name?` },
];

const ONBOARDING_WELCOME = `*Welcome to The Foreman 👋*

Free WhatsApp assistant for tradespeople — send quotes and invoices, track jobs and chase payments, all from this chat.

No app to download, no subscription.`;

async function handleOnboarding({ business, body, mediaUrl, res }) {
  const trimmed = (body || '').trim();
  const state = await getConversationState(business.id);
  const step = state?.collected?.onboardingStep || 0;

  // First ever message — send welcome and first question as two separate messages
  if (!state || state.workflow !== 'onboarding') {
    await setConversationState(business.id, {
      workflow: 'onboarding',
      focus: {},
      collected: { onboardingStep: 0 },
      pending: { type: 'field', field: 'onboarding' },
      options: [],
    });
    sendToForeman(ONBOARDING_STEPS[0].prompt, { businessId: business.id, businessPhone: business.phone })
      .catch(err => console.error('Failed to send onboarding follow-up:', err));
    return twimlReply(res, ONBOARDING_WELCOME);
  }

  const current = ONBOARDING_STEPS[step];
  const isSkip = /^skip$/i.test(trimmed);

  // Handle skip (not allowed for required steps)
  if (isSkip && current.required) {
    return twimlReply(res, `This one's needed to get you set up — ${current.prompt}`);
  }

  // Process the answer for the current step
  if (!isSkip) {
    if (current.key === 'bank') {
      // Bank is two-part — sort code first, then account number
      if (!state.collected.sortCode) {
        // Store sort code, re-prompt for account number
        await setConversationState(business.id, {
          ...state,
          collected: { ...state.collected, sortCode: trimmed },
        });
        return twimlReply(res, `Got it. And the account number?`);
      }
      // Have both — save and move on
      const paymentDetails = `Sort code: ${state.collected.sortCode}\nAccount number: ${trimmed}`;
      await db.updateBusiness(business.id, { payment_details: paymentDetails });

    } else if (current.key === 'payment_days') {
      const days = parseInt(trimmed, 10);
      if (isNaN(days) || days < 1 || days > 365) {
        return twimlReply(res, `Please enter a number between 1 and 365, or reply *skip* to use 14 days.`);
      }
      await db.updateBusiness(business.id, { payment_days: days });

    } else if (current.key === 'vat') {
      // Sub-step: if we already know they're VAT registered, this reply is the VAT number
      if (state.collected.vatRegistered) {
        await db.updateBusiness(business.id, { vat_number: trimmed });
        // Fall through to advance to next step
      } else {
        const isYes = /^(yes|y|yep|yeah)$/i.test(trimmed);
        const isNo = /^(no|n|nope|nah)$/i.test(trimmed);
        if (!isYes && !isNo) {
          return twimlReply(res, `Reply *yes* if you're VAT registered, *no* if not, or *skip* to come back to this later.`);
        }
        await db.updateBusiness(business.id, { vat_registered: isYes, vat_number: null });
        if (isYes) {
          // Ask for VAT number before advancing
          await setConversationState(business.id, {
            ...state,
            collected: { ...state.collected, vatRegistered: true },
          });
          return twimlReply(res, `What's your VAT number?`);
        }
      }

    } else if (current.key === 'logo') {
      if (!mediaUrl) {
        return twimlReply(res, `Please send your logo as a photo, or reply *skip* to do this later.`);
      }
      try {
        const buffer = await downloadToBuffer(mediaUrl);
        const ext = detectImageExt(buffer);
        if (!ext) {
          return twimlReply(res, `❌ That file type isn't supported. Please send a JPEG or PNG, or reply *skip*.`);
        }
        const logoUrl = await uploadLogo(business.id, buffer, ext);
        await db.updateBusiness(business.id, { logo_path: logoUrl });
      } catch (err) {
        console.error('Onboarding logo upload failed:', err);
        return twimlReply(res, `❌ Couldn't save that image. Try again or reply *skip*.`);
      }

    } else {
      await db.updateBusiness(business.id, { [current.key]: trimmed });
    }
  }

  // Clear sub-step flags when advancing past their parent step
  const updatedCollected = { ...state.collected, onboardingStep: step + 1 };
  if (current.key === 'bank') delete updatedCollected.sortCode;
  if (current.key === 'vat') delete updatedCollected.vatRegistered;

  // Advance to next step
  const nextStep = step + 1;
  if (nextStep < ONBOARDING_STEPS.length) {
    await setConversationState(business.id, {
      workflow: 'onboarding',
      focus: {},
      collected: updatedCollected,
      pending: { type: 'field', field: 'onboarding' },
      options: [],
    });
    return twimlReply(res, ONBOARDING_STEPS[nextStep].prompt);
  }

  // All steps done — mark as onboarded
  await db.updateBusiness(business.id, { onboarded: true });
  await clearConversationState(business.id);
  return twimlReply(res, `You're all set 🎉 Whenever you're ready, just tell me what you need — quote, invoice, whatever it is.`);
}

// ---------------------------------------------------------------------------

function formatAddress(raw) {
  const titled = raw.trim().replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  // Ensure UK postcode at the end is fully uppercase
  return titled.replace(/([A-Za-z]{1,2}\d{1,2}[A-Za-z]?\s*\d[A-Za-z]{2})\s*$/i, m => m.toUpperCase());
}

// Extracts customer name (and optionally job description) from a parsed quote intent.
// Handles:
//   intent.jobRef set directly ("quote for Mrs Smith")
//   intent.items is a plain name ("quote Mrs Smith")
//   intent.items is a natural language sentence ("quote me a job for Mrs Smith to fit a kitchen")
function extractQuoteParts(intent) {
  if (intent.jobRef) {
    // Strip "a new customer/client" prefix — users often say "quote for a new customer John Smith..."
    const cleaned = intent.jobRef.replace(/^(?:a\s+)?new\s+(?:customer|client)\s+/i, '').trim();
    // Extract name (1–3 title-case words) before a verb or preposition like "wants", "needs", "for", "who"
    const verbSplit = cleaned.match(/^([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,2})\s+(?:wants?|needs?|who\s|to\s|for\s)/i);
    if (verbSplit) {
      return { customerRef: verbSplit[1].trim(), prefilledDescription: cleaned.slice(verbSplit[0].length).trim() };
    }
    return { customerRef: cleaned, prefilledDescription: null };
  }

  if (!intent.items || parseLineItems(intent.items)) return { customerRef: null, prefilledDescription: null };

  const raw = intent.items;

  // "… for [Name] to [description]" — most common natural language form
  const forToMatch = raw.match(/\bfor\s+([A-Z][^\s]+(?:\s+[A-Z][^\s]+)*)\s+to\s+(.+)$/i);
  if (forToMatch) return { customerRef: forToMatch[1].trim(), prefilledDescription: forToMatch[2].trim() };

  // "… for [Name]" only
  const forOnlyMatch = raw.match(/\bfor\s+([A-Z][^\s]+(?:\s+[A-Z][^\s]+)*)$/i);
  if (forOnlyMatch) return { customerRef: forOnlyMatch[1].trim(), prefilledDescription: null };

  // Short phrase with no prepositions — treat as a customer name
  const words = raw.trim().split(/\s+/);
  if (words.length <= 3 && !/\b(for|the|a|an|to|with|and|job|quote|new|me)\b/i.test(raw)) {
    return { customerRef: raw.trim(), prefilledDescription: null };
  }

  return { customerRef: null, prefilledDescription: null };
}

async function createCustomerAndJob(businessId, collected) {
  let customer;
  if (collected.customerId) {
    customer = await db.getCustomer(collected.customerId, businessId);
    if (collected.address) {
      await db.updateCustomer(collected.customerId, businessId, { address: collected.address });
      customer = { ...customer, address: collected.address };
    }
  } else {
    customer = await db.findOrCreateCustomer(businessId, collected.customerName, collected.phone, null, collected.address || null);
  }
  const job = await db.createJob(businessId, customer.id, collected.description || 'Job');
  // Attach customer to job for use by handlers
  job.customer = customer;
  return { customer, job };
}



const WORKFLOW_INTENTS = new Set(['new_customer', 'new_job', 'quote', 'send_invoice', 'settings']);

function isWorkflowInterrupt(intent) {
  return intent?.kind === 'query' || (intent?.kind === 'command' && !WORKFLOW_INTENTS.has(intent.intent));
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
