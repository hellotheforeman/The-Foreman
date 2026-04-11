const db = require('./db');
const templates = require('./templates');
const messenger = require('./messenger');

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
  new_job: handleNewJob,
  quote: handleQuote,
  schedule: handleSchedule,
  done: handleDone,
  paid: handlePaid,
  send_invoice: handleSendInvoice,
  chase: handleChase,
  follow_up: handleFollowUp,
};

const queryHandlers = {
  view_schedule: handleViewSchedule,
  unpaid: handleUnpaid,
  open_jobs: handleOpenJobs,
  find: handleFind,
  earnings: handleEarnings,
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

async function handleNewJob(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const customer = await db.findOrCreateCustomer(business.id, intent.name, intent.phone, intent.postcode);
  const job = await db.createJob(business.id, customer.id, intent.description, intent.postcode);
  const postcode = intent.postcode ? `, ${intent.postcode}` : '';
  messenger.twimlReply(
    res,
    `✅ Job ${db.formatJobId(job.id)} created\n` +
    `👤 ${customer.name} — ${customer.phone}${postcode}\n` +
    `🔧 ${job.description}\n\n` +
    `Next: *quote ${job.id} [amount] [description]*`
  );
}

async function handleQuote(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);

  await db.setQuote(job.id, intent.amount, intent.items);
  job.quoted_amount = intent.amount;
  job.quote_items = intent.items;

  const msg = templates.quoteMessage(job, job.customer, business);

  messenger.twimlReply(
    res,
    `📋 Quote ready for ${job.customer.name} (${job.customer.phone})\n\n` +
    `Copy and send this to them on WhatsApp:\n` +
    `─────────────────\n` +
    `${msg}\n` +
    `─────────────────\n\n` +
    `When they accept, use *schedule ${job.id} [day] [time]* to book it in.`
  );
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

async function handleDone(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);

  await db.completeJob(job.id, intent.notes);

  const amount = intent.amount != null ? Number(intent.amount) : (job.quoted_amount != null ? Number(job.quoted_amount) : null);
  if (amount == null || Number.isNaN(amount)) {
    return messenger.twimlReply(
      res,
      `✅ Job ${db.formatJobId(job.id)} marked complete.\n\n` +
      `No amount set — use *invoice ${job.id} [amount]* to generate the invoice.`
    );
  }

  const lineItems = intent.notes || job.quote_items || job.description;
  let invoice = await db.getInvoiceByJob(job.id, business.id);
  if (!invoice) {
    invoice = await db.createInvoice(business.id, job.id, amount, lineItems);
  }
  const msg = templates.invoiceMessage(job, invoice, job.customer, business);

  messenger.twimlReply(
    res,
    `✅ Job ${db.formatJobId(job.id)} complete — £${amount.toFixed(2)}\n\n` +
    `Send this invoice to ${job.customer.name} (${job.customer.phone}):\n` +
    `─────────────────\n` +
    `${msg}\n` +
    `─────────────────\n\n` +
    `Once paid, reply *paid ${job.id}*`
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
    if (!job.quoted_amount) {
      return messenger.twimlReply(res, `❌ No amount set for job ${db.formatJobId(job.id)}. Use *done ${job.id} total [amount]* first.`);
    }
    invoice = await db.createInvoice(business.id, job.id, job.quoted_amount, job.quote_items || job.description);
  }

  const msg = templates.invoiceMessage(job, invoice, job.customer, business);

  messenger.twimlReply(
    res,
    `🧾 Invoice for ${job.customer.name} (${job.customer.phone}):\n` +
    `─────────────────\n` +
    `${msg}\n` +
    `─────────────────\n\n` +
    `Copy and send this on WhatsApp. Reply *paid ${job.id}* when settled.`
  );
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

async function handleFollowUp(intent, res) {
  const business = requireBusiness(intent, res);
  if (!business) return;

  const job = await db.getJobWithCustomer(intent.jobId, business.id);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);

  const msg = templates.followUpMessage(job, job.customer, business);

  messenger.twimlReply(
    res,
    `⭐ Follow-up for ${job.customer.name} (${job.customer.phone}):\n` +
    `─────────────────\n` +
    `${msg}\n` +
    `─────────────────\n\n` +
    `Copy and send this on WhatsApp.`
  );
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

  const lines = jobs.map((j) => `• ${db.formatJobId(j.id)} — ${j.customer_name}, ${j.description} [${j.status.toLowerCase()}]`);
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
      return `  - ${db.formatJobId(j.id)}: ${j.description}${amount} [${j.status.toLowerCase()}]`;
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
    `*invoice* [job#]\n` +
    `*paid* [job#]\n` +
    `*chase* [job#]\n` +
    `*follow up* [job#]\n\n` +
    `*today* / *tomorrow* / *this week*\n` +
    `*unpaid* — outstanding invoices\n` +
    `*jobs* — open jobs\n` +
    `*find* [name] — customer lookup\n` +
    `*help* — this message\n\n` +
    `Messages are drafted for you to copy and send from your own WhatsApp. 📋`
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

module.exports = { dispatch };
