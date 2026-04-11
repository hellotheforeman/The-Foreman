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

  // --- Quote ---
  // Quick: "quote 42 85" or "quote #0042 £85 boiler service"
  const quoteQuickMatch = text.match(
    /^quote\s+#?(\d+)\s+£?(\d+(?:\.\d{1,2})?)\s*(?:for\s+)?(.*)$/i
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

  // Itemised: "quote 14 boiler service 250 | parts 45" or "quote 14 boiler service 250"
  const quoteItemisedMatch = text.match(/^quote\s+#?(\d+)\s+(.+)$/i);
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

  // Name/partial reference: "quote wood" — workflow engine resolves to a job
  const quoteNameMatch = text.match(/^quote\s+(.+)$/i);
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

  // --- Schedule ---
  // "schedule 42 thursday 9am" or "schedule #0042 tomorrow 2pm"
  const scheduleMatch = text.match(
    /^schedule\s+#?(\d+)\s+(.+)$/i
  );
  if (scheduleMatch) {
    const { date, time } = parseDatetime(scheduleMatch[2].trim());
    return {
      kind: 'command',
      intent: 'schedule',
      jobId: parseInt(scheduleMatch[1], 10),
      date,
      time,
      raw: scheduleMatch[2].trim(),
    };
  }

  // --- Done / complete ---
  // "done 42 service plus valve replacement total 140" or "done 42 140"
  // Also supports itemised: "done 42 boiler service 250 | parts 45"
  const doneMatch = text.match(
    /^(?:done|complete|finished)\s+#?(\d+)\s+(.+)$/i
  );
  if (doneMatch) {
    const rest = doneMatch[2].trim();
    // Only use line-item parsing when pipe-separated — avoids misreading "total 140"
    if (rest.includes('|')) {
      const lineItems = parseLineItems(rest);
      if (lineItems) {
        return {
          kind: 'command',
          intent: 'done',
          jobId: parseInt(doneMatch[1], 10),
          amount: lineItems.reduce((sum, i) => sum + i.amount, 0),
          notes: rest,
          lineItems,
        };
      }
    }
    const { amount, notes } = parseDoneDetails(rest);
    return {
      kind: 'command',
      intent: 'done',
      jobId: parseInt(doneMatch[1], 10),
      amount,
      notes,
      lineItems: null,
      raw: rest,
    };
  }

  // Simple "done 42"
  const doneSimpleMatch = lower.match(/^(?:done|complete|finished)\s+#?(\d+)\s*$/);
  if (doneSimpleMatch) {
    return {
      kind: 'command',
      intent: 'done',
      jobId: parseInt(doneSimpleMatch[1], 10),
      amount: null,
      notes: null,
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

  // --- Reschedule ---
  const rescheduleMatch = text.match(/^(?:reschedule|rebook|move)\s+#?(\d+)\s+(?:to\s+)?(.+)$/i);
  if (rescheduleMatch) {
    const { date, time } = parseDatetime(rescheduleMatch[2].trim());
    return {
      kind: 'command',
      intent: 'reschedule',
      jobId: parseInt(rescheduleMatch[1], 10),
      date,
      time,
      raw: rescheduleMatch[2].trim(),
    };
  }

  // --- Add note to job ---
  const noteMatch = text.match(/^(?:note|add\s+note)\s+#?(\d+)\s+(.+)$/i);
  if (noteMatch) {
    return { kind: 'command', intent: 'add_note', jobId: parseInt(noteMatch[1], 10), note: noteMatch[2].trim() };
  }

  // --- Cancel job (the only manual status action — can't be inferred from data) ---
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
  const updateCustomerMatch = text.match(/^update\s+(?:customer\s+)?(.+?)\s+(phone|email|address|notes?)\s+(.+)$/i);
  if (updateCustomerMatch) {
    const fieldRaw = updateCustomerMatch[2].toLowerCase();
    const field = fieldRaw === 'note' ? 'notes' : fieldRaw;
    return {
      kind: 'command',
      intent: 'update_customer',
      customerName: updateCustomerMatch[1].trim(),
      field,
      value: updateCustomerMatch[3].trim(),
    };
  }

  // --- Schedule view ---
  if (/^(today|tomorrow|this week|next week|schedule|diary|what'?s on)\s*(today|tomorrow)?\s*$/i.test(lower)) {
    let period = 'today';
    if (lower.includes('tomorrow')) period = 'tomorrow';
    else if (lower.includes('next week')) period = 'next_week';
    else if (lower.includes('this week') || lower.includes('week')) period = 'week';
    return { kind: 'query', intent: 'view_schedule', period };
  }

  // Specific date: "what's on friday", "what have I got on thursday", "schedule tuesday"
  const specificScheduleMatch = lower.match(/^(?:what'?s\s+on|what(?:\s+have|'ve)\s+i\s+got(?:\s+on)?|schedule\s+|diary\s+)(.+)$/);
  if (specificScheduleMatch) {
    const { date } = parseDatetime(specificScheduleMatch[1].trim());
    if (date) {
      return { kind: 'query', intent: 'view_schedule', period: 'date', date };
    }
  }

  // --- Earnings / income summary ---
  if (/\b(earnings?|income|revenue|how much (have i |i've )?made|profit|summary|takings?)\b/i.test(lower)) {
    let period = 'month';
    if (/\btoday\b/.test(lower)) period = 'today';
    else if (/\bthis week\b/.test(lower)) period = 'week';
    else if (/\bthis year\b/.test(lower)) period = 'year';
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

  // --- Find customer ---
  const findMatch = text.match(/^find\s+(.+)$/i);
  if (findMatch) {
    return { kind: 'query', intent: 'find', query: findMatch[1].trim() };
  }

  // --- Help ---
  if (/^(help|commands|what can you do|how does this work|\?)$/i.test(lower)) {
    return { kind: 'query', intent: 'help' };
  }

  // --- Unknown ---
  return { kind: 'unknown', intent: 'unknown', raw: text };
}

// --- Line item parsing ---

// Parses pipe-separated items: "boiler service 250 | parts 45"
// Returns [{description, amount}] or null if any part fails to parse.
function parseLineItems(str) {
  const parts = str.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  const items = [];
  for (const part of parts) {
    // Match: "description £?amount" — number at the end
    const m = part.match(/^(.+?)\s+£?(\d+(?:\.\d{1,2})?)\s*$/);
    if (!m) return null;
    items.push({ description: m[1].trim(), amount: parseFloat(m[2]) });
  }
  return items.length ? items : null;
}

// --- Date/time parsing ---

function parseDatetime(str) {
  const lower = str.toLowerCase();
  const now = new Date();
  let date = null;
  let time = null;

  // Extract time first (9am, 2pm, 14:00, 9:30am etc)
  const timeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const mins = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3];
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    time = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
  }

  // Parse date
  if (lower.includes('today')) {
    date = formatDateISO(now);
  } else if (lower.includes('tomorrow')) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    date = formatDateISO(d);
  } else {
    // Try day name (monday, tuesday, etc)
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const shortDays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    for (let i = 0; i < 7; i++) {
      if (lower.includes(days[i]) || lower.includes(shortDays[i])) {
        const target = i;
        const current = now.getDay();
        let diff = target - current;
        if (diff <= 0) diff += 7;
        const d = new Date(now);
        d.setDate(d.getDate() + diff);
        date = formatDateISO(d);
        break;
      }
    }
  }

  return { date, time };
}

function parseDoneDetails(str) {
  // Try to find amount: "total 140", "£140", just "140" at end
  let amount = null;
  let notes = str;

  const totalMatch = str.match(/(?:total|£)\s*(\d+(?:\.\d{1,2})?)/i);
  if (totalMatch) {
    amount = parseFloat(totalMatch[1]);
    notes = str.replace(totalMatch[0], '').trim();
  } else {
    // Check if the whole thing is just a number
    const justNumber = str.match(/^(\d+(?:\.\d{1,2})?)\s*$/);
    if (justNumber) {
      amount = parseFloat(justNumber[1]);
      notes = null;
    }
  }

  return { amount, notes: notes || null };
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

function formatDateISO(d) {
  return d.toISOString().split('T')[0];
}

module.exports = { parse, normalisePhone };
