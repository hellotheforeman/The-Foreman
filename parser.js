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
  // Exclude acceptance phrases: "quote accepted/confirmed/approved" are handled later
  const quoteNameMatch = normalisedForQuote.match(/^quote\s+(.+)$/i);
  if (quoteNameMatch && !/^(accepted|confirmed|approved)$/i.test(quoteNameMatch[1].trim())) {
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

  // "paid" / "mark as paid" / "he/she/they paid" / "that invoice is paid" / contextual paid phrases with no name
  if (/^(paid|mark\s+as\s+paid|mark\s+it\s+as\s+paid|(he|she|they|it)\s+(has\s+)?paid(\s+(that\s+)?(invoice|up))?|that\s+invoice(\s+is|\s+has\s+been)?\s+paid|invoice\s+(is\s+|has\s+been\s+)?paid|just\s+paid|now\s+paid)$/i.test(lower)) {
    return { kind: 'command', intent: 'paid', jobId: null, jobRef: null };
  }

  // "[Name] paid" / "[Name] has paid" / "[Name] settled" — name before paid verb
  const namePaidMatch = lower.match(/^([a-z][a-z\s'-]{1,30}?)\s+(paid(\s+up)?|has\s+paid|settled|paid\s+the\s+invoice)$/i);
  if (namePaidMatch && !/\b(invoice|quote|job|that|the|it|he|she|they|how|what|when|where|why)\b/i.test(namePaidMatch[1])) {
    return { kind: 'command', intent: 'paid', jobId: null, jobRef: namePaidMatch[1].trim() };
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

  // Invoice by customer name: "invoice Mrs Smith" or "invoice for James Smith for a boiler service £180"
  const invoiceByNameMatch = text.match(/^(?:send\s+)?invoice\s+(?!#?\d)(.+)$/i);
  if (invoiceByNameMatch) {
    const ref = invoiceByNameMatch[1].trim();
    if (/^-?\d|^£/.test(ref)) {
      return { kind: 'command', intent: 'send_invoice', jobId: null, jobRef: null, amount: null };
    }

    // Extract £XXX or trailing number from the full phrase
    const amountMatch = ref.match(/£(\d+(?:\.\d{1,2})?)\b/) || ref.match(/\b(\d+(?:\.\d{1,2})?)\s*$/);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : null;
    let jobRef = ref;
    let items = null;

    // "for [Name] for [description] [£amount]" — most verbose natural form
    const forNameForDesc = ref.match(/^for\s+([A-Za-z][A-Za-z\s'-]{1,40}?)\s+for\s+(.+?)(?:\s+£[\d.,]+)?\s*$/i);
    if (forNameForDesc) {
      jobRef = forNameForDesc[1].trim();
      items = forNameForDesc[2].replace(/\s*£[\d.,]+\s*$/, '').trim() || null;
    } else {
      // "for [Name] [£amount]" — name only with optional trailing amount
      const forName = ref.match(/^for\s+([A-Za-z][A-Za-z\s'-]{1,40}?)(?:\s+£?[\d.,]+)?\s*$/i);
      if (forName) {
        jobRef = forName[1].trim();
      } else if (amount != null) {
        // "[Name] [description] [£amount]" — strip trailing amount from ref
        jobRef = ref.replace(/\s*£?\d[\d.,]*\s*$/, '').trim();
      }
    }

    return { kind: 'command', intent: 'send_invoice', jobId: null, jobRef, amount, items };
  }

  // Bare invoice intent: "invoice", "create an invoice", "create me an invoice", "build me an invoice" etc.
  if (/^(?:(?:create|make|raise|send|generate|build)\s+(?:me\s+)?(?:an?\s+)?)?invoice\s*$/i.test(lower)) {
    return { kind: 'command', intent: 'send_invoice', jobId: null, jobRef: null, amount: null };
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

  // "chase Darren", "chase Darren Masters"
  const chaseNameMatch = text.match(/^chase\s+(?!#?\d)(.+)$/i);
  if (chaseNameMatch) {
    return { kind: 'command', intent: 'chase', jobId: null, jobRef: chaseNameMatch[1].trim() };
  }

  // "create me a chaser for Darren", "draft a payment chaser for Darren Masters"
  const createChaserMatch = text.match(/^(?:create|draft|write|make)\s+(?:me\s+)?(?:a\s+)?(?:payment\s+)?chaser\s+(?:for\s+)?(.+)$/i);
  if (createChaserMatch) {
    return { kind: 'command', intent: 'chase', jobId: null, jobRef: createChaserMatch[1].trim() };
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

  // "resend/send me/give me/show me/return [the] quote/invoice for [name]"
  const resendDocForMatch = text.match(/^(?:resend\s+|re-send\s+|send\s+(?:me\s+)?(?:the\s+)?|give\s+me\s+(?:the\s+)?|return\s+(?:the\s+)?|show\s+(?:me\s+)?(?:the\s+)?)(?:the\s+)?(quote|invoice)\s+for\s+(.+)$/i);
  if (resendDocForMatch) {
    const docType = resendDocForMatch[1].toLowerCase();
    const ref = resendDocForMatch[2].trim();
    if (docType === 'invoice') {
      return { kind: 'command', intent: 'send_invoice', jobId: null, jobRef: ref, amount: null };
    }
    return { kind: 'command', intent: 'resend_quote', jobRef: ref };
  }

  // "give me/show me/resend/return/share with me [name]’s quote/invoice", or bare "[name]’s quote/invoice"
  const resendDocPossessiveMatch = text.match(/^(?:resend|re-send|send\s+(?:me\s+)?|give\s+me\s+|return\s+|show\s+(?:me\s+)?|share\s+with\s+me\s+(?:the\s+)?)?(.+?)[‘’]s\s+(quote|invoice)$/i);
  if (resendDocPossessiveMatch) {
    const ref = resendDocPossessiveMatch[1].trim();
    const docType = resendDocPossessiveMatch[2].toLowerCase();
    if (docType === 'invoice') {
      return { kind: 'command', intent: 'send_invoice', jobId: null, jobRef: ref, amount: null };
    }
    return { kind: 'command', intent: 'resend_quote', jobRef: ref };
  }

  // "pull up the quote/invoice for Smith", "what's the quote for Patel" — show job details
  const viewDocForMatch = text.match(/^(?:pull\s+up\s+(?:the\s+)?|view\s+(?:the\s+)?|what['']?s\s+(?:the\s+)?)(?:quote|invoice)\s+for\s+(.+)$/i);
  if (viewDocForMatch) {
    return { kind: 'query', intent: 'view_job', jobRef: viewDocForMatch[1].trim() };
  }

  // "pull up Smith's invoice" — show job details
  const viewDocPossessiveMatch = text.match(/^pull\s+up\s+(.+?)['']?s\s+(?:quote|invoice)$/i);
  if (viewDocPossessiveMatch) {
    return { kind: 'query', intent: 'view_job', jobRef: viewDocPossessiveMatch[1].trim() };
  }

  // --- Quote accepted / go ahead — must come before "quotes out" to avoid misroute ---
  // Contextual: no customer name
  if (/^(go\s+ahead(\s+with\s+(it|the\s+quote))?|quote\s+(accepted|confirmed|approved)|confirmed(\s+the\s+quote)?|convert\s+(the\s+)?quote\s+to\s+(an?\s+)?invoice|convert\s+to\s+(an?\s+)?invoice|they\s+want\s+to\s+(go\s+ahead|proceed)|want\s+to\s+go\s+ahead|happy\s+to\s+proceed)$/i.test(lower)) {
    return { kind: 'command', intent: 'send_invoice', jobId: null, jobRef: null, fromQuote: true };
  }
  if (/^(he|she|they|customer)\s+(accepted|confirmed|approved|wants?\s+to\s+go\s+ahead|said\s+yes)(\s+(the\s+)?(quote|it|that))?$/i.test(lower)) {
    return { kind: 'command', intent: 'send_invoice', jobId: null, jobRef: null, fromQuote: true };
  }
  // Named: "[Name] accepted/confirmed/approved [the quote]"
  const nameAcceptedMatch = lower.match(/^([a-z][a-z\s'-]{1,30}?)\s+(accepted|confirmed|approved|said\s+yes|wants?\s+to\s+go\s+ahead)(\s+(the\s+)?(quote|it))?$/i);
  if (nameAcceptedMatch && !/\b(he|she|they|it|the|that|invoice|quote|job)\b/i.test(nameAcceptedMatch[1])) {
    return { kind: 'command', intent: 'send_invoice', jobId: null, jobRef: nameAcceptedMatch[1].trim(), fromQuote: true };
  }

  // --- Capability questions ---
  // New users asking whether the bot can do something — return unknown so the AI
  // answers naturally via reply_directly rather than showing the static help menu.
  // "for Smith" guard prevents catching actual commands like "can you do a quote for Smith".
  if (/\b(do you (do|also\s+do|handle|support|offer|work\s+with)|can you (do|handle|support|work\s+with)|are you able to)\b/i.test(lower)
      && !/\bfor\s+[A-Z][a-z]/.test(text)) {
    return { kind: 'query', intent: 'unknown' };
  }

  // --- Quotes out ---
  // Exclude "quote for [name]" — those are view_job requests, not list requests
  // Exclude interrogative phrases so "do you do quotes" routes to help, not here
  if (/\bquotes?\b/.test(lower) && !/amend|change|update|send|create|new/.test(lower) && !/\bquote\s+for\s+\w/.test(lower) && !/\b(do you|can you|are you|will you)\b/.test(lower)) {
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
  if (/^(help|commands|what can you do|\?)$/i.test(lower)) {
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

// Extracts a plain amount from input that may have trade-common qualifiers on the end.
// e.g. "2500 all in", "£800 inc vat", "1200 flat rate", "950 plus vat" → number
// Returns a number or null. Does NOT handle line items — use parseLineItems for those.
function extractAmount(text) {
  const t = (text || '').trim()
    .replace(/\s*(all[\s-]in|all[\s-]inclusive|inc\.?\s*vat|incl\.?\s*vat|ex\.?\s*vat|excl\.?\s*vat|plus\s*vat|flat[\s-]?rate|flat|fixed[\s-]?price|fixed|total|overall)\s*$/i, '')
    .trim();
  const m = t.match(/^£?(\d+(?:\.\d{1,2})?)$/);
  return m ? parseFloat(m[1]) : null;
}

module.exports = { parse, normalisePhone, parseLineItems, extractAmount };
