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

  // --- New job ---
  // "new job Mrs Patel 07700900123 boiler service BD7 1AH"
  const newJobMatch = text.match(
    /^new\s+(?:job\s+)?(.+?)\s+((?:\+?44|0)7\d{8,9})\s+(.+?)(?:\s+([A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2}))?\s*$/i
  );
  if (newJobMatch) {
    return {
      kind: 'command',
      intent: 'new_job',
      name: newJobMatch[1].trim(),
      phone: normalisePhone(newJobMatch[2]),
      description: newJobMatch[3].trim(),
      postcode: newJobMatch[4] ? newJobMatch[4].toUpperCase() : null,
    };
  }

  // --- Quote ---
  // "quote 42 85 for service" or "quote #0042 £85 boiler service and valve"
  const quoteMatch = text.match(
    /^quote\s+#?(\d+)\s+£?(\d+(?:\.\d{1,2})?)\s*(?:for\s+)?(.+)$/i
  );
  if (quoteMatch) {
    return {
      kind: 'command',
      intent: 'quote',
      jobId: parseInt(quoteMatch[1], 10),
      amount: parseFloat(quoteMatch[2]),
      items: quoteMatch[3].trim(),
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
  const doneMatch = text.match(
    /^(?:done|complete|finished)\s+#?(\d+)\s+(.+)$/i
  );
  if (doneMatch) {
    const { amount, notes } = parseDoneDetails(doneMatch[2]);
    return {
      kind: 'command',
      intent: 'done',
      jobId: parseInt(doneMatch[1], 10),
      amount,
      notes,
      raw: doneMatch[2].trim(),
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
  // "invoice 42" or "send invoice 42"
  const invoiceMatch = lower.match(/^(?:send\s+)?invoice\s+#?(\d+)\s*$/);
  if (invoiceMatch) {
    return { kind: 'command', intent: 'send_invoice', jobId: parseInt(invoiceMatch[1], 10) };
  }

  // --- Chase ---
  // "chase 42"
  const chaseMatch = lower.match(/^chase\s+#?(\d+)\s*$/);
  if (chaseMatch) {
    return { kind: 'command', intent: 'chase', jobId: parseInt(chaseMatch[1], 10) };
  }

  // --- Follow up ---
  // "follow up 42" or "followup 42"
  const followMatch = lower.match(/^follow\s*up\s+#?(\d+)\s*$/);
  if (followMatch) {
    return { kind: 'command', intent: 'follow_up', jobId: parseInt(followMatch[1], 10) };
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

  // --- Set payment details ---
  const paymentMatch = text.match(/^(?:(?:set|update)\s+)?(?:payment|bank)\s+(?:details?|info)\s*[:\-]?\s*(.+)$/i);
  if (paymentMatch) {
    return { kind: 'command', intent: 'set_payment', details: paymentMatch[1].trim() };
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
