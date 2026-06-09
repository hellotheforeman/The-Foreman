/**
 * Intent parser — regex-based for MVP.
 * Parses tradesperson messages into structured intents.
 * Designed to handle fuzzy, on-site typing.
 */

// Normalise input: trim, collapse whitespace, lowercase
function normalise(text) {
  return text.trim().replace(/\s+/g, ' ');
}


function parse(raw) {
  const text = normalise(raw);
  const lower = text.toLowerCase();

  // --- Pleasantries ---
  if (/^(hi+|hello|hey|morning|afternoon|evening|alright|aight|yo|sup|howdy|hiya)[\s!?.]*$/i.test(lower)) {
    return { kind: 'query', intent: 'greeting' };
  }
  if (/^(thanks?|ta|cheers|thank you|nice one|legend|perfect|brilliant|great|fab|lovely|sweet|sorted|no worries|no problem|appreciate it|sound)[\s!?.]*$/i.test(lower)) {
    return { kind: 'query', intent: 'thanks' };
  }

  // --- Confirmation (yes/send/go/confirm) ---
  if (/^(yes|yep|yeah|y|send|go|confirm|ok|do it|sure|approved?)$/i.test(lower)) {
    return { kind: 'continuation', intent: 'confirm' };
  }

  // --- Cancel pending action ---
  // Note: "skip" intentionally excluded — workflow handlers catch it on raw body
  if (/^(no|nah|cancel|nope|don'?t)$/i.test(lower)) {
    return { kind: 'continuation', intent: 'cancel' };
  }

  // --- New customer (no job) ---
  // "new customer Dave Smith 07700900123"
  const newCustomerMatch = text.match(
    /^(?:new|add)\s+customer\s+(.+?)\s+((?:\+?44|0)7\d{8,9})(?:\s+([A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2}))?(?:\s+(\S+@\S+))?\s*$/i
  );
  if (newCustomerMatch) {
    return {
      kind: 'command',
      intent: 'new_customer',
      name: newCustomerMatch[1].trim(),
      phone: normalisePhone(newCustomerMatch[2]),
      postcode: newCustomerMatch[3] ? newCustomerMatch[3].toUpperCase() : null,
      email: newCustomerMatch[4] ? newCustomerMatch[4].toLowerCase() : null,
    };
  }

  // "new customer" or "new customer Dave" — trigger workflow to collect missing fields
  const newCustomerPartialMatch = text.match(/^(?:new|add)\s+customer(?:\s+(.+))?$/i);
  if (newCustomerPartialMatch) {
    const rest = (newCustomerPartialMatch[1] || '').trim();
    const looksLikePhone = /^(?:\+?44|0)7\d/.test(rest);
    return {
      kind: 'command',
      intent: 'new_customer',
      name: rest && !looksLikePhone ? rest : null,
      phone: null,
    };
  }

  // --- New job ---
  // "new job Mrs Patel 07700900123 boiler service BD7 1AH"
  const newJobMatch = text.match(
    /^new\s+(?:job\s+)?(.+?)\s+((?:\+?44|0)7\d{8,9})\s+(.+?)(?:\s+([A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2}))?(?:\s+(\S+@\S+))?\s*$/i
  );
  if (newJobMatch) {
    return {
      kind: 'command',
      intent: 'new_job',
      name: newJobMatch[1].trim(),
      phone: normalisePhone(newJobMatch[2]),
      description: newJobMatch[3].trim(),
      postcode: newJobMatch[4] ? newJobMatch[4].toUpperCase() : null,
      email: newJobMatch[5] ? newJobMatch[5].toLowerCase() : null,
    };
  }

  // --- Quote (and re-quote aliases) ---
  // Normalise "requote", "re-quote", "update quote" → treated identically to "quote"
  const normalisedForQuote = text.replace(/^(?:re-?quote|update\s+quote)\s+/i, 'quote ');

  // Bare "quote" or "create/make/send a quote" — starts the guided new-quote flow
  if (/^(?:(?:create|make|send)\s+a?\s*)?quote\s*$/i.test(lower)) {
    return { kind: 'command', intent: 'quote', jobId: null, jobRef: null, amount: null, items: null, lineItems: null };
  }

  // "create a quote for Mrs Smith", "quote for Mrs Smith", "send a quote to Mrs Smith"
  const quoteForMatch = normalisedForQuote.match(/^(?:create\s+a?\s*quote\s+(?:for|to)|quote\s+for|send\s+a?\s*quote\s+(?:for|to))\s+(.+)$/i);
  if (quoteForMatch) {
    return {
      kind: 'command',
      intent: 'quote',
      jobId: null,
      jobRef: quoteForMatch[1].trim(),
      amount: null,
      items: null,
      lineItems: null,
    };
  }

  // Name/partial reference: "quote wood" — workflow engine resolves to a job
  const quoteNameMatch = normalisedForQuote.match(/^quote\s+(.+)$/i);
  if (quoteNameMatch) {
    return {
      kind: 'command',
      intent: 'quote',
      jobId: null,
      amount: null,
      items: quoteNameMatch[1].trim(),
      lineItems: null,
    };
  }

  // --- Paid ---
  // "paid 42" or "paid #0042"
  const paidMatch = lower.match(/^paid\s+#?(\d+)\s*$/);
  if (paidMatch) {
    return { kind: 'command', intent: 'paid', jobId: parseInt(paidMatch[1], 10) };
  }

  // --- Invoice (send) ---
  // Quick with amount: "invoice 14 450" or "invoice 14 450 boiler service"
  const invoiceQuickMatch = text.match(/^(?:send\s+)?invoice\s+#?(\d+)\s+£?(\d+(?:\.\d{1,2})?)\s*(.*)$/i);
  if (invoiceQuickMatch) {
    const desc = invoiceQuickMatch[3].trim();
    const amount = parseFloat(invoiceQuickMatch[2]);
    const lineItems = desc ? [{ description: desc, amount }] : null;
    return {
      kind: 'command',
      intent: 'send_invoice',
      jobId: parseInt(invoiceQuickMatch[1], 10),
      amount,
      items: desc || null,
      lineItems,
    };
  }

  // Itemised: "invoice 14 boiler service 250 | parts 45"
  const invoiceItemisedMatch = text.match(/^(?:send\s+)?invoice\s+#?(\d+)\s+(.+)$/i);
  if (invoiceItemisedMatch) {
    const itemsStr = invoiceItemisedMatch[2].trim();
    const lineItems = parseLineItems(itemsStr);
    if (lineItems) {
      return {
        kind: 'command',
        intent: 'send_invoice',
        jobId: parseInt(invoiceItemisedMatch[1], 10),
        amount: lineItems.reduce((sum, i) => sum + i.amount, 0),
        items: itemsStr,
        lineItems,
      };
    }
  }

  // Simple: "invoice 42" or "send invoice 42" — creates from existing quote
  const invoiceMatch = lower.match(/^(?:send\s+)?invoice\s+#?(\d+)\s*$/);
  if (invoiceMatch) {
    return { kind: 'command', intent: 'send_invoice', jobId: parseInt(invoiceMatch[1], 10) };
  }

  // Invoice by customer name: "invoice Mrs Smith"
  const invoiceByNameMatch = text.match(/^(?:send\s+)?invoice\s+(?!#?\d)(.+)$/i);
  if (invoiceByNameMatch) {
    return { kind: 'command', intent: 'send_invoice', jobId: null, jobRef: invoiceByNameMatch[1].trim(), amount: null };
  }

  // --- Amend invoice ---
  // "amend 14 450" or "amend 14 450 boiler service" or "amend 14 service 250 | parts 45"
  const amendQuickMatch = text.match(/^amend(?:\s+invoice)?\s+#?(\d+)\s+£?(\d+(?:\.\d{1,2})?)\s*(.*)$/i);
  if (amendQuickMatch) {
    const desc = amendQuickMatch[3].trim();
    const amount = parseFloat(amendQuickMatch[2]);
    const lineItems = desc ? [{ description: desc, amount }] : null;
    return {
      kind: 'command',
      intent: 'amend_invoice',
      jobId: parseInt(amendQuickMatch[1], 10),
      amount,
      items: desc || null,
      lineItems,
    };
  }

  const amendItemisedMatch = text.match(/^amend(?:\s+invoice)?\s+#?(\d+)\s+(.+)$/i);
  if (amendItemisedMatch) {
    const itemsStr = amendItemisedMatch[2].trim();
    const lineItems = parseLineItems(itemsStr);
    if (lineItems) {
      return {
        kind: 'command',
        intent: 'amend_invoice',
        jobId: parseInt(amendItemisedMatch[1], 10),
        amount: lineItems.reduce((sum, i) => sum + i.amount, 0),
        items: itemsStr,
        lineItems,
      };
    }
  }

  // --- Chase ---
  // "chase 42"
  const chaseMatch = lower.match(/^chase\s+#?(\d+)\s*$/);
  if (chaseMatch) {
    return { kind: 'command', intent: 'chase', jobId: parseInt(chaseMatch[1], 10) };
  }

  // --- Review request (ask customer for a review after job complete) ---
  // "review 42", "follow up 42", "ask for review 42"
  const reviewMatch = lower.match(/^(?:review|follow\s*up|ask\s+for\s+review)\s+#?(\d+)\s*$/);
  if (reviewMatch) {
    return { kind: 'command', intent: 'review', jobId: parseInt(reviewMatch[1], 10) };
  }

  // --- Add note to job ---
  const noteMatch = text.match(/^(?:note|add\s+note)\s+#?(\d+)\s+(.+)$/i);
  if (noteMatch) {
    return { kind: 'command', intent: 'add_note', jobId: parseInt(noteMatch[1], 10), note: noteMatch[2].trim() };
  }

  // --- Mark job complete ---
  // "complete 14", "done 14", "finish 14", "mark 14 complete", "mark 14 done"
  const markCompleteMatch = lower.match(/^(?:complete|done|finish(?:ed)?|mark\s+#?(\d+)\s+(?:complete|done))\s*#?(\d+)?\s*$/);
  if (markCompleteMatch) {
    const jobId = parseInt(markCompleteMatch[1] || markCompleteMatch[2], 10);
    if (jobId) return { kind: 'command', intent: 'mark_complete', jobId };
  }

  // --- Cancel job / quote / invoice ---
  // By ID: "cancel 14", "cancel job 14", "cancel quote 14", "cancel invoice 14"
  const cancelJobIdMatch = lower.match(/^cancel\s+(?:job|quote|invoice)?\s*#?(\d+)\s*$/);
  if (cancelJobIdMatch) {
    return { kind: 'command', intent: 'cancel_job', jobId: parseInt(cancelJobIdMatch[1], 10) };
  }
  // By name: "cancel quote for Mrs Smith", "cancel the Smith job", "cancel invoice for Bob"
  const cancelJobNameMatch = text.match(/^cancel\s+(?:the\s+)?(?:job|quote|invoice)\s+(?:for\s+)?(?!#?\d)(.+)$/i);
  if (cancelJobNameMatch) {
    return { kind: 'command', intent: 'cancel_job', jobRef: cancelJobNameMatch[1].trim() };
  }
  // Lost / didn't win: "lost the Smith quote", "didn't get the boiler job"
  const lostJobMatch = text.match(/^(?:lost|didn'?t\s+get|not\s+getting)\s+(?:the\s+)?(.+?)(?:\s+(?:job|quote|contract|one))?\s*$/i);
  if (lostJobMatch) {
    return { kind: 'command', intent: 'cancel_job', jobRef: lostJobMatch[1].trim() };
  }

  // --- Business settings menu ---
  if (/^(?:settings?|business\s+settings?|my\s+settings?)$/i.test(lower)) {
    return { kind: 'query', intent: 'settings' };
  }

  // --- Update customer ---
  // "update Dave Smith email dave@example.com"
  const updateCustomerMatch = text.match(/^update\s+(?:customer\s+)?(.+?)\s+(name|phone|email|address)\s+(.+)$/i);
  if (updateCustomerMatch) {
    const field = updateCustomerMatch[2].toLowerCase();
    return {
      kind: 'command',
      intent: 'update_customer',
      customerName: updateCustomerMatch[1].trim(),
      field,
      value: updateCustomerMatch[3].trim(),
    };
  }

  // --- Financial summary (overview) ---
  if (/\b(how'?s\s+business|how\s+am\s+i\s+doing|business\s+overview|give\s+me\s+a\s+summary|stats?|financial\s+summary)\b/i.test(lower)) {
    return { kind: 'query', intent: 'financial_summary', period: parsePeriod(lower) };
  }

  // --- Conversion rate ---
  if (/\bconversion\s+rate\b|\bhow\s+many\s+quotes?\s+(am\s+i\s+)?(winning|converting|convert)\b/i.test(lower)) {
    return { kind: 'query', intent: 'conversion_rate', period: parsePeriod(lower) };
  }

  // --- Average payment time ---
  if (/\bhow\s+long.{0,20}(get\s+paid|to\s+pay)\b|\baverage\s+pay(ment(\s+time)?)?\b|\bpayment\s+time\b/i.test(lower)) {
    return { kind: 'query', intent: 'avg_payment_time', period: parsePeriod(lower) };
  }

  // --- Earnings / income summary ---
  if (/\b(earnings?|earned|income|revenue|how much (have i |i've )?made|profit|takings?)\b/i.test(lower)) {
    return { kind: 'query', intent: 'earnings', period: parsePeriod(lower) };
  }

  // --- Unpaid / overdue ---
  if (/^(unpaid|overdue|outstanding|owed)$/i.test(lower)) {
    return { kind: 'query', intent: 'unpaid' };
  }

  // --- Quotes out ---
  if (/\bquotes?\b/.test(lower) && !/amend|change|update|send|create|new/.test(lower)) {
    return { kind: 'query', intent: 'jobs_by_status', status: 'quoted' };
  }

  // --- Open jobs ---
  if (/^(jobs|open|active|pipeline)$/i.test(lower)) {
    return { kind: 'query', intent: 'open_jobs' };
  }

  // --- List customers ---
  if (/^(customers|client|clients|all customers|my customers|customer list)$/i.test(lower)) {
    return { kind: 'query', intent: 'list_customers' };
  }
  if (/^more customers$/i.test(lower)) {
    return { kind: 'query', intent: 'list_customers', offset: 10 };
  }

  // --- View job detail ---
  const jobDetailMatch = text.match(/^job\s+#?(\d+)$/i);
  if (jobDetailMatch) {
    return { kind: 'query', intent: 'view_job', jobId: parseInt(jobDetailMatch[1], 10) };
  }

  // --- Jobs by status ---
  if (/^quoted\s+jobs?$/i.test(lower)) return { kind: 'query', intent: 'jobs_by_status', status: 'quoted' };
  if (/^invoiced\s+jobs?$/i.test(lower)) return { kind: 'query', intent: 'jobs_by_status', status: 'invoiced' };
  if (/^(paid\s+jobs?|jobs?\s+paid)$/i.test(lower)) return { kind: 'query', intent: 'jobs_by_status', status: 'paid' };
  if (/^(cancelled?\s+jobs?|jobs?\s+cancelled?)$/i.test(lower)) return { kind: 'query', intent: 'jobs_by_status', status: 'cancelled' };

  // --- Find customer ---
  const findMatch = text.match(/^find\s+(.+)$/i);
  if (findMatch) {
    return { kind: 'query', intent: 'find', query: findMatch[1].trim() };
  }

  // --- Help ---
  if (/^(help|commands|what can you do|how does this work|\?)$/i.test(lower)) {
    return { kind: 'query', intent: 'help' };
  }

  // --- Feedback ---
  if (/^feedback\b/i.test(lower)) {
    const message = text.replace(/^feedback\s*/i, '').trim();
    return { kind: 'command', intent: 'feedback', message };
  }

  // --- Unknown ---
  return { kind: 'unknown', intent: 'unknown', raw: text };
}

// --- Line item parsing ---

// Parses comma-separated items: "boiler service 250, parts 45"
// Returns [{description, amount}] or null if any part fails to parse.
function parseLineItems(str) {
  // Strip trailing punctuation then collapse thousands-separator commas (£1,200 → £1200)
  // before splitting on commas, so we don't split mid-number.
  const normalised = str.replace(/[.;]+$/, '').replace(/(\d),(\d{3})\b/g, '$1$2');
  const parts = normalised.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  const items = [];
  for (const part of parts) {
    // Match: "description £?amount" — number at the end
    const m = part.match(/^(.+?)\s+£?(\d+(?:\.\d{1,2})?)\s*$/);
    if (!m) return null;
    items.push({ description: m[1].trim(), amount: parseFloat(m[2]) });
  }
  return items.length ? items : null;
}

const { normalisePhone } = require('./phone');

// Extracts a period string from a message. Returns a string consumed by resolvePeriod in handlers.js.
function parsePeriod(lower) {
  // "last N months/weeks/days" — e.g. "last 3 months", "last 90 days"
  const lastNMatch = lower.match(/\blast\s+(\d+)\s+(day|week|month|year)s?\b/);
  if (lastNMatch) return `last_${lastNMatch[1]}_${lastNMatch[2]}s`;

  // Named shorthands
  if (/\blast\s+quarter\b/.test(lower)) return 'last_3_months';
  if (/\byesterday\b/.test(lower)) return 'yesterday';
  if (/\btoday\b/.test(lower)) return 'today';
  if (/\bthis\s+week\b|\blast\s+week\b/.test(lower)) return 'week';
  if (/\bthis\s+year\b|\blast\s+year\b/.test(lower)) return 'year';
  if (/\bthis\s+month\b|\blast\s+month\b/.test(lower)) return 'month';
  if (/\bweek\b/.test(lower)) return 'week';
  if (/\byear\b/.test(lower)) return 'year';
  return 'month';
}

module.exports = { parse, normalisePhone, parseLineItems };
