/**
 * Intent parser — regex-based for MVP.
 * Parses tradesperson messages into structured intents.
 * Designed to handle fuzzy, on-site typing.
 */

const { parseJobId } = require('./db');

// Normalise input: trim, collapse whitespace, lowercase
function normalise(text) {
  return text.trim().replace(/\s+/g, ' ');
}

function parse(raw) {
  const text = normalise(raw);
  const lower = text.toLowerCase();

  // --- Confirmation (yes/send/go/confirm) ---
  if (/^(yes|yep|yeah|y|send|go|confirm|ok|do it|sure|approved?)$/i.test(lower)) {
    return { intent: 'confirm' };
  }

  // --- Cancel pending action ---
  if (/^(no|nah|cancel|skip|nope|don'?t)$/i.test(lower)) {
    return { intent: 'cancel' };
  }

  // --- New job ---
  // "new job Mrs Patel 07700900123 boiler service BD7 1AH"
  const newJobMatch = text.match(
    /^new\s+(?:job\s+)?(.+?)\s+((?:\+?44|0)7\d{8,9})\s+(.+?)(?:\s+([A-Z]{1,2}\d{1,2}\s?\d[A-Z]{2}))?\s*$/i
  );
  if (newJobMatch) {
    return {
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
    return { intent: 'paid', jobId: parseInt(paidMatch[1], 10) };
  }

  // --- Invoice (send) ---
  // "invoice 42" or "send invoice 42"
  const invoiceMatch = lower.match(/^(?:send\s+)?invoice\s+#?(\d+)\s*$/);
  if (invoiceMatch) {
    return { intent: 'send_invoice', jobId: parseInt(invoiceMatch[1], 10) };
  }

  // --- Chase ---
  // "chase 42"
  const chaseMatch = lower.match(/^chase\s+#?(\d+)\s*$/);
  if (chaseMatch) {
    return { intent: 'chase', jobId: parseInt(chaseMatch[1], 10) };
  }

  // --- Follow up ---
  // "follow up 42" or "followup 42"
  const followMatch = lower.match(/^follow\s*up\s+#?(\d+)\s*$/);
  if (followMatch) {
    return { intent: 'follow_up', jobId: parseInt(followMatch[1], 10) };
  }

  // --- Schedule view ---
  if (/^(today|tomorrow|this week|next week|schedule|diary|what'?s on)\s*(today|tomorrow)?$/i.test(lower)) {
    let period = 'today';
    if (lower.includes('tomorrow')) period = 'tomorrow';
    else if (lower.includes('this week') || lower.includes('next week')) period = 'week';
    return { intent: 'view_schedule', period };
  }

  // --- Unpaid / overdue ---
  if (/^(unpaid|overdue|outstanding|owed)$/i.test(lower)) {
    return { intent: 'unpaid' };
  }

  // --- Open jobs ---
  if (/^(jobs|open|active|pipeline)$/i.test(lower)) {
    return { intent: 'open_jobs' };
  }

  // --- Find customer ---
  const findMatch = text.match(/^find\s+(.+)$/i);
  if (findMatch) {
    return { intent: 'find', query: findMatch[1].trim() };
  }

  // --- Help ---
  if (/^(help|commands|what can you do|how does this work|\?)$/i.test(lower)) {
    return { intent: 'help' };
  }

  // --- Unknown ---
  return { intent: 'unknown', raw: text };
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

  // Fallback: if no date parsed but we have a time, assume today or tomorrow
  if (!date && time) {
    date = formatDateISO(now);
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
