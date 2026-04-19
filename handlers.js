const db = require('./db');
const templates = require('./templates');
const messenger = require('./messenger');
const { generateQuotePdf, generateInvoicePdf } = require('./pdf');

// --- Settings helpers (menu shown by handleSettings; flow processed in index.js) ---

const SETTINGS_FIELDS = [
  { key: 'business_name',  label: 'Business name' },
  { key: 'trade',          label: 'Trade' },
  { key: 'email',          label: 'Email' },
  { key: 'address',        label: 'Address' },
  { key: 'payment_details', label: 'Payment details' },
  { key: 'vat', label: 'VAT', type: 'vat' },
  { key: 'logo_path',      label: 'Logo', type: 'image', hint: 'Send your logo as a photo or image. It will appear on all your quotes and invoices.' },
];

function buildSettingsMenu(business) {
  const lines = ['⚙️ *Business Settings*\n', 'Reply with a number to update:\n'];
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
  lines.push('\nReply *cancel* to dismiss.');
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
  schedule: handleSchedule,
  reschedule: handleReschedule,
  add_block: handleAddBlock,
  paid: handlePaid,
  send_invoice: handleSendInvoice,
  amend_invoice: handleAmend,
  chase: handleChase,
  review: handleReview,
  cancel_job: handleCancelJob,
  mark_complete: handleMarkComplete,
  add_note: handleAddNote,
  update_customer: handleUpdateCustomer,
};

const queryHandlers = {
  view_schedule: handleViewSchedule,
  unpaid: handleUnpaid,
  open_jobs: handleOpenJobs,
  unscheduled_jobs: handleUnscheduledJobs,
  jobs_by_status: handleJobsByStatus,
  view_job: handleViewJob,
  find: handleFind,
  earnings: handleEarnings,
  settings: handleSettings,
  help: handleHelp,
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
    `✅ ${db.formatJobId(job.id)} created\n` +
    `👤 ${customer.name} — ${details}\n` +
    `🔧 ${job.description}\n\n` +
    `Ready to quote? Say *quote ${job.id}* and I'll walk you through it.`
  );
}

async function handleQuote(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);

  const isReQuote = !!job.quoted_amount;

  await db.setQuote(job.id, intent.amount, intent.items, intent.lineItems || null);
  job.quoted_amount = intent.amount;
  job.quote_items = intent.items;
  job.quote_line_items_json = intent.lineItems || null;

  const total = Number(intent.amount).toFixed(2);
  const label = isReQuote ? 'Re-quoted' : 'Quote';

  try {
    const pdfUrl = await generateQuotePdf(job, job.customer, business);
    messenger.twimlReplyWithMedia(
      res,
      `📋 ${label} ${db.formatJobId(job.id)} — £${total} for ${job.customer.name}\n\nGive me a shout when you want to get this booked in the calendar.`,
      pdfUrl
    );
  } catch (err) {
    console.error('Quote PDF generation failed:', err.message);
    const msg = templates.quoteMessage(job, job.customer, business);
    messenger.twimlReply(
      res,
      `📋 ${label} ready for ${job.customer.name} (${job.customer.phone})\n\n${msg}\n\nGive me a shout when you want to get this booked in the calendar.`
    );
  }
}

async function handleSchedule(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);
  if (!intent.date) return messenger.twimlReply(res, `❌ Couldn't parse a date from "${intent.raw}". Try: *schedule ${intent.jobId} thursday 9am*`);

  await db.addBookingBlock(job.id, business.id, intent.date, intent.time || null, intent.duration || null, intent.durationUnit || 'hours');

  const timePart = intent.time ? ` at ${intent.time}` : '';
  const durationStr = intent.duration ? ` for ${intent.duration} ${intent.durationUnit}` : '';

  messenger.twimlReply(
    res,
    `📅 Booked: ${templates.formatDate(intent.date)}${timePart}${durationStr}\n` +
    `${db.formatJobId(job.id)} — ${job.customer.name}, ${job.description}.`
  );
}

async function handleAddBlock(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);
  if (!intent.date) return messenger.twimlReply(res, `❌ Couldn't parse a date. Try: *and then friday at 9*`);

  await db.addBookingBlock(job.id, business.id, intent.date, intent.time || null, intent.duration || null, intent.durationUnit || 'hours');

  const timeStr = intent.time || 'TBC';
  const durationStr = intent.duration ? ` for ${intent.duration} ${intent.durationUnit}` : '';

  messenger.twimlReply(
    res,
    `📅 Block added: ${templates.formatDate(intent.date)} at ${timeStr}${durationStr}\n` +
    `${db.formatJobId(job.id)} — ${job.customer.name}.`
  );
}

async function handlePaid(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const invoice = await db.getInvoiceByJob(intent.jobId, business.id);
  if (!invoice) return messenger.twimlReply(res, `❌ No invoice found for job #${intent.jobId}.`);
  if (invoice.status === 'PAID') return messenger.twimlReply(res, `✅ Already marked as paid.`);

  await db.markInvoicePaid(invoice.id);
  messenger.twimlReply(res, `💰 ${db.formatJobId(intent.jobId)} — invoice marked as paid. Nice one!`);
}

async function handleSendInvoice(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);

  let invoice = await db.getInvoiceByJob(job.id, business.id);
  if (!invoice) {
    let amount, lineItemsStr, lineItemsJson;

    if (intent.amount != null) {
      // Amount given explicitly in command
      amount = intent.amount;
      lineItemsStr = intent.items || null;
      lineItemsJson = intent.lineItems || null;
    } else if (job.quoted_amount) {
      // Invoice from existing quote — copy quote data
      amount = job.quoted_amount;
      lineItemsStr = job.quote_items || job.description;
      lineItemsJson = job.quote_line_items_json || null;
    } else {
      return messenger.twimlReply(
        res,
        `❌ No amount set for ${db.formatJobId(job.id)}.\n\nUse: *invoice ${job.id} 450 description*`
      );
    }

    invoice = await db.createInvoice(business.id, job.id, amount, lineItemsStr, lineItemsJson);
  }

  try {
    const pdfUrl = await generateInvoicePdf(job, invoice, job.customer, business);
    messenger.twimlReplyWithMedia(
      res,
      `🧾 Invoice ${db.formatJobId(job.id)} — £${Number(invoice.amount).toFixed(2)} for ${job.customer.name}\n\nLet me know when they've paid up.`,
      pdfUrl
    );
  } catch (err) {
    console.error('Invoice PDF generation failed:', err.message);
    const msg = templates.invoiceMessage(job, invoice, job.customer, business);
    messenger.twimlReply(
      res,
      `🧾 Invoice ${db.formatJobId(job.id)} — £${Number(invoice.amount).toFixed(2)} for ${job.customer.name} (${job.customer.phone}):\n\n${msg}\n\nLet me know when they've paid up.`
    );
  }
}

async function handleAmend(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);

  const invoice = await db.getInvoiceByJob(job.id, business.id);
  if (!invoice) return messenger.twimlReply(res, `❌ No invoice found for ${db.formatJobId(intent.jobId)}.`);
  if (invoice.status === 'PAID') return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} is already paid — can't amend it.`);

  if (intent.amount == null) {
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

  // Re-fetch to get updated values with db-generated fields
  const updatedInvoice = await db.getInvoiceByJob(job.id, business.id);
  updatedInvoice.line_items_json = intent.lineItems || null;

  try {
    const pdfUrl = await generateInvoicePdf(job, updatedInvoice, job.customer, business);
    messenger.twimlReplyWithMedia(
      res,
      `✅ ${db.formatJobId(job.id)} updated — £${Number(intent.amount).toFixed(2)}\n\nUpdated PDF attached. Reply *paid ${job.id}* when settled.`,
      pdfUrl
    );
  } catch (err) {
    console.error('Invoice PDF generation failed:', err.message);
    messenger.twimlReply(res, `✅ ${db.formatJobId(job.id)} updated — £${Number(intent.amount).toFixed(2)}`);
  }
}

async function handleChase(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);

  const invoice = await db.getInvoiceByJob(job.id, business.id);
  if (!invoice) return messenger.twimlReply(res, `❌ No invoice found for ${db.formatJobId(job.id)}.`);
  if (invoice.status === 'PAID') return messenger.twimlReply(res, `✅ ${db.formatJobId(job.id)} is already paid.`);

  const msg = templates.paymentReminder(job, invoice, job.customer, business);

  messenger.twimlReply(
    res,
    `💷 Payment reminder for ${job.customer.name} (${job.customer.phone}):\n` +
    `─────────────────\n` +
    `${msg}\n` +
    `─────────────────\n\n` +
    `Copy and send this on WhatsApp.`
  );
}

async function handleReview(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);

  const msg = templates.reviewRequestMessage(job, job.customer, business);

  messenger.twimlReply(
    res,
    `⭐ Review request for ${job.customer.name} (${job.customer.phone}):\n` +
    `─────────────────\n` +
    `${msg}\n` +
    `─────────────────\n\n` +
    `Copy and send this on WhatsApp.`
  );
}

async function handleReschedule(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);
  if (!intent.date) return messenger.twimlReply(res, `❌ Couldn't parse a date. Try: *reschedule ${intent.jobId} thursday 9am*`);

  await db.clearBookingBlocks(job.id, business.id);
  await db.addBookingBlock(job.id, business.id, intent.date, intent.time || null, intent.duration || null, intent.durationUnit || 'hours');

  const timePart = intent.time ? ` at ${intent.time}` : '';
  const durationStr = intent.duration ? ` for ${intent.duration} ${intent.durationUnit}` : '';

  messenger.twimlReply(
    res,
    `📅 Rescheduled: ${templates.formatDate(intent.date)}${timePart}${durationStr}\n` +
    `${db.formatJobId(job.id)} — ${job.customer.name}, ${job.description}.`
  );
}

async function handleCancelJob(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJob(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);
  if (job.status === 'cancelled') return messenger.twimlReply(res, `${db.formatJobId(intent.jobId)} is already cancelled.`);

  await db.cancelJob(intent.jobId, business.id);
  messenger.twimlReply(res, `🚫 ${db.formatJobId(intent.jobId)} cancelled.`);
}

async function handleAddNote(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.appendJobNote(intent.jobId, business.id, intent.note);
  if (!job) return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);

  messenger.twimlReply(res, `📝 Note added to ${db.formatJobId(intent.jobId)}.`);
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

async function handleViewSchedule(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const now = new Date();

  if (intent.period === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    const dateStr = d.toISOString().split('T')[0];
    const jobs = await db.getScheduleForDate(dateStr, business.id);
    return messenger.twimlReply(res, `*Tomorrow:*\n${templates.formatScheduleDay(jobs, dateStr)}`);
  }

  if (intent.period === 'week' || intent.period === 'this_week') {
    const start = now.toISOString().split('T')[0];
    const end = new Date(now);
    end.setDate(end.getDate() + 7);
    const endStr = end.toISOString().split('T')[0];
    const jobs = await db.getScheduleRange(start, endStr, business.id);

    if (!jobs.length) return messenger.twimlReply(res, `Nothing scheduled this week. 📭`);

    const byDate = {};
    for (const j of jobs) {
      if (!byDate[j.scheduled_date]) byDate[j.scheduled_date] = [];
      byDate[j.scheduled_date].push(j);
    }
    const lines = Object.entries(byDate)
      .map(([d, js]) => templates.formatScheduleDay(js, d))
      .join('\n\n');

    return messenger.twimlReply(res, `*This week:*\n\n${lines}`);
  }

  if (intent.period === 'next_week' || intent.period === 'week_after_next' || intent.period === 'week_of') {
    let start;
    let label;
    if (intent.period === 'week_of') {
      start = new Date(intent.date);
      label = `Week of ${templates.formatDate(intent.date)}`;
    } else {
      const daysUntilNextMonday = ((1 - now.getDay() + 7) % 7) || 7;
      start = new Date(now);
      start.setDate(start.getDate() + daysUntilNextMonday + (intent.period === 'week_after_next' ? 7 : 0));
      label = intent.period === 'week_after_next' ? 'Week after next' : 'Next week';
    }
    const startStr = start.toISOString().split('T')[0];
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const endStr = end.toISOString().split('T')[0];
    const jobs = await db.getScheduleRange(startStr, endStr, business.id);

    if (!jobs.length) return messenger.twimlReply(res, `Nothing scheduled that week. 📭`);

    const byDate = {};
    for (const j of jobs) {
      if (!byDate[j.scheduled_date]) byDate[j.scheduled_date] = [];
      byDate[j.scheduled_date].push(j);
    }
    const lines = Object.entries(byDate)
      .map(([d, js]) => templates.formatScheduleDay(js, d))
      .join('\n\n');

    return messenger.twimlReply(res, `*${label}:*\n\n${lines}`);
  }

  if (intent.period === 'date') {
    const jobs = await db.getScheduleForDate(intent.date, business.id);
    return messenger.twimlReply(res, `*${templates.formatDate(intent.date)}:*\n${templates.formatScheduleDay(jobs, intent.date)}`);
  }

  const dateStr = now.toISOString().split('T')[0];
  const jobs = await db.getScheduleForDate(dateStr, business.id);
  messenger.twimlReply(res, `*Today:*\n${templates.formatScheduleDay(jobs, dateStr)}`);
}

async function handleEarnings(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const now = new Date();
  let start, end, label;

  if (intent.period === 'today') {
    start = new Date(now); start.setHours(0, 0, 0, 0);
    end = new Date(now); end.setHours(23, 59, 59, 999);
    label = 'Today';
  } else if (intent.period === 'week' || intent.period === 'this_week') {
    const daysToMonday = (now.getDay() + 6) % 7;
    start = new Date(now); start.setDate(start.getDate() - daysToMonday); start.setHours(0, 0, 0, 0);
    end = new Date(now); end.setHours(23, 59, 59, 999);
    label = 'This week';
  } else if (intent.period === 'year') {
    start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    end = new Date(now); end.setHours(23, 59, 59, 999);
    label = 'This year';
  } else {
    // month (default)
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end = new Date(now); end.setHours(23, 59, 59, 999);
    label = 'This month';
  }

  const summary = await db.getEarningsSummary(business.id, start.toISOString(), end.toISOString());

  const invoiced = Number(summary.total_invoiced).toFixed(2);
  const paid = Number(summary.total_paid).toFixed(2);
  const unpaid = Number(summary.total_unpaid).toFixed(2);
  const overdue = Number(summary.total_overdue);

  let msg =
    `💰 *${label}*\n\n` +
    `In the bank:    £${paid}\n` +
    `Waiting for:    £${unpaid}\n` +
    `Total invoiced: £${invoiced}`;

  if (overdue > 0) {
    msg += `\n\n⚠️ £${overdue.toFixed(2)} is overdue (over 14 days). Say *unpaid* to see who owes you.`;
  }

  messenger.twimlReply(res, msg);
}

async function handleUnpaid(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const invoices = await db.getUnpaidInvoices(business.id);
  if (!invoices.length) return messenger.twimlReply(res, `No unpaid invoices. 🎉`);

  const total = invoices.reduce((sum, i) => sum + Number(i.amount), 0);
  const lines = invoices.map((i) => {
    const days = Math.floor((Date.now() - new Date(i.sent_at).getTime()) / 86400000);
    return `• ${db.formatJobId(i.job_id)} — ${i.customer_name}, £${Number(i.amount).toFixed(2)} (${days}d)\n  → chase ${i.job_id}`;
  });

  messenger.twimlReply(
    res,
    `💷 *${invoices.length} unpaid — £${total.toFixed(2)} outstanding*\n\n${lines.join('\n\n')}`
  );
}

async function handleOpenJobs(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const jobs = await db.getOpenJobs(business.id);
  if (!jobs.length) return messenger.twimlReply(res, `No open jobs. 📭`);

  const lines = jobs.map((j) => {
    return `• ${db.formatJobId(j.id)} — ${j.customer_name}, ${j.description} (${db.deriveStatus(j)})`;
  });
  messenger.twimlReply(res, `📋 *${jobs.length} open jobs*\n\n${lines.join('\n')}`);
}

async function handleFind(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const customers = await db.findCustomerByName(business.id, intent.query);
  if (!customers.length) return messenger.twimlReply(res, `No customers found matching "${intent.query}".`);

  const results = [];
  for (const c of customers.slice(0, 5)) {
    const jobs = await db.getAll(
      `SELECT j.*, COALESCE(i.amount, j.quoted_amount) AS latest_amount,
              COALESCE(j.scheduled_date, j.created_at::date) AS sort_date
       FROM jobs j
       LEFT JOIN invoices i ON i.job_id = j.id
       WHERE j.business_id = $1 AND j.customer_id = $2
       ORDER BY COALESCE(j.scheduled_date, j.created_at::date) DESC LIMIT 5`,
      [business.id, c.id]
    );
    const jobLines = jobs.map((j) => {
      const amount = j.latest_amount ? ` £${Number(j.latest_amount).toFixed(2)}` : '';
      const status = db.deriveStatus(j);
      const date = formatShortDate(j.sort_date);
      return `  - ${date} ${db.formatJobId(j.id)}: ${j.description}${amount} (${status})`;
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
  if (!job) return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);

  const [blocks, invoice] = await Promise.all([
    db.getBookingBlocksForJob(intent.jobId, business.id),
    db.getInvoiceByJob(intent.jobId, business.id),
  ]);

  const c = job.customer;
  const lines = [`*${db.formatJobId(job.id)} — ${job.description}*`];

  const contactParts = [c.phone, c.email, c.address].filter(Boolean);
  lines.push(`${c.name}${contactParts.length ? ' · ' + contactParts.join(' · ') : ''}`);
  lines.push('');
  lines.push(`Status: ${db.deriveStatus(job)}`);

  if (job.quoted_amount) {
    const items = job.quote_items ? ` (${formatLineItemsText(job.quote_items)})` : '';
    lines.push(`Quoted: £${Number(job.quoted_amount).toFixed(2)}${items}`);
  }

  if (blocks.length) {
    lines.push('');
    lines.push('📅 *Booked:*');
    for (const b of blocks) {
      const isMultiDay = b.duration_unit === 'days' && b.duration > 1;
      const dateStr = isMultiDay
        ? `${templates.formatDate(b.start_date)} – ${templates.formatDate(b.end_date)}`
        : templates.formatDate(b.start_date);
      const time = b.start_time ? ` at ${b.start_time}` : '';
      const dur = isMultiDay ? ` (${b.duration} days)` : (b.duration ? ` (${b.duration} ${b.duration_unit})` : '');
      lines.push(`• ${dateStr}${time}${dur}`);
    }
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

  if (!jobs.length) return messenger.twimlReply(res, `No ${intent.status} jobs. 📭`);

  const lines = jobs.map((j) => `• ${db.formatJobId(j.id)} — ${j.customer_name}, ${j.description}`);
  messenger.twimlReply(res, `📋 *${label} jobs (${jobs.length})*\n\n${lines.join('\n')}`);
}

async function handleMarkComplete(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} not found.`);
  if (job.status === 'complete') return messenger.twimlReply(res, `${db.formatJobId(intent.jobId)} is already marked complete.`);
  if (job.status === 'cancelled') return messenger.twimlReply(res, `❌ ${db.formatJobId(intent.jobId)} is cancelled.`);

  await db.markJobComplete(intent.jobId, business.id);
  messenger.twimlReply(
    res,
    `✅ ${db.formatJobId(job.id)} marked complete — ${job.customer.name}, ${job.description}.\n\n` +
    `Reply *invoice ${job.id}* to send an invoice, or *review ${job.id}* to request a review.`
  );
}

async function handleUnscheduledJobs(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const jobs = await db.getUnscheduledJobs(business.id);
  if (!jobs.length) return messenger.twimlReply(res, `No unscheduled jobs. 📭`);

  const lines = jobs.map((j) => `• ${db.formatJobId(j.id)} — ${j.customer_name}, ${j.description} (${db.deriveStatus(j)})`);
  messenger.twimlReply(res, `📋 *${jobs.length} unscheduled jobs*\n\n${lines.join('\n')}`);
}

async function handleGreeting(intent, res) {
  messenger.twimlReply(res, `Alright 👍 What do you need?`);
}

async function handleThanks(intent, res) {
  messenger.twimlReply(res, `No problem. 👍`);
}

async function handleHelp(intent, res) {
  messenger.twimlReply(
    res,
    `🔨 *The Foreman — here's what I can do:*\n\n` +

    `*Customers & jobs*\n` +
    `Add a new job with *new job*, or just a customer with *new customer*. Look someone up with *find patel*. Full job detail with *job 4*.\n\n` +

    `*Quotes*\n` +
    `Ready to quote? Say *quote 4* and I'll walk you through it — one price or a full breakdown. Need to tweak it? Just say *quote 4* again.\n\n` +

    `*Scheduling*\n` +
    `Book a job in with *schedule 4 thursday 9am*. Multi-day? Add *and then friday*. Shift it with *reschedule 4 monday*. See what's on with *today*, *tomorrow*, or *this week*.\n\n` +

    `*Invoicing & payments*\n` +
    `Send an invoice with *invoice 4*. Update it before paying with *amend 4*. Mark it paid with *paid 4*, or send a nudge with *chase 4*.\n\n` +

    `*Pipeline*\n` +
    `*jobs* — everything open. *unscheduled* — not yet booked. *unpaid* — waiting to be paid. *earnings* — how you're doing this month.\n\n` +

    `*Finishing up*\n` +
    `Mark a job done with *complete 4*, request a review with *review 4*, update your business details with *settings*.`
  );
}

async function handleConfirm(intent, res) {
  messenger.twimlReply(res, `Nothing is awaiting confirmation right now.`);
}

async function handleCancel(intent, res) {
  messenger.twimlReply(res, `Nothing to cancel right now.`);
}

async function handleUnknown(intent, res) {
  messenger.twimlReply(res, `Didn't quite catch that — try rephrasing.`);
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

module.exports = { dispatch, SETTINGS_FIELDS, buildSettingsMenu };
