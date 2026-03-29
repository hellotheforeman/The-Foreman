const db = require('./db');
const templates = require('./templates');
const messenger = require('./messenger');
const config = require('./config');

/**
 * Pending actions awaiting tradesperson confirmation.
 * Keyed by "confirm" — only one pending action at a time.
 */
let pendingAction = null;

function setPending(action) {
  pendingAction = action;
}

function clearPending() {
  pendingAction = null;
}

function getPending() {
  return pendingAction;
}

// --- Handler map ---

const handlers = {
  new_job: handleNewJob,
  quote: handleQuote,
  schedule: handleSchedule,
  done: handleDone,
  paid: handlePaid,
  send_invoice: handleSendInvoice,
  chase: handleChase,
  follow_up: handleFollowUp,
  view_schedule: handleViewSchedule,
  unpaid: handleUnpaid,
  open_jobs: handleOpenJobs,
  find: handleFind,
  confirm: handleConfirm,
  cancel: handleCancel,
  help: handleHelp,
  unknown: handleUnknown,
};

async function dispatch(intent, res) {
  const handler = handlers[intent.intent];
  if (!handler) return handleUnknown(intent, res);
  return handler(intent, res);
}

// --- Handlers ---

async function handleNewJob(intent, res) {
  const customer = db.findOrCreateCustomer(intent.name, intent.phone, intent.postcode);
  const job = db.createJob(customer.id, intent.description, intent.postcode);
  const postcode = intent.postcode ? `, ${intent.postcode}` : '';
  messenger.twimlReply(
    res,
    `✅ Created job ${db.formatJobId(job.id)}\n` +
    `👤 ${customer.name} (${customer.phone})\n` +
    `🔧 ${job.description}${postcode}\n\n` +
    `Next: send a quote with\n` +
    `*quote ${job.id} [amount] [description]*`
  );
}

async function handleQuote(intent, res) {
  const job = db.getJobWithCustomer(intent.jobId);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);
  if (!job.customer) return messenger.twimlReply(res, `❌ Customer not found for job ${db.formatJobId(job.id)}.`);

  db.setQuote(job.id, intent.amount, intent.items);
  job.quoted_amount = intent.amount;
  job.quote_items = intent.items;

  const preview = templates.quoteMessage(job, job.customer);

  setPending({
    type: 'send_quote',
    jobId: job.id,
    customerId: job.customer.id,
    customerPhone: job.customer.phone,
    message: preview,
  });

  messenger.twimlReply(
    res,
    `📋 Quote for ${db.formatJobId(job.id)} — £${intent.amount.toFixed(2)}\n\n` +
    `Preview of message to ${job.customer.name}:\n\n` +
    `${preview}\n\n` +
    `Reply *yes* to send, or *no* to cancel.`
  );
}

async function handleSchedule(intent, res) {
  const job = db.getJobWithCustomer(intent.jobId);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);
  if (!intent.date) return messenger.twimlReply(res, `❌ Couldn't parse a date from "${intent.raw}". Try: *schedule ${intent.jobId} thursday 9am*`);

  db.scheduleJob(job.id, intent.date, intent.time);
  job.scheduled_date = intent.date;
  job.scheduled_time = intent.time;

  const preview = templates.scheduleConfirmation(job, job.customer);

  setPending({
    type: 'send_schedule',
    jobId: job.id,
    customerId: job.customer.id,
    customerPhone: job.customer.phone,
    message: preview,
  });

  const timeStr = intent.time || 'TBC';
  messenger.twimlReply(
    res,
    `📅 Job ${db.formatJobId(job.id)} scheduled: ${templates.formatDate(intent.date)} at ${timeStr}\n\n` +
    `Send confirmation to ${job.customer.name}?\n\n` +
    `Preview:\n${preview}\n\n` +
    `Reply *yes* to send, or *no* to skip.`
  );
}

async function handleDone(intent, res) {
  const job = db.getJobWithCustomer(intent.jobId);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);

  db.completeJob(job.id, intent.notes);

  const amount = intent.amount || job.quoted_amount;
  if (!amount) {
    messenger.twimlReply(
      res,
      `✅ Job ${db.formatJobId(job.id)} marked complete.\n\n` +
      `No amount specified. Send an invoice with:\n` +
      `*invoice ${job.id}* (if quote was set)\n` +
      `or *done ${job.id} total [amount]* to set the amount.`
    );
    return;
  }

  // Create invoice
  const lineItems = intent.notes || job.quote_items || job.description;
  const invoice = db.createInvoice(job.id, amount, lineItems);

  const preview = templates.invoiceMessage(job, invoice, job.customer);

  setPending({
    type: 'send_invoice',
    jobId: job.id,
    invoiceId: invoice.id,
    customerId: job.customer.id,
    customerPhone: job.customer.phone,
    message: preview,
  });

  messenger.twimlReply(
    res,
    `✅ Job ${db.formatJobId(job.id)} complete. Invoice: £${amount.toFixed(2)}\n\n` +
    `Send invoice to ${job.customer.name}?\n\n` +
    `Preview:\n${preview}\n\n` +
    `Reply *yes* to send, or *no* to skip.`
  );
}

async function handlePaid(intent, res) {
  const invoice = db.getInvoiceByJob(intent.jobId);
  if (!invoice) return messenger.twimlReply(res, `❌ No invoice found for job #${intent.jobId}.`);

  db.markInvoicePaid(invoice.id);
  messenger.twimlReply(res, `✅ Invoice for job ${db.formatJobId(intent.jobId)} marked as paid. 💰`);
}

async function handleSendInvoice(intent, res) {
  const job = db.getJobWithCustomer(intent.jobId);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);

  let invoice = db.getInvoiceByJob(job.id);
  if (!invoice) {
    const amount = job.quoted_amount;
    if (!amount) {
      return messenger.twimlReply(res, `❌ No invoice or quote amount for job ${db.formatJobId(job.id)}. Use *done ${job.id} total [amount]* first.`);
    }
    invoice = db.createInvoice(job.id, amount, job.quote_items || job.description);
  }

  const preview = templates.invoiceMessage(job, invoice, job.customer);

  setPending({
    type: 'send_invoice',
    jobId: job.id,
    invoiceId: invoice.id,
    customerId: job.customer.id,
    customerPhone: job.customer.phone,
    message: preview,
  });

  messenger.twimlReply(
    res,
    `Send invoice to ${job.customer.name}?\n\n` +
    `Preview:\n${preview}\n\n` +
    `Reply *yes* to send, or *no* to cancel.`
  );
}

async function handleChase(intent, res) {
  const job = db.getJobWithCustomer(intent.jobId);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);

  const invoice = db.getInvoiceByJob(job.id);
  if (!invoice) return messenger.twimlReply(res, `❌ No invoice found for job ${db.formatJobId(job.id)}.`);
  if (invoice.status === 'PAID') return messenger.twimlReply(res, `✅ Invoice for ${db.formatJobId(job.id)} is already paid.`);

  const preview = templates.paymentReminder(job, invoice, job.customer);

  setPending({
    type: 'send_chase',
    jobId: job.id,
    customerId: job.customer.id,
    customerPhone: job.customer.phone,
    message: preview,
  });

  messenger.twimlReply(
    res,
    `Send payment reminder to ${job.customer.name}?\n\n` +
    `Preview:\n${preview}\n\n` +
    `Reply *yes* to send, or *no* to cancel.`
  );
}

async function handleFollowUp(intent, res) {
  const job = db.getJobWithCustomer(intent.jobId);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);

  const preview = templates.followUpMessage(job, job.customer);

  setPending({
    type: 'send_followup',
    jobId: job.id,
    customerId: job.customer.id,
    customerPhone: job.customer.phone,
    message: preview,
  });

  messenger.twimlReply(
    res,
    `Send follow-up to ${job.customer.name}?\n\n` +
    `Preview:\n${preview}\n\n` +
    `Reply *yes* to send, or *no* to cancel.`
  );
}

async function handleConfirm(intent, res) {
  const action = getPending();
  if (!action) {
    return messenger.twimlReply(res, `Nothing pending to confirm. 🤷`);
  }

  clearPending();

  try {
    await messenger.sendToCustomer(action.customerPhone, action.message, {
      customerId: action.customerId,
      jobId: action.jobId,
    });
    messenger.twimlReply(res, `✅ Sent to customer.`);
  } catch (err) {
    messenger.twimlReply(res, `❌ Failed to send: ${err.message}`);
  }
}

async function handleCancel(intent, res) {
  if (getPending()) {
    clearPending();
    return messenger.twimlReply(res, `Cancelled. 👍`);
  }
  messenger.twimlReply(res, `Nothing to cancel.`);
}

async function handleViewSchedule(intent, res) {
  const now = new Date();
  let dateStr, endStr, label;

  if (intent.period === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    dateStr = d.toISOString().split('T')[0];
    const jobs = db.getScheduleForDate(dateStr);
    return messenger.twimlReply(res, `*Tomorrow:*\n${templates.formatScheduleDay(jobs, dateStr)}`);
  }

  if (intent.period === 'week') {
    const start = new Date(now);
    const end = new Date(now);
    end.setDate(end.getDate() + 7);
    dateStr = start.toISOString().split('T')[0];
    endStr = end.toISOString().split('T')[0];
    const jobs = db.getScheduleRange(dateStr, endStr);

    if (!jobs.length) return messenger.twimlReply(res, `Nothing scheduled this week. 📭`);

    // Group by date
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

  // Default: today
  dateStr = now.toISOString().split('T')[0];
  const jobs = db.getScheduleForDate(dateStr);
  messenger.twimlReply(res, `*Today:*\n${templates.formatScheduleDay(jobs, dateStr)}`);
}

async function handleUnpaid(intent, res) {
  const invoices = db.getUnpaidInvoices();
  if (!invoices.length) return messenger.twimlReply(res, `No unpaid invoices. 🎉`);

  const total = invoices.reduce((sum, i) => sum + i.amount, 0);
  const lines = invoices.map((i) => {
    const days = Math.floor((Date.now() - new Date(i.sent_at).getTime()) / 86400000);
    return `• ${db.formatJobId(i.job_id)} — ${i.customer_name}, £${i.amount.toFixed(2)} (${days}d ago)`;
  });

  messenger.twimlReply(
    res,
    `💷 *Unpaid invoices: ${invoices.length} (£${total.toFixed(2)})*\n\n${lines.join('\n')}\n\nUse *chase [job#]* to send a reminder.`
  );
}

async function handleOpenJobs(intent, res) {
  const jobs = db.getOpenJobs();
  if (!jobs.length) return messenger.twimlReply(res, `No open jobs. 📭`);

  const lines = jobs.map((j) => {
    const status = j.status.toLowerCase();
    return `• ${db.formatJobId(j.id)} — ${j.customer_name}, ${j.description} [${status}]`;
  });

  messenger.twimlReply(res, `📋 *Open jobs: ${jobs.length}*\n\n${lines.join('\n')}`);
}

async function handleFind(intent, res) {
  const customers = db.findCustomerByName(intent.query);
  if (!customers.length) return messenger.twimlReply(res, `No customers found matching "${intent.query}".`);

  const results = [];
  for (const c of customers.slice(0, 5)) {
    const jobs = db.getAll(
      'SELECT * FROM jobs WHERE customer_id = ? ORDER BY created_at DESC LIMIT 5',
      [c.id]
    );

    const jobLines = jobs.map((j) => {
      const status = j.status.toLowerCase();
      const amount = j.quoted_amount ? ` £${j.quoted_amount.toFixed(2)}` : '';
      return `  - ${db.formatJobId(j.id)}: ${j.description}${amount} [${status}]`;
    });

    results.push(
      `👤 *${c.name}* — ${c.phone}${c.postcode ? ', ' + c.postcode : ''}\n` +
      (jobLines.length ? jobLines.join('\n') : '  No jobs yet')
    );
  }

  messenger.twimlReply(res, results.join('\n\n'));
}

async function handleHelp(intent, res) {
  messenger.twimlReply(
    res,
    `🔨 *The Foreman — Commands*\n\n` +
    `*new job* [name] [phone] [description] [postcode]\n` +
    `*quote* [job#] [amount] [description]\n` +
    `*schedule* [job#] [day] [time]\n` +
    `*done* [job#] [notes] total [amount]\n` +
    `*invoice* [job#] — send invoice\n` +
    `*paid* [job#] — mark as paid\n` +
    `*chase* [job#] — send payment reminder\n` +
    `*follow up* [job#] — send thank-you\n\n` +
    `*today* / *tomorrow* / *this week*\n` +
    `*unpaid* — outstanding invoices\n` +
    `*jobs* — open/active jobs\n` +
    `*find* [name] — customer lookup\n` +
    `*help* — this message`
  );
}

async function handleUnknown(intent, res) {
  messenger.twimlReply(
    res,
    `🤔 Didn't catch that. Reply *help* to see available commands.`
  );
}

module.exports = { dispatch, getPending };
