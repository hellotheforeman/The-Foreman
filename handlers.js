const db = require('./db');
const templates = require('./templates');
const messenger = require('./messenger');
const { generateQuotePdf, generateInvoicePdf } = require('./pdf');
const { setConversationState } = require('./conversation-state');

function toTitleCase(str) {
  return String(str).replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --- Settings helpers (menu shown by handleSettings; flow processed in index.js) ---

const SETTINGS_FIELDS = [
  { key: 'business_name',  label: 'Business name' },
  { key: 'trade',          label: 'Trade' },
  { key: 'email',          label: 'Email' },
  { key: 'address',        label: 'Address' },
  { key: 'payment_details', label: 'Bank details', type: 'bank' },
  { key: 'vat', label: 'VAT', type: 'vat' },
  { key: 'logo_path',      label: 'Logo', type: 'image', hint: 'Send your logo as a photo or image. It will appear on all your quotes and invoices.' },
  { key: 'payment_days',  label: 'Payment terms (days)', type: 'number' },
];

function buildSettingsMenu(business) {
  const lines = ['⚙️ *Business Settings*\n', 'Which one do you want to update?\n'];
  SETTINGS_FIELDS.forEach((s, i) => {
    let display;
    if (s.type === 'vat') {
      if (business.vat_registered) {
        display = business.vat_number ? `Registered — ${business.vat_number}` : 'Registered';
      } else {
        display = 'Not registered';
      }
    } else if (s.type === 'image') {
      display = business.logo_path ? '✅ uploaded' : '_not set_';
    } else if (s.type === 'number') {
      const val = business[s.key];
      display = (val !== null && val !== undefined && val !== '') ? `${val} days` : '_not set_';
    } else {
      const val = business[s.key];
      if (val === null || val === undefined || val === '') {
        display = '_not set_';
      } else {
        display = String(val).length > 45 ? String(val).slice(0, 45) + '…' : String(val);
      }
    }
    lines.push(`${i + 1}. ${s.label}: ${display}`);
  });
  lines.push('\nSay *cancel* to close.');
  return lines.join('\n');
}


function requireBusiness(intent, res) {
  if (!intent.business) {
    messenger.twimlReply(res, `You're not set up on The Foreman yet. Please contact us to get started.`);
    return null;
  }

  if (intent.business.status !== 'active') {
    messenger.twimlReply(res, `Your The Foreman account is ${intent.business.status}. We'll let you know when it's active.`);
    return null;
  }

  return intent.business;
}

/**
 * Option 2 design: The Foreman never messages customers directly.
 * Instead it drafts messages and returns them to the tradesperson,
 * ready to copy-paste into their own WhatsApp conversation.
 */

// --- Dispatch ---

const commandHandlers = {
  new_customer: handleNewCustomer,
  new_job: handleNewJob,
  quote: handleQuote,
  resend_quote: handleResendQuote,
  paid: handlePaid,
  send_invoice: handleSendInvoice,
  amend_quote: handleQuote,
  amend_invoice: handleAmend,
  chase: handleChase,
  review: handleReview,
  cancel_job: handleCancelJob,
  mark_complete: handleMarkComplete,
  add_note: handleAddNote,
  update_customer: handleUpdateCustomer,
  feedback: handleFeedback,
};

const queryHandlers = {
  unpaid: handleUnpaid,
  open_jobs: handleOpenJobs,
  jobs_by_status: handleJobsByStatus,
  view_job: handleViewJob,
  find: handleFind,
  list_customers: handleListCustomers,
  earnings: handleEarnings,
  financial_summary: handleFinancialSummary,
  conversion_rate: handleConversionRate,
  avg_payment_time: handleAvgPaymentTime,
  settings: handleSettings,
  help: handleHelp,
  pricing: handlePricing,
  greeting: handleGreeting,
  thanks: handleThanks,
};

const continuationHandlers = {
  confirm: handleConfirm,
  cancel: handleCancel,
};

async function dispatch(intent, res) {
  let handler = null;

  if (intent.kind === 'command') {
    handler = commandHandlers[intent.intent];
  } else if (intent.kind === 'query') {
    handler = queryHandlers[intent.intent];
  } else if (intent.kind === 'continuation') {
    handler = continuationHandlers[intent.intent];
  }

  if (!handler) return handleUnknown(intent, res);
  return handler(intent, res);
}

// --- Handlers ---

async function handleNewCustomer(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const customer = await db.findOrCreateCustomer(business.id, intent.name, intent.phone, intent.email || null);
  const details = [customer.phone, customer.email].filter(Boolean).join(' · ');
  messenger.twimlReply(
    res,
    `👤 Customer saved\n\n` +
    `*${customer.name}*\n${details}\n\n` +
    `To log a job for them, say: *new job ${customer.name} ${customer.phone} boiler service*`
  );
}

async function handleNewJob(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const customer = await db.findOrCreateCustomer(business.id, intent.name, intent.phone, intent.email || null);
  const job = await db.createJob(business.id, customer.id, intent.description, intent.postcode);
  const details = [customer.phone, customer.email].filter(Boolean).join(' · ');
  messenger.twimlReply(
    res,
    `✅ Added\n` +
    `👤 ${customer.name} — ${details}\n` +
    `🔧 ${toTitleCase(job.description)}\n\n` +
    `Let me know when you're ready to put a quote together.`
  );
}

function pendingSetupFields(business) {
  return ['trade', 'email', 'address', 'logo_path'].filter(f => !business[f]);
}

function hasProfileGaps(business) {
  return pendingSetupFields(business).length > 0;
}

async function handleQuote(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, await jobNotFoundMsg(intent.jobId, business));

  // Once an invoice exists, the quote fields are read-only — redirect to invoice amendment
  if (intent.intent === 'amend_quote') {
    const existingInvoice = await db.getInvoiceByJob(job.id, business.id);
    if (existingInvoice) {
      if (existingInvoice.status === 'PAID') {
        return messenger.twimlReply(res, `That invoice is already paid — nothing to amend.`);
      }
      // If they've supplied a new amount/items, apply it straight to the invoice
      if (intent.amount && Number(intent.amount) > 0) {
        return dispatch({ ...intent, intent: 'amend_invoice' }, res);
      }
      return messenger.twimlReply(res, `There's already an invoice out for ${job.customer.name} — use *amend invoice* to change it.`);
    }
  }

  if (!intent.amount || Number(intent.amount) <= 0) {
    return messenger.twimlReply(res, `That doesn't look right — what's the price?`);
  }

  const isReQuote = !!job.quoted_amount;

  await db.setQuote(job.id, intent.amount, intent.items, intent.lineItems || null);
  job.quoted_amount = intent.amount;
  job.quote_items = intent.items;
  job.quote_line_items_json = intent.lineItems || null;

  const net = Number(intent.amount);
  const displayTotal = business?.vat_registered ? (net * 1.20).toFixed(2) : net.toFixed(2);
  const vatSuffix = business?.vat_registered ? ' inc. VAT' : '';
  const label = isReQuote ? 'Re-quoted' : 'Quote';

  const shouldOfferSetup = !isReQuote && !business.profile_setup_prompted && hasProfileGaps(business);

  await setConversationState(business.id, shouldOfferSetup ? {
    workflow: 'profile_setup_offered',
    focus: {},
    collected: { fields: pendingSetupFields(business) },
    pending: { type: 'field', field: 'response' },
    options: [],
  } : {
    workflow: 'quote_focus',
    focus: { jobId: job.id },
    collected: {},
    pending: null,
    options: [],
  });

  if (shouldOfferSetup) {
    await db.markProfileSetupPrompted(business.id);
    messenger.sendToForeman(
      `Want to take 2 minutes to finish setting up your profile? It'll make your quotes and invoices look more professional — adding your trade, logo, email and address.\n\nReply *yes* to do it now, or *skip* to leave it for later.`,
      { businessId: business.id, businessPhone: business.phone }
    ).catch(err => console.error('Profile setup offer failed to send:', err.message));
  }

  try {
    const pdfUrl = await generateQuotePdf(job, job.customer, business);
    messenger.twimlReplyWithMedia(
      res,
      `📋 £${displayTotal}${vatSuffix} ${label.toLowerCase()} for ${job.customer.name} ready\n${pick(['Send it when you\'re happy 👍', 'Over to you — send when ready.', 'All done — fire it over when you\'re happy.'])}`,
      pdfUrl
    );
  } catch (err) {
    console.error('Quote PDF generation failed:', err.message);
    const msg = templates.quoteMessage(job, job.customer, business);
    messenger.twimlReply(
      res,
      `📋 £${displayTotal}${vatSuffix} ${label.toLowerCase()} for ${job.customer.name} ready\n\n${msg}\nSend it when you're happy 👍`
    );
  }
}

async function handleResendQuote(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, await jobNotFoundMsg(intent.jobId, business));

  if (!job.quoted_amount || Number(job.quoted_amount) <= 0) {
    return messenger.twimlReply(
      res,
      `No quote on file for ${job.customer.name}. To create one: *quote ${job.id} 450 description*`
    );
  }

  const net = Number(job.quoted_amount);
  const displayTotal = business?.vat_registered ? (net * 1.20).toFixed(2) : net.toFixed(2);
  const vatSuffix = business?.vat_registered ? ' inc. VAT' : '';

  try {
    const pdfUrl = await generateQuotePdf(job, job.customer, business);
    messenger.twimlReplyWithMedia(res, `📋 Here's ${job.customer.name}'s quote.`, pdfUrl);
  } catch (err) {
    console.error('Quote PDF regeneration failed:', err.message);
    const msg = templates.quoteMessage(job, job.customer, business);
    messenger.twimlReply(res, `📋 Here's ${job.customer.name}'s quote.\n\n${msg}`);
  }
}

async function handlePaid(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  if (!intent.jobId) {
    const allUnpaid = await db.getUnpaidInvoices(business.id);

    if (intent.name) {
      const nameLower = intent.name.toLowerCase();
      const matched = allUnpaid.filter(i => i.customer_name.toLowerCase().includes(nameLower));

      if (matched.length === 1) {
        const m = matched[0];
        const vatDisplay = business?.vat_registered ? (Number(m.amount) * 1.20).toFixed(2) : Number(m.amount).toFixed(2);
        await db.markInvoicePaid(m.id);
        return messenger.twimlReply(res, `💰 £${vatDisplay} from ${m.customer_name} marked as paid. ${pick(['Nice one!', 'Get in! 💪', 'That\'s the one. 👊', 'Lovely stuff.'])}`);
      }

      if (matched.length > 1) {
        const list = matched.map(i => `• ${i.customer_name} — £${Number(i.amount).toFixed(2)}`).join('\n');
        return messenger.twimlReply(res, `Which invoice for ${intent.name}?\n\n${list}`);
      }
    }

    if (!allUnpaid.length) return messenger.twimlReply(res, `No unpaid invoices. 🎉`);

    const list = allUnpaid.slice(0, 5)
      .map(i => `• ${i.customer_name} — £${Number(i.amount).toFixed(2)}`)
      .join('\n');
    return messenger.twimlReply(res, `Which invoice got paid?\n\n${list}`);
  }

  const invoice = await db.getInvoiceByJob(intent.jobId, business.id);
  if (!invoice) {
    const suggestion = await unpaidSuggestion(business.id);
    return messenger.twimlReply(res,
      suggestion
        ? `No invoice found. Here's what's outstanding:\n\n${suggestion}`
        : `No invoice found. Send one first with *invoice ${intent.jobId}*.`
    );
  }
  if (invoice.status === 'PAID') return messenger.twimlReply(res, `Already marked as paid.`);
  if (!['SENT', 'OVERDUE'].includes(invoice.status)) return messenger.twimlReply(res, `Can't mark that as paid right now.`);

  const paidJob = await db.getJobWithCustomer(intent.jobId, business.id);
  const paidVatDisplay = business?.vat_registered ? (Number(invoice.amount) * 1.20).toFixed(2) : Number(invoice.amount).toFixed(2);
  await db.markInvoicePaid(invoice.id);
  messenger.twimlReply(res, `💰 £${paidVatDisplay} from ${paidJob?.customer?.name || 'that one'} marked as paid. ${pick(['Nice one!', 'Get in! 💪', 'That\'s the one. 👊', 'Lovely stuff.'])}`);
}

async function handleSendInvoice(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, await jobNotFoundMsg(intent.jobId, business));

  // Gate: bank details required before creating an invoice
  if (!business.payment_details) {
    await setConversationState(business.id, {
      workflow: 'bank_gate',
      focus: {},
      collected: {
        pendingIntent: {
          kind: 'command', intent: 'send_invoice',
          jobId: intent.jobId, amount: intent.amount != null ? intent.amount : null,
          items: intent.items || null, lineItems: intent.lineItems || null,
        },
      },
      pending: { type: 'field', field: 'sort_code' },
      options: [],
    });
    return messenger.twimlReply(res, `Before I create this invoice — what's your sort code? (e.g. 12-34-56)\n\nYour customers need your bank details to pay you.`);
  }

  let invoice = await db.getInvoiceByJob(job.id, business.id);
  const isNewInvoice = !invoice;
  if (!invoice) {
    let amount, lineItemsStr, lineItemsJson;

    if (intent.amount != null) {
      if (Number(intent.amount) <= 0) {
        return messenger.twimlReply(res, `That doesn't look right — what's the price?`);
      }
      amount = intent.amount;
      lineItemsStr = intent.items || null;
      lineItemsJson = intent.lineItems || null;
    } else if (job.quoted_amount) {
      amount = job.quoted_amount;
      lineItemsStr = job.quote_items || job.description;
      lineItemsJson = job.quote_line_items_json || null;
    } else {
      return messenger.twimlReply(
        res,
        `❌ No amount set for ${job.customer?.name || 'that one'}.\n\nUse: *invoice ${job.id} 450 description*`
      );
    }

    invoice = await db.createInvoice(business.id, job.id, amount, lineItemsStr, lineItemsJson);
  }

  const shouldOfferSetup = isNewInvoice && !business.profile_setup_prompted && hasProfileGaps(business);

  await setConversationState(business.id, shouldOfferSetup ? {
    workflow: 'profile_setup_offered',
    focus: {},
    collected: { fields: pendingSetupFields(business) },
    pending: { type: 'field', field: 'response' },
    options: [],
  } : {
    workflow: 'invoice_focus',
    focus: { jobId: job.id },
    collected: {},
    pending: null,
    options: [],
  });

  if (shouldOfferSetup) {
    await db.markProfileSetupPrompted(business.id);
    messenger.sendToForeman(
      `Want to take 2 minutes to finish setting up your profile? It'll make your quotes and invoices look more professional — adding your trade, logo, email and address.\n\nReply *yes* to do it now, or *skip* to leave it for later.`,
      { businessId: business.id, businessPhone: business.phone }
    ).catch(err => console.error('Profile setup offer failed to send:', err.message));
  }

  const invNet = Number(invoice.amount);
  const invDisplay = business?.vat_registered ? (invNet * 1.20).toFixed(2) : invNet.toFixed(2);
  const invVatSuffix = business?.vat_registered ? ' inc. VAT' : '';

  const invoiceCaption = isNewInvoice
    ? `🧾 £${invDisplay}${invVatSuffix} invoice for ${job.customer.name} ready\n${pick(['Let me know when they\'ve paid up.', 'Send it over and let me know when the money lands.', 'Over to you — shout when it\'s paid.'])}`
    : `🧾 Here's ${job.customer.name}'s invoice.`;

  try {
    const pdfUrl = await generateInvoicePdf(job, invoice, job.customer, business);
    messenger.twimlReplyWithMedia(res, invoiceCaption, pdfUrl);
  } catch (err) {
    console.error('Invoice PDF generation failed:', err.message, err.cause || '');
    const msg = templates.invoiceMessage(job, invoice, job.customer, business);
    messenger.twimlReply(res, isNewInvoice
      ? `🧾 £${invDisplay}${invVatSuffix} invoice for ${job.customer.name} ready\n\n${msg}\n\n${pick(['Let me know when they\'ve paid up.', 'Send it over and let me know when the money lands.', 'Over to you — shout when it\'s paid.'])}`
      : `🧾 Here's ${job.customer.name}'s invoice.\n\n${msg}`
    );
  }
}

async function handleAmend(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, await jobNotFoundMsg(intent.jobId, business));

  const invoice = await db.getInvoiceByJob(job.id, business.id);
  if (!invoice) {
    const suggestion = await unpaidSuggestion(business.id);
    return messenger.twimlReply(res,
      suggestion
        ? `No invoice found. Here's what's outstanding:\n\n${suggestion}`
        : `No invoice found. Send one first with *invoice ${intent.jobId}*.`
    );
  }
  if (invoice.status === 'PAID') return messenger.twimlReply(res, `❌ That invoice is already paid — can't amend it.`);

  if (intent.amount == null || Number(intent.amount) <= 0) {
    return messenger.twimlReply(
      res,
      `❌ Couldn't parse an amount. Try:\n• *amend ${intent.jobId} 450 description*\n• *amend ${intent.jobId} service 250 | parts 45*`
    );
  }

  await db.updateInvoice(job.id, business.id, {
    amount: intent.amount,
    line_items: intent.items || null,
    line_items_json: intent.lineItems || null,
  });

  // Re-fetch so we have db-generated fields; keep line_items_json from intent
  // so the PDF uses the structured array rather than whatever the DB returns
  const updatedInvoice = await db.getInvoiceByJob(job.id, business.id);
  if (intent.lineItems) updatedInvoice.line_items_json = intent.lineItems;

  const net = Number(intent.amount);
  const displayTotal = business?.vat_registered ? (net * 1.20).toFixed(2) : net.toFixed(2);
  const vatSuffix = business?.vat_registered ? ' inc. VAT' : '';

  try {
    const pdfUrl = await generateInvoicePdf(job, updatedInvoice, job.customer, business);
    messenger.twimlReplyWithMedia(
      res,
      `🧾 £${displayTotal}${vatSuffix} invoice for ${job.customer.name} updated\n\nUpdated PDF attached. Let me know when they've paid up.`,
      pdfUrl
    );
  } catch (err) {
    console.error('Invoice PDF generation failed:', err.message);
    messenger.twimlReply(res, `🧾 £${displayTotal}${vatSuffix} invoice for ${job.customer.name} updated`);
  }
}

async function handleChase(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  if (!intent.jobId) {
    const ref = intent.jobRef || intent.name;
    if (ref) {
      const allUnpaid = await db.getUnpaidInvoices(business.id);
      const nameLower = ref.toLowerCase();
      const matched = allUnpaid.filter(i => i.customer_name.toLowerCase().includes(nameLower));

      if (matched.length === 1) {
        const m = matched[0];
        const job = await db.getJobWithCustomer(m.job_id, business.id);
        const invoice = await db.getInvoiceByJob(job.id, business.id);
        const msg = templates.paymentReminder(job, invoice, job.customer, business);
        return messenger.twimlReplyPair(res,
          `Here's a reminder you can send to ${job.customer.name}:`,
          msg
        );
      }

      if (matched.length > 1) {
        const list = matched.map(i => `• ${i.customer_name} — £${Number(i.amount).toFixed(2)}`).join('\n');
        return messenger.twimlReply(res, `Which invoice for ${ref}?\n\n${list}`);
      }
    }
    return messenger.twimlReply(res, await jobNotFoundMsg(intent.jobId, business));
  }

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, await jobNotFoundMsg(intent.jobId, business));

  const invoice = await db.getInvoiceByJob(job.id, business.id);
  if (!invoice) return messenger.twimlReply(res, `No invoice found for ${job.customer.name}. Send one first.`);
  if (invoice.status === 'PAID') return messenger.twimlReply(res, `✅ ${job.customer.name} is already paid.`);

  const msg = templates.paymentReminder(job, invoice, job.customer, business);
  messenger.twimlReplyPair(res, `Here's a reminder for ${job.customer.name} — forward it over when you're ready:`, msg);
}

async function handleReview(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, await jobNotFoundMsg(intent.jobId, business));

  const msg = templates.reviewRequestMessage(job, job.customer, business);

  messenger.twimlReply(
    res,
    `⭐ Here's a review request for ${job.customer.name}${job.customer.phone ? ` (${job.customer.phone})` : ''}:\n` +
    `─────────────────\n` +
    `${msg}\n` +
    `─────────────────\n\n` +
    `Forward that over to them when you get a chance.`
  );
}

async function handleCancelJob(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  if (!intent.jobId && intent.jobRef) {
    const openJobs = await db.getOpenJobs(business.id);
    const ref = intent.jobRef.toLowerCase();
    const matched = openJobs.filter(j =>
      j.customer_name.toLowerCase().includes(ref) ||
      j.description.toLowerCase().includes(ref)
    );
    if (!matched.length) {
      return messenger.twimlReply(res, `Can't find an open quote or invoice for "${intent.jobRef}".`);
    }
    if (matched.length > 1) {
      const list = matched.slice(0, 5).map((j, i) => `${i + 1}. ${j.customer_name} — ${toTitleCase(j.description)}`).join('\n');
      return messenger.twimlReply(res, `Found a few matches — which one did you mean?\n\n${list}\n\nBe more specific, e.g. *cancel quote for ${matched[0].customer_name}*.`);
    }
    await db.cancelJob(matched[0].id, business.id);
    return messenger.twimlReply(res, `Dropped — ${matched[0].customer_name} won't show up in future reminders.`);
  }

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, await jobNotFoundMsg(intent.jobId, business));
  if (job.status === 'cancelled') return messenger.twimlReply(res, `That one's already cancelled.`);

  await db.cancelJob(intent.jobId, business.id);
  const name = job.customer?.name || 'that one';
  messenger.twimlReply(res, `Dropped — ${name} won't show up in future reminders.`);
}

async function handleAddNote(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.appendJobNote(intent.jobId, business.id, intent.note);
  if (!job) return messenger.twimlReply(res, await jobNotFoundMsg(intent.jobId, business));

  messenger.twimlReply(res, `📝 Got it — note saved on ${job?.customer?.name || 'that one'}.`);
}

async function handleSettings(intent, res) {
  // Just shows the menu — state management handled in index.js
  const business = requireBusiness(intent, res);
  if (!business) return;
  messenger.twimlReply(res, buildSettingsMenu(business));
}

async function handleUpdateCustomer(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const customers = await db.findCustomerByName(business.id, intent.customerName);
  if (!customers.length) return messenger.twimlReply(res, `❌ No customer found matching "${intent.customerName}".`);

  const customer = customers[0];
  const updated = await db.updateCustomer(customer.id, business.id, { [intent.field]: intent.value });
  if (!updated) return messenger.twimlReply(res, `❌ Couldn't update that field.`);

  messenger.twimlReply(res, `✅ Updated ${customer.name}'s ${intent.field}: ${intent.value}`);
}

function resolvePeriod(period) {
  const now = new Date();
  const end = new Date(now); end.setHours(23, 59, 59, 999);

  // "last_3_months", "last_90_days", "last_2_weeks" etc.
  const lastNMatch = (period || '').match(/^last_(\d+)_(day|week|month|year)s?$/);
  if (lastNMatch) {
    const n = parseInt(lastNMatch[1], 10);
    const unit = lastNMatch[2];
    const start = new Date(now);
    if (unit === 'day') start.setDate(start.getDate() - n);
    else if (unit === 'week') start.setDate(start.getDate() - n * 7);
    else if (unit === 'month') start.setMonth(start.getMonth() - n);
    else if (unit === 'year') start.setFullYear(start.getFullYear() - n);
    start.setHours(0, 0, 0, 0);
    const label = `Last ${n} ${unit}${n !== 1 ? 's' : ''}`;
    return { start, end, label };
  }

  if (period === 'yesterday') {
    const start = new Date(now); start.setDate(start.getDate() - 1); start.setHours(0, 0, 0, 0);
    const yesterdayEnd = new Date(now); yesterdayEnd.setDate(yesterdayEnd.getDate() - 1); yesterdayEnd.setHours(23, 59, 59, 999);
    return { start, end: yesterdayEnd, label: 'Yesterday' };
  }
  if (period === 'today') {
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    return { start, end, label: 'Today' };
  }
  if (period === 'week' || period === 'this_week') {
    const daysToMonday = (now.getDay() + 6) % 7;
    const start = new Date(now); start.setDate(start.getDate() - daysToMonday); start.setHours(0, 0, 0, 0);
    return { start, end, label: 'This week' };
  }
  if (period === 'year') {
    const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    return { start, end, label: 'This year' };
  }
  // month (default)
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  return { start, end, label: 'This month' };
}

function vatScale(business) {
  return business?.vat_registered ? 1.20 : 1;
}

async function handleEarnings(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const { start, end, label } = resolvePeriod(intent.period);
  const summary = await db.getEarningsSummary(business.id, start.toISOString(), end.toISOString());
  const vat = vatScale(business);
  const vatSuffix = business?.vat_registered ? ' inc. VAT' : '';

  const invoiced = (Number(summary.total_invoiced) * vat).toFixed(2);
  const paid     = (Number(summary.total_paid)     * vat).toFixed(2);
  const unpaid   = (Number(summary.total_unpaid)   * vat).toFixed(2);
  const overdue  =  Number(summary.total_overdue)  * vat;

  let msg =
    `💰 *${label}*\n\n` +
    `In the bank:    £${paid}${vatSuffix}\n` +
    `Waiting for:    £${unpaid}${vatSuffix}\n` +
    `Total invoiced: £${invoiced}${vatSuffix}`;

  if (overdue > 0) {
    msg += `\n\n⚠️ £${overdue.toFixed(2)}${vatSuffix} is overdue (over ${business.payment_days || 14} days). Say *unpaid* to see who owes you.`;
  }

  messenger.twimlReply(res, msg);
}

async function handleFinancialSummary(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const { start, end, label } = resolvePeriod(intent.period);
  const startIso = start.toISOString();
  const endIso = end.toISOString();

  const [earnings, unpaidInvoices, quotesOut, conversion, paymentTime] = await Promise.all([
    db.getEarningsSummary(business.id, startIso, endIso),
    db.getUnpaidInvoices(business.id),
    db.getQuotesOutstandingValue(business.id),
    db.getConversionRate(business.id, startIso, endIso),
    db.getAvgPaymentTime(business.id, startIso, endIso),
  ]);

  const vat = vatScale(business);
  const vatSuffix = business?.vat_registered ? ' inc. VAT' : '';

  const paid = (Number(earnings.total_paid) * vat).toFixed(2);
  const owed = (unpaidInvoices.reduce((sum, i) => sum + Number(i.amount), 0) * vat).toFixed(2);
  const quotesValue = (Number(quotesOut.total_value) * vat).toFixed(2);
  const quotesCount = Number(quotesOut.count);

  const totalJobs = Number(conversion.total_jobs);
  const convertedJobs = Number(conversion.converted_jobs);
  const conversionStr = totalJobs >= 3
    ? `${convertedJobs} of ${totalJobs} quotes converted (${Math.round((convertedJobs / totalJobs) * 100)}%)`
    : totalJobs > 0 ? `${convertedJobs} of ${totalJobs} quotes converted (too few for a reliable rate)`
    : 'No jobs in this period';

  const sampleSize = Number(paymentTime.sample_size);
  const avgDays = paymentTime.avg_days ? Math.round(Number(paymentTime.avg_days)) : null;
  const paymentTimeStr = sampleSize >= 3 && avgDays !== null
    ? `Your customers typically pay in ${avgDays} day${avgDays === 1 ? '' : 's'}`
    : sampleSize > 0 ? `${avgDays} days average (only ${sampleSize} payment${sampleSize === 1 ? '' : 's'} — keep an eye on this)`
    : 'No payments received in this period';

  const lines = [
    `📊 *${label}*\n`,
    `💰 Collected: £${paid}${vatSuffix}`,
    `⏳ Outstanding: £${owed}${vatSuffix}`,
    `📋 Quotes out: ${quotesCount > 0 ? `${quotesCount} worth £${quotesValue}${vatSuffix}` : 'none'}`,
    ``,
    `📈 Conversion: ${conversionStr}`,
    `⏱ Payment time: ${paymentTimeStr}`,
  ];

  messenger.twimlReply(res, lines.join('\n'));
}

async function handleConversionRate(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const { start, end, label } = resolvePeriod(intent.period);
  const data = await db.getConversionRate(business.id, start.toISOString(), end.toISOString());

  const total = Number(data.total_jobs);
  const converted = Number(data.converted_jobs);

  if (total === 0) {
    return messenger.twimlReply(res, `No jobs in ${label.toLowerCase()} to calculate a conversion rate.`);
  }

  const rate = Math.round((converted / total) * 100);
  const caveat = total < 3 ? ` (only ${total} job${total === 1 ? '' : 's'} — too few for a reliable figure)` : '';

  messenger.twimlReply(res,
    `📈 *Conversion rate — ${label}*\n\n` +
    `${converted} of ${total} quotes converted into invoices — *${rate}%*${caveat}.`
  );
}

async function handleAvgPaymentTime(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const { start, end, label } = resolvePeriod(intent.period);
  const data = await db.getAvgPaymentTime(business.id, start.toISOString(), end.toISOString());

  const sample = Number(data.sample_size);

  if (sample === 0) {
    return messenger.twimlReply(res, `No payments received in ${label.toLowerCase()} to calculate an average.`);
  }

  const avgDays = Math.round(Number(data.avg_days));
  const caveat = sample < 3 ? `\n\n_Only ${sample} payment${sample === 1 ? '' : 's'} in this period — add more data for a reliable figure._` : '';
  const paymentDays = business.payment_days || 14;
  const vsTerms = avgDays <= paymentDays
    ? `That's within your ${paymentDays}-day terms. 👍`
    : `That's ${avgDays - paymentDays} day${avgDays - paymentDays === 1 ? '' : 's'} over your ${paymentDays}-day terms.`;

  messenger.twimlReply(res,
    `⏱ *Average time to get paid — ${label}*\n\n` +
    `*${avgDays} day${avgDays === 1 ? '' : 's'}* on average across ${sample} payment${sample === 1 ? '' : 's'}.\n\n` +
    `${vsTerms}${caveat}`
  );
}

async function handleUnpaid(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const invoices = await db.getUnpaidInvoices(business.id);
  if (!invoices.length) return messenger.twimlReply(res, `No unpaid invoices. 🎉`);

  const vat = vatScale(business);
  const vatSuffix = business?.vat_registered ? ' inc. VAT' : '';
  const total = invoices.reduce((sum, i) => sum + Number(i.amount), 0) * vat;
  const lines = invoices.map((i) => {
    const days = Math.floor((Date.now() - new Date(i.sent_at).getTime()) / 86400000);
    return `• ${i.customer_name} — £${(Number(i.amount) * vat).toFixed(2)}${vatSuffix}, sent ${days} day${days === 1 ? '' : 's'} ago`;
  });

  messenger.twimlReply(
    res,
    `💷 *${invoices.length} unpaid — £${total.toFixed(2)}${vatSuffix} outstanding*\n\n${lines.join('\n\n')}\n\nI'll let you know as soon as anything goes overdue.`
  );
}

async function handleOpenJobs(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const jobs = await db.getOpenJobs(business.id);
  if (!jobs.length) return messenger.twimlReply(res, `Nothing open right now. 📭`);

  const lines = jobs.map((j) => {
    const desc = toTitleCase(j.description);
    const summary = desc.length > 40 ? desc.slice(0, 40).trimEnd() + '…' : desc;
    return `• ${j.customer_name} — ${summary} (${db.deriveStatus(j)})`;
  });
  messenger.twimlReply(res, `📋 *Open (${jobs.length})*\n\n${lines.join('\n')}`);
}

async function handleListCustomers(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const offset = intent.offset || 0;
  const [{ customers, hasMore }, total] = await Promise.all([
    db.listCustomers(business.id, { limit: 10, offset }),
    db.countCustomers(business.id),
  ]);

  if (!customers.length) return messenger.twimlReply(res, `No customers yet. Add one with *new customer*.`);

  const lines = customers.map((c) => `• ${c.name}${c.phone ? ` — ${c.phone}` : ''}`);
  const showing = offset + customers.length;
  const header = offset === 0
    ? `👥 *Your customers (${total} total):*`
    : `👥 *Customers ${offset + 1}–${showing} of ${total}:*`;

  const footer = hasMore
    ? `\nReply *more customers* to see the next 10, or search by name with *find [name]*.`
    : `\nSearch by name with *find [name]*.`;

  messenger.twimlReply(res, `${header}\n\n${lines.join('\n')}${footer}`);
}

async function handleFind(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const customers = await db.findCustomerByName(business.id, intent.query);
  if (!customers.length) return messenger.twimlReply(res, `No customers found matching "${intent.query}".`);

  const results = [];
  for (const c of customers.slice(0, 5)) {
    const jobs = await db.getAll(
      `SELECT j.*, COALESCE(i.amount, j.quoted_amount) AS latest_amount
       FROM jobs j
       LEFT JOIN invoices i ON i.job_id = j.id
       WHERE j.business_id = $1 AND j.customer_id = $2
       ORDER BY j.created_at DESC LIMIT 5`,
      [business.id, c.id]
    );
    const jobLines = jobs.map((j) => {
      const amount = j.latest_amount ? ` £${Number(j.latest_amount).toFixed(2)}` : '';
      const status = db.deriveStatus(j);
      const date = formatShortDate(j.sort_date);
      return `  - ${date} ${toTitleCase(j.description)}${amount} (${status})`;
    });
    const contactParts = [c.phone, c.email, c.address].filter(Boolean);
    results.push(
      `👤 *${c.name}* — ${contactParts.join(' · ')}\n` +
      (jobLines.length ? jobLines.join('\n') : '  No jobs yet')
    );
  }

  messenger.twimlReply(res, results.join('\n\n'));
}

async function handleViewJob(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, await jobNotFoundMsg(intent.jobId, business));

  const invoice = await db.getInvoiceByJob(intent.jobId, business.id);

  const c = job.customer;
  const lines = [`*${job.customer.name} — ${toTitleCase(job.description)}*`];

  const contactParts = [c.phone, c.email, c.address].filter(Boolean);
  lines.push(`${c.name}${contactParts.length ? ' · ' + contactParts.join(' · ') : ''}`);
  lines.push('');
  lines.push(`Status: ${db.deriveStatus(job)}`);

  if (job.quoted_amount) {
    const items = job.quote_items ? ` (${formatLineItemsText(job.quote_items)})` : '';
    lines.push(`Quoted: £${Number(job.quoted_amount).toFixed(2)}${items}`);
  }

  lines.push('');
  if (invoice) {
    const invStatus = invoice.status === 'PAID' ? 'Paid ✅' : invoice.status === 'OVERDUE' ? 'Overdue ⚠️' : 'Sent, awaiting payment';
    lines.push(`🧾 *Invoice — ${invStatus}*`);
    if (invoice.line_items) {
      lines.push(formatLineItemsText(invoice.line_items));
    }
    lines.push(`Total: £${Number(invoice.amount).toFixed(2)}`);
  } else {
    lines.push('🧾 Invoice: Not sent');
  }

  if (job.notes) {
    lines.push('');
    lines.push(`📝 ${job.notes}`);
  }

  messenger.twimlReply(res, lines.join('\n'));
}

async function handleJobsByStatus(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const jobs = await db.getJobsByStatus(business.id, intent.status);
  const label = intent.status.charAt(0).toUpperCase() + intent.status.slice(1);

  if (!jobs.length) return messenger.twimlReply(res, `Nothing ${intent.status} right now. 📭`);

  const lines = jobs.map((j) => {
    const desc = toTitleCase(j.description);
    const summary = desc.length > 40 ? desc.slice(0, 40).trimEnd() + '…' : desc;
    if (intent.status === 'quoted') {
      const days = j.created_at ? Math.floor((Date.now() - new Date(j.created_at).getTime()) / 86400000) : null;
      const amount = j.quoted_amount ? ` — £${Number(j.quoted_amount).toFixed(2)}` : '';
      const datePart = days !== null ? ` (${days} day${days === 1 ? '' : 's'} ago)` : '';
      return `• ${j.customer_name} — ${summary}${amount}${datePart}`;
    }
    return `• ${j.customer_name} — ${summary}`;
  });

  const footer = intent.status === 'quoted'
    ? '\n\nLet me know if you want to chase or cancel any of these.'
    : '';

  messenger.twimlReply(res, `📋 *${label} (${jobs.length})*\n\n${lines.join('\n')}${footer}`);
}

async function handleMarkComplete(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, await jobNotFoundMsg(intent.jobId, business));
  if (job.status === 'paid') return messenger.twimlReply(res, `${job.customer.name} is already paid.`);
  if (job.status === 'cancelled') return messenger.twimlReply(res, `❌ ${job.customer.name} is cancelled.`);

  await db.markJobComplete(intent.jobId, business.id);
  messenger.twimlReply(
    res,
    `💰 ${job.customer.name} marked paid. ${pick(['Nice one!', 'Get in! 💪', 'That\'s the one. 👊', 'Lovely stuff.'])}\n\nIf the work went well, I can put together a review request — just ask.`
  );
}

async function handleGreeting(intent, res) {
  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  const replies = [
    `${timeGreeting} 👍 What do you need?`,
    `${timeGreeting}! What can I sort for you?`,
    `${timeGreeting} — what's on?`,
  ];
  messenger.twimlReply(res, replies[Math.floor(Math.random() * replies.length)]);
}

async function handleThanks(intent, res) {
  const replies = [
    `No problem. 👍`,
    `Any time.`,
    `You're welcome — shout if you need anything else.`,
    `Easy. Let me know when you need me.`,
  ];
  messenger.twimlReply(res, replies[Math.floor(Math.random() * replies.length)]);
}

async function handleFeedback(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  if (!intent.message) {
    await setConversationState(business.id, {
      workflow: 'feedback_pending',
      focus: {},
      collected: {},
      pending: { type: 'field', field: 'message' },
      options: [],
    });
    return messenger.twimlReply(res, `What's on your mind? Just type it.`);
  }

  const recentMessages = await db.getRecentMessages(business.id, 5);
  await db.saveFeedback(business.id, intent.message, recentMessages.reverse());
  messenger.twimlReply(res, `Thanks — feedback noted! 👍`);
}

async function handlePricing(intent, res) {
  messenger.twimlReply(
    res,
    `💷 *The Foreman is completely free.*\n\nNo subscription, no hidden charges.\n\nTo get started, just say *Quote*, *Invoice*, or *Help* to see everything it can do.`
  );
}

async function handleHelp(intent, res) {
  messenger.twimlReply(
    res,
    `🔨 *The Foreman*\n\n` +
    `Here's what I can help with:\n\n` +
    `*Quotes & invoices*\n` +
    `Send quotes and invoices as PDFs — just tell me the customer and the price. I'll guide you through the rest. You can itemise the work or give a single total.\n\n` +
    `*Getting paid*\n` +
    `Tell me when a job's been paid and I'll mark it off. If something's overdue, ask me to draft a payment reminder — you copy it and send it yourself.\n\n` +
    `*Your pipeline*\n` +
    `Check what's quoted, what's invoiced, and what you're still owed — any time.\n\n` +
    `*Earnings & stats*\n` +
    `Ask how much you've earned this week, month, or year. Or ask how's business for a fuller picture — what you're owed, quotes outstanding, conversion rate, and how quickly your customers pay.\n\n` +
    `*Settings*\n` +
    `Update your business name, bank details, VAT, logo, payment terms and more.\n\n` +
    `---\n` +
    `💬 Got a suggestion or something not working right? Just say *feedback* followed by your message — it goes straight to the team.`
  );
}

async function handleConfirm(intent, res) {
  messenger.twimlReply(res, `Nothing waiting on a confirmation from me right now.`);
}

async function handleCancel(intent, res) {
  messenger.twimlReply(res, `Nothing active to cancel right now.`);
}

async function handleUnknown(intent, res) {
  const replies = [
    `Not quite sure what you mean — try *help* to see what I can do.`,
    `Didn't get that one. Say *help* if you need a hand.`,
    `Not sure about that — try rephrasing, or say *help* to see your options.`,
  ];
  messenger.twimlReply(res, replies[Math.floor(Math.random() * replies.length)]);
}

// Builds a helpful "job not found" message with open jobs listed if available.
async function jobNotFoundMsg(jobId, business) {
  const suggestion = await openJobsSuggestion(business.id);
  return suggestion
    ? `Couldn't find that one. Here are your open ones:\n\n${suggestion}`
    : `Couldn't find that one. Say *jobs* to see what's on.`;
}

// Returns a formatted list of unpaid invoices, or null if none.
async function unpaidSuggestion(businessId) {
  const invoices = await db.getUnpaidInvoices(businessId);
  if (!invoices.length) return null;
  return invoices.slice(0, 5)
    .map(i => `• ${i.customer_name} — £${Number(i.amount).toFixed(2)}`)
    .join('\n');
}

// Returns a formatted list of open jobs, or null if none.
async function openJobsSuggestion(businessId) {
  const jobs = await db.getOpenJobs(businessId);
  if (!jobs.length) return null;
  return jobs.slice(0, 5)
    .map(j => {
      const desc = toTitleCase(j.description);
      const summary = desc.length > 40 ? desc.slice(0, 40).trimEnd() + '…' : desc;
      return `• ${j.customer_name} — ${summary}`;
    })
    .join('\n');
}

// Normalises stored line item strings for display: splits on | or ,, adds £ before amounts.
// "Labour 50 | parts 60" → "Labour £50, parts £60"
function formatLineItemsText(str) {
  if (!str) return str;
  return str
    .split(/\s*[|,]\s*/)
    .map(item => item.replace(/(\d+(?:\.\d{1,2})?)$/, '£$1').trim())
    .join(', ');
}

function formatShortDate(dateStr) {
  if (!dateStr) return '??-???-??';
  const d = new Date(dateStr);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  const year = String(d.getUTCFullYear()).slice(2);
  return `${day}-${month}-${year}`;
}

module.exports = { dispatch, SETTINGS_FIELDS, buildSettingsMenu, openJobsSuggestion };
