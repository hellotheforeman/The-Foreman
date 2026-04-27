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
  if (/^(no|nah|cancel|skip|nope|don'?t)$/i.test(lower)) {
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

  // Quick: "quote 42 85" or "quote job 42 £85 boiler service"
  const quoteQuickMatch = normalisedForQuote.match(
    /^quote\s+(?:job\s+)?#?(\d+)\s+£?(\d+(?:\.\d{1,2})?)\s*(?:for\s+)?(.*)$/i
  );
  if (quoteQuickMatch) {
    const desc = quoteQuickMatch[3].trim();
    const amount = parseFloat(quoteQuickMatch[2]);
    const lineItems = desc ? [{ description: desc, amount }] : null;
    return {
      kind: 'command',
      intent: 'quote',
      jobId: parseInt(quoteQuickMatch[1], 10),
      amount,
      items: desc || null,
      lineItems,
    };
  }

  // Itemised: "quote 14 boiler service 250 | parts 45" or "quote job 14 service 250"
  const quoteItemisedMatch = normalisedForQuote.match(/^quote\s+(?:job\s+)?#?(\d+)\s+(.+)$/i);
  if (quoteItemisedMatch) {
    const itemsStr = quoteItemisedMatch[2].trim();
    const lineItems = parseLineItems(itemsStr);
    if (lineItems) {
      return {
        kind: 'command',
        intent: 'quote',
        jobId: parseInt(quoteItemisedMatch[1], 10),
        amount: lineItems.reduce((sum, i) => sum + i.amount, 0),
        items: itemsStr,
        lineItems,
      };
    }
    // Has job ID but no parseable amounts — workflow will prompt for amount
    return {
      kind: 'command',
      intent: 'quote',
      jobId: parseInt(quoteItemisedMatch[1], 10),
      amount: null,
      items: itemsStr,
      lineItems: null,
    };
  }

  // Job ID only — no amount or items: "quote 14" or "quote job 14" → triggers guided workflow
  const quoteJustIdMatch = normalisedForQuote.toLowerCase().match(/^quote\s+(?:job\s+)?#?(\d+)\s*$/);
  if (quoteJustIdMatch) {
    return {
      kind: 'command',
      intent: 'quote',
      jobId: parseInt(quoteJustIdMatch[1], 10),
      amount: null,
      items: null,
      lineItems: null,
    };
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

  // --- Cancel job ---
  const cancelJobMatch = lower.match(/^cancel(?:\s+job)?\s+#?(\d+)\s*$/);
  if (cancelJobMatch) {
    return { kind: 'command', intent: 'cancel_job', jobId: parseInt(cancelJobMatch[1], 10) };
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

  // --- Earnings / income summary ---
  if (/\b(earnings?|earned|income|revenue|how much (have i |i've )?made|profit|summary|takings?)\b/i.test(lower)) {
    let period = 'month';
    if (/\btoday\b/.test(lower)) period = 'today';
    else if (/\bthis week\b|\bweek\b/.test(lower)) period = 'week';
    else if (/\bthis year\b|\byear\b/.test(lower)) period = 'year';
    else if (/\bthis month\b|\bmonth\b/.test(lower)) period = 'month';
    return { kind: 'query', intent: 'earnings', period };
  }

  // --- Unpaid / overdue ---
  if (/^(unpaid|overdue|outstanding|owed)$/i.test(lower)) {
    return { kind: 'query', intent: 'unpaid' };
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
  if (/^new\s+jobs?$/i.test(lower)) return { kind: 'query', intent: 'jobs_by_status', status: 'new' };
  if (/^(in[\s-]progress(\s+jobs?)?)$/i.test(lower)) return { kind: 'query', intent: 'jobs_by_status', status: 'in progress' };
  if (/^(complete[d]?\s+jobs?|jobs?\s+complete[d]?)$/i.test(lower)) return { kind: 'query', intent: 'jobs_by_status', status: 'complete' };
  if (/^(cancelled?\s+jobs?|jobs?\s+cancelled?)$/i.test(lower)) return { kind: 'query', intent: 'jobs_by_status', status: 'cancelled' };
  if (/^outstanding\s+jobs?$/i.test(lower)) return { kind: 'query', intent: 'jobs_by_status', status: 'outstanding' };

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
  const parts = str.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  const items = [];
  for (const part of parts) {
    // Match: "description £?amount" — number at the end
    const m = part.match(/^(.+?)\s+£?(\d+(?:\.\d{1,2})?)\s*$/);
    if (!m) return null;
    items.push({ description: m[1].trim(), amount: parseFloat(m[2]) });
  }
  return items.length ? items : null;
}

function normalisePhone(phone) {
  let p = phone.replace(/\s+/g, '');
  if (p.startsWith('0')) {
    p = '+44' + p.slice(1);
  } else if (p.startsWith('44')) {
    p = '+' + p;
  } else if (!p.startsWith('+')) {
    p = '+44' + p;
  }
  return p;
}

module.exports = { parse, normalisePhone, parseLineItems };
