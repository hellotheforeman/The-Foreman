const db = require('./db');
const templates = require('./templates');
const messenger = require('./messenger');
const conversation = require('./conversation');

/**
 * Option 2 design: The Foreman never messages customers directly.
 * Instead it drafts messages and returns them to the tradesperson,
 * ready to copy-paste into their own WhatsApp conversation.
 */

// --- Dispatch ---

const handlers = {
  new_job: handleNewJob,
  quote: handleQuote,
  schedule: handleSchedule,
  done: handleDone,
  paid: handlePaid,
  send_invoice: handleSendInvoice,
  chase: handleChase,
  follow_up: handleFollowUp,
  archive_job: handleArchiveJob,
  view_schedule: handleViewSchedule,
  unpaid: handleUnpaid,
  open_jobs: handleOpenJobs,
  find: handleFind,
  help: handleHelp,
  unknown: handleUnknown,
};

async function dispatch(intent, res, business) {
  const handler = handlers[intent.intent];
  if (!handler) return handleUnknown(intent, res, business);
  return handler(intent, res, business);
}

// --- Handlers ---

async function handleNewJob(intent, res, business) {
  const customer = await db.findOrCreateCustomer(business.id, intent.name, intent.phone, intent.address, intent.postcode);
  const description = intent.description || 'New job';
  const job = await db.createJob(business.id, customer.id, description, intent.address, intent.postcode);
  const postcode = intent.postcode ? `, ${intent.postcode}` : '';
  const address = intent.address ? `\n📍 ${intent.address}${postcode}` : '';
  await conversation.beginFlow(business.id, 'quote', {
    jobId: job.id,
    items: job.description,
  });

  messenger.twimlReply(
    res,
    `✅ Job ${db.formatJobId(job.id)} created\n` +
    `👤 ${customer.name} — ${customer.phone}${address}\n` +
    `🔧 ${job.description}\n\n` +
    `If you want, I can draft the quote next — just tell me the price.`
  );
}

async function handleQuote(intent, res, business) {
  const job = await db.getJobWithCustomer(intent.jobId);
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
    `When they’re happy to go ahead, just tell me the day and time and I’ll help you book it in.`
  );
}

async function handleSchedule(intent, res, business) {
  const job = await db.getJobWithCustomer(intent.jobId);
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

async function handleDone(intent, res, business) {
  const job = await db.getJobWithCustomer(intent.jobId);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);

  await db.completeJob(job.id, intent.notes);

  const amount = intent.amount || job.quoted_amount;
  if (!amount) {
    return messenger.twimlReply(
      res,
      `✅ Job ${db.formatJobId(job.id)} marked complete.\n\n` +
      `No amount set — use *invoice ${job.id} [amount]* to generate the invoice.`
    );
  }

  const lineItems = intent.notes || job.quote_items || job.description;
  const invoice = await db.createInvoice(business.id, job.id, amount, lineItems);
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

async function handlePaid(intent, res, business) {
  const invoice = await db.getInvoiceByJob(intent.jobId);
  if (!invoice) return messenger.twimlReply(res, `❌ No invoice found for job #${intent.jobId}.`);
  if (invoice.status === 'PAID') return messenger.twimlReply(res, `✅ Already marked as paid.`);

  await db.markInvoicePaid(invoice.id);
  messenger.twimlReply(res, `💰 Job ${db.formatJobId(intent.jobId)} — invoice marked as paid. Nice one!`);
}

async function handleSendInvoice(intent, res, business) {
  const job = await db.getJobWithCustomer(intent.jobId);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);

  let invoice = await db.getInvoiceByJob(job.id);
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

async function handleChase(intent, res, business) {
  const job = await db.getJobWithCustomer(intent.jobId);
  if (!job) return messenger.twimlReply(res, `❌ Job #${intent.jobId} not found.`);

  const invoice = await db.getInvoiceByJob(job.id);
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

async function handleFollowUp(intent, res, business) {
  const job = await db.getJobWithCustomer(intent.jobId);
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

async function handleArchiveJob(intent, res, business) {
  const jobIds = intent.jobIds || (intent.jobId ? [intent.jobId] : []);
  if (!jobIds.length) return messenger.twimlReply(res, `❌ I couldn't find that job.`);

  const archived = [];
  for (const jobId of jobIds) {
    const job = await db.getJobWithCustomer(jobId);
    if (!job) continue;
    await db.archiveJob(job.id);
    archived.push(`${db.formatJobId(job.id)} — ${job.customer.name}, ${job.description}`);
  }

  if (!archived.length) {
    return messenger.twimlReply(res, `❌ I couldn't find those jobs.`);
  }

  messenger.twimlReply(
    res,
    `🗂️ Archived ${archived.length} job${archived.length === 1 ? '' : 's'}:\n${archived.map((line) => `• ${line}`).join('\n')}\n\nI’ll keep ${archived.length === 1 ? 'it' : 'them'} out of normal active flows now.`
  );
}

async function handleViewSchedule(intent, res, business) {
  const now = new Date();

  if (intent.period === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    const dateStr = d.toISOString().split('T')[0];
    const jobs = await db.getScheduleForDate(business.id, dateStr);
    return messenger.twimlReply(res, `*Tomorrow:*\n${templates.formatScheduleDay(jobs, dateStr)}`);
  }

  if (intent.period === 'week') {
    const start = now.toISOString().split('T')[0];
    const end = new Date(now);
    end.setDate(end.getDate() + 7);
    const endStr = end.toISOString().split('T')[0];
    const jobs = await db.getScheduleRange(business.id, start, endStr);

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

  const dateStr = now.toISOString().split('T')[0];
  const jobs = await db.getScheduleForDate(business.id, dateStr);
  messenger.twimlReply(res, `*Today:*\n${templates.formatScheduleDay(jobs, dateStr)}`);
}

async function handleUnpaid(intent, res, business) {
  const invoices = await db.getUnpaidInvoices(business.id);
  if (!invoices.length) return messenger.twimlReply(res, `No unpaid invoices. 🎉`);

  const total = invoices.reduce((sum, i) => sum + i.amount, 0);
  const lines = invoices.map((i) => {
    const days = Math.floor((Date.now() - new Date(i.sent_at).getTime()) / 86400000);
    return `• ${db.formatJobId(i.job_id)} — ${i.customer_name}, £${i.amount.toFixed(2)} (${days}d)\n  → chase ${i.job_id}`;
  });

  messenger.twimlReply(
    res,
    `💷 *${invoices.length} unpaid — £${total.toFixed(2)} outstanding*\n\n${lines.join('\n\n')}`
  );
}

async function handleOpenJobs(intent, res, business) {
  const jobs = await db.getOpenJobs(business.id);
  if (!jobs.length) return messenger.twimlReply(res, `No open jobs. 📭`);

  const lines = jobs.map((j) => `• ${db.formatJobId(j.id)} — ${j.customer_name}, ${j.description} [${j.status.toLowerCase()}]`);
  messenger.twimlReply(res, `📋 *${jobs.length} open jobs*\n\n${lines.join('\n')}`);
}

async function handleFind(intent, res, business) {
  const customers = await db.findCustomerByName(business.id, intent.query);
  if (!customers.length) return messenger.twimlReply(res, `No customers found matching "${intent.query}".`);

  const results = [];
  for (const c of customers.slice(0, 5)) {
    const jobs = await db.getAll(
      'SELECT * FROM jobs WHERE customer_id = $1 AND business_id = $2 ORDER BY created_at DESC LIMIT 5',
      [c.id, business.id]
    );
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

async function handleHelp(intent, res, business) {
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

async function handleUnknown(intent, res, business) {
  messenger.twimlReply(res, `🤔 Didn't catch that. Reply *help* for commands.`);
}

module.exports = { dispatch };
