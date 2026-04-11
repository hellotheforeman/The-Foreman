const db = require('./db');
const templates = require('./templates');
const messenger = require('./messenger');
const { generateQuotePdf, generateInvoicePdf, pdfUrl } = require('./pdf');

// --- Settings helpers (menu shown by handleSettings; flow processed in index.js) ---

const SETTINGS_FIELDS = [
  { key: 'business_name',  label: 'Business name' },
  { key: 'trade',          label: 'Trade' },
  { key: 'email',          label: 'Email' },
  { key: 'address',        label: 'Address' },
  { key: 'payment_details', label: 'Payment details' },
];

function buildSettingsMenu(business) {
  const lines = ['⚙️ *Business Settings*\n', 'Reply with a number to update:\n'];
  SETTINGS_FIELDS.forEach((s, i) => {
    const val = business[s.key];
    const display = val ? (val.length > 45 ? val.slice(0, 45) + '…' : val) : '_not set_';
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
  paid: handlePaid,
  send_invoice: handleSendInvoice,
  amend_invoice: handleAmend,
  chase: handleChase,
  review: handleReview,
  cancel_job: handleCancelJob,
  add_note: handleAddNote,
  update_customer: handleUpdateCustomer,
};

const queryHandlers = {
  view_schedule: handleViewSchedule,
  unpaid: handleUnpaid,
  open_jobs: handleOpenJobs,
  find: handleFind,
  earnings: handleEarnings,
  settings: handleSettings,
  help: handleHelp,
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

  const customer = await db.findOrCreateCustomer(business.id, intent.name, intent.phone, intent.postcode || null, intent.email || null);
  const details = [customer.phone, customer.postcode, customer.email].filter(Boolean).join(' · ');
  messenger.twimlReply(
    res,
    `👤 Customer saved\n\n` +
    `*${customer.name}*\n${details}\n\n` +
    `To add a job: *new job ${customer.name} ${customer.phone} [description]*`
  );
}

async function handleNewJob(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const customer = await db.findOrCreateCustomer(business.id, intent.name, intent.phone, intent.postcode, intent.email || null);
  const job = await db.createJob(business.id, customer.id, intent.description, intent.postcode);
  const details = [customer.phone, intent.postcode, customer.email].filter(Boolean).join(' · ');
  messenger.twimlReply(
    res,
    `✅ Job ${db.formatJobId(job.id)} created\n` +
    `👤 ${customer.name} — ${details}\n` +
    `🔧 ${job.description}\n\n` +
    `Next: *quote ${job.id} [amount] [description]*`
  );
}

async function handleQuote(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);

  await db.setQuote(job.id, intent.amount, intent.items, intent.lineItems || null);
  job.quoted_amount = intent.amount;
  job.quote_items = intent.items;
  job.quote_line_items_json = intent.lineItems || null;

  const total = Number(intent.amount).toFixed(2);

  try {
    const filename = await generateQuotePdf(job, job.customer, business);
    messenger.twimlReplyWithMedia(
      res,
      `📋 Quote ${db.formatJobId(job.id)} — £${total} for ${job.customer.name}\n\nForward this PDF to them on WhatsApp. When they accept, use *schedule ${job.id} [day] [time]* to book it in.`,
      pdfUrl(filename)
    );
  } catch (err) {
    console.error('Quote PDF generation failed:', err.message);
    const msg = templates.quoteMessage(job, job.customer, business);
    messenger.twimlReply(
      res,
      `📋 Quote ready for ${job.customer.name} (${job.customer.phone})\n\n${msg}\n\nWhen they accept, use *schedule ${job.id} [day] [time]* to book it in.`
    );
  }
}

async function handleSchedule(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);
  if (!intent.date) return messenger.twimlReply(res, `❌ Couldn't parse a date from "${intent.raw}". Try: *schedule ${intent.jobId} thursday 9am*`);

  await db.scheduleJob(job.id, intent.date, intent.time);
  job.scheduled_date = intent.date;
  job.scheduled_time = intent.time;

  const timeStr = intent.time || 'TBC';
  const msg = templates.scheduleConfirmation(job, job.customer, business);

  messenger.twimlReply(
    res,
    `📅 Booked: ${templates.formatDate(intent.date)} at ${timeStr}\n\n` +
    `Send this confirmation to ${job.customer.name} (${job.customer.phone}):\n` +
    `─────────────────\n` +
    `${msg}\n` +
    `─────────────────`
  );
}

async function handlePaid(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const invoice = await db.getInvoiceByJob(intent.jobId, business.id);
  if (!invoice) return messenger.twimlReply(res, `❌ No invoice found for job #${intent.jobId}.`);
  if (invoice.status === 'PAID') return messenger.twimlReply(res, `✅ Already marked as paid.`);

  await db.markInvoicePaid(invoice.id);
  messenger.twimlReply(res, `💰 Job ${db.formatJobId(intent.jobId)} — invoice marked as paid. Nice one!`);
}

async function handleSendInvoice(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);

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
        `❌ No amount set for job ${db.formatJobId(job.id)}.\n\nUse: *invoice ${job.id} 450 description*`
      );
    }

    invoice = await db.createInvoice(business.id, job.id, amount, lineItemsStr, lineItemsJson);
  }

  try {
    const filename = await generateInvoicePdf(job, invoice, job.customer, business);
    messenger.twimlReplyWithMedia(
      res,
      `🧾 Invoice for ${job.customer.name} — £${Number(invoice.amount).toFixed(2)}\n\nForward this PDF to them on WhatsApp. Reply *paid ${job.id}* when settled.`,
      pdfUrl(filename)
    );
  } catch (err) {
    console.error('Invoice PDF generation failed:', err.message);
    const msg = templates.invoiceMessage(job, invoice, job.customer, business);
    messenger.twimlReply(
      res,
      `🧾 Invoice for ${job.customer.name} (${job.customer.phone}):\n\n${msg}\n\nReply *paid ${job.id}* when settled.`
    );
  }
}

async function handleAmend(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ Job ${db.formatJobId(intent.jobId)} not found.`);

  const invoice = await db.getInvoiceByJob(job.id, business.id);
  if (!invoice) return messenger.twimlReply(res, `❌ No invoice found for job ${db.formatJobId(intent.jobId)}.`);
  if (invoice.status === 'PAID') return messenger.twimlReply(res, `❌ Invoice ${db.formatJobId(intent.jobId)} is already paid — can't amend it.`);

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
    const filename = await generateInvoicePdf(job, updatedInvoice, job.customer, business);
    messenger.twimlReplyWithMedia(
      res,
      `✅ Invoice ${db.formatJobId(job.id)} updated — £${Number(intent.amount).toFixed(2)}\n\nUpdated PDF attached. Reply *paid ${job.id}* when settled.`,
      pdfUrl(filename)
    );
  } catch (err) {
    console.error('Invoice PDF generation failed:', err.message);
    messenger.twimlReply(res, `✅ Invoice ${db.formatJobId(job.id)} updated — £${Number(intent.amount).toFixed(2)}`);
  }
}

async function handleChase(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);

  const invoice = await db.getInvoiceByJob(job.id, business.id);
  if (!invoice) return messenger.twimlReply(res, `❌ No invoice found for job ${db.formatJobId(job.id)}.`);
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
  if (!job) return messenger.twimlReply(res, `❌ Job ${db.formatJobId(intent.jobId)} not found.`);

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
  if (!job) return messenger.twimlReply(res, `❌ Job ${db.formatJobId(intent.jobId)} not found.`);
  if (!intent.date) return messenger.twimlReply(res, `❌ Couldn't parse a date. Try: *reschedule ${intent.jobId} thursday 9am*`);

  await db.scheduleJob(job.id, intent.date, intent.time);
  const timeStr = intent.time || 'TBC';
  const msg = templates.scheduleConfirmation({ ...job, scheduled_date: intent.date, scheduled_time: intent.time }, job.customer, business);

  messenger.twimlReply(
    res,
    `📅 Rescheduled: ${templates.formatDate(intent.date)} at ${timeStr}\n\n` +
    `Send this update to ${job.customer.name} (${job.customer.phone}):\n` +
    `─────────────────\n${msg}\n─────────────────`
  );
}

async function handleCancelJob(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJob(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ Job ${db.formatJobId(intent.jobId)} not found.`);
  if (job.status === 'cancelled') return messenger.twimlReply(res, `Job ${db.formatJobId(intent.jobId)} is already cancelled.`);

  await db.cancelJob(intent.jobId, business.id);
  messenger.twimlReply(res, `🚫 Job ${db.formatJobId(intent.jobId)} cancelled.`);
}

async function handleAddNote(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.appendJobNote(intent.jobId, business.id, intent.note);
  if (!job) return messenger.twimlReply(res, `❌ Job ${db.formatJobId(intent.jobId)} not found.`);

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

  if (intent.period === 'week') {
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

  if (intent.period === 'next_week') {
    // Advance to next Monday
    const daysUntilNextMonday = ((1 - now.getDay() + 7) % 7) || 7;
    const start = new Date(now);
    start.setDate(start.getDate() + daysUntilNextMonday);
    const startStr = start.toISOString().split('T')[0];
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const endStr = end.toISOString().split('T')[0];
    const jobs = await db.getScheduleRange(startStr, endStr, business.id);

    if (!jobs.length) return messenger.twimlReply(res, `Nothing scheduled next week. 📭`);

    const byDate = {};
    for (const j of jobs) {
      if (!byDate[j.scheduled_date]) byDate[j.scheduled_date] = [];
      byDate[j.scheduled_date].push(j);
    }
    const lines = Object.entries(byDate)
      .map(([d, js]) => templates.formatScheduleDay(js, d))
      .join('\n\n');

    return messenger.twimlReply(res, `*Next week:*\n\n${lines}`);
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
  } else if (intent.period === 'week') {
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
    `Invoiced: £${invoiced}\n` +
    `Paid:     £${paid}\n` +
    `Unpaid:   £${unpaid}`;

  if (overdue > 0) msg += `\nOverdue:  £${overdue.toFixed(2)}`;

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
    return `• ${db.formatJobId(j.id)} — ${j.customer_name}, ${j.description} [${db.deriveStatus(j)}]`;
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
    const jobs = await db.getAll('SELECT * FROM jobs WHERE business_id = $1 AND customer_id = $2 ORDER BY created_at DESC LIMIT 5', [business.id, c.id]);
    const jobLines = jobs.map((j) => {
      const amount = j.quoted_amount ? ` £${Number(j.quoted_amount).toFixed(2)}` : '';
      const status = db.deriveStatus(j);
      return `  - ${db.formatJobId(j.id)}: ${j.description}${amount} [${status}]`;
    });
    const contactParts = [c.phone, c.email, c.address || c.postcode].filter(Boolean);
    results.push(
      `👤 *${c.name}* — ${contactParts.join(' · ')}\n` +
      (jobLines.length ? jobLines.join('\n') : '  No jobs yet')
    );
  }

  messenger.twimlReply(res, results.join('\n\n'));
}

async function handleHelp(intent, res) {
  messenger.twimlReply(
    res,
    `🔨 *The Foreman*\n\n` +
    `*new customer* — add a customer\n` +
    `*new job* — add a job\n` +
    `*find* [name] — look up a customer\n\n` +
    `*quote* [job#] — send a quote\n` +
    `*schedule* [job#] [day] [time] — book a job\n` +
    `*invoice* [job#] — send an invoice\n` +
    `*amend* [job#] — update an unpaid invoice\n` +
    `*paid* [job#] — mark invoice as paid\n` +
    `*chase* [job#] — send payment reminder\n\n` +
    `*today* / *this week* — view schedule\n` +
    `*jobs* — open jobs\n` +
    `*unpaid* — outstanding invoices\n` +
    `*earnings* — income summary\n\n` +
    `*review* [job#] — request a review\n` +
    `*settings* — business settings\n` +
    `*help* — this message`
  );
}

async function handleConfirm(intent, res) {
  messenger.twimlReply(res, `Nothing is awaiting confirmation right now.`);
}

async function handleCancel(intent, res) {
  messenger.twimlReply(res, `Nothing to cancel right now.`);
}

async function handleUnknown(intent, res) {
  messenger.twimlReply(res, `🤔 Didn't catch that. Reply *help* for commands.`);
}

module.exports = { dispatch, SETTINGS_FIELDS, buildSettingsMenu };
