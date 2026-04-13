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

  // Job ID only — no amount or items: "quote 14" → triggers guided workflow
  const quoteJustIdMatch = lower.match(/^quote\s+#?(\d+)\s*$/);
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

  // --- Schedule / Book ---
  // "schedule 42 thursday 9am", "book 14 friday at 10", "book job 14 for 2 days from tuesday"
  const scheduleMatch = text.match(
    /^(?:book(?:\s+job)?|schedule)\s+#?(\d+)\s+(.+)$/i
  );
  if (scheduleMatch) {
    const { date, time, duration, durationUnit } = parseDatetime(scheduleMatch[2].trim());
    return {
      kind: 'command',
      intent: 'schedule',
      jobId: parseInt(scheduleMatch[1], 10),
      date,
      time,
      duration: duration || null,
      durationUnit: durationUnit || null,
      raw: scheduleMatch[2].trim(),
    };
  }

  // --- Follow-up block ---
  // "and then 3 days from following monday", "also friday at 9"
  const addBlockMatch = text.match(/^(?:and\s+then|also|followed\s+by|then)\s+(.+)$/i);
  if (addBlockMatch) {
    const { date, time, duration, durationUnit } = parseDatetime(addBlockMatch[1].trim());
    return {
      kind: 'command',
      intent: 'add_block',
      jobId: null,
      date,
      time,
      duration: duration || null,
      durationUnit: durationUnit || null,
      raw: addBlockMatch[1].trim(),
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
  // "reschedule 14 to thursday 9am", "reschedule job 14 to Thursday at 9"
  const rescheduleMatch = text.match(/^(?:reschedule|rebook|move)\s+(?:job\s+)?#?(\d+)\s+(?:to\s+)?(.+)$/i);
  if (rescheduleMatch) {
    const { date, time, duration, durationUnit } = parseDatetime(rescheduleMatch[2].trim());
    return {
      kind: 'command',
      intent: 'reschedule',
      jobId: parseInt(rescheduleMatch[1], 10),
      date,
      time,
      duration: duration || null,
      durationUnit: durationUnit || null,
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
  const updateCustomerMatch = text.match(/^update\s+(?:customer\s+)?(.+?)\s+(name|phone|email|address|postcode)\s+(.+)$/i);
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

  // --- Schedule view ---
  if (/^(today|tomorrow|this week|next week|week after next|schedule|diary|what'?s on)\s*(today|tomorrow)?\s*$/i.test(lower)) {
    let period = 'today';
    if (lower.includes('tomorrow')) period = 'tomorrow';
    else if (lower.includes('week after next')) period = 'week_after_next';
    else if (lower.includes('next week')) period = 'next_week';
    else if (lower.includes('this week') || lower.includes('week')) period = 'week';
    return { kind: 'query', intent: 'view_schedule', period };
  }

  // Week of a specific date: "week of 27th April", "week starting 27 April", "w/c 27th"
  const weekOfMatch = lower.match(/^(?:week\s+(?:of|starting|commencing|from)|w\/c)\s+(.+)$/);
  if (weekOfMatch) {
    const { date } = parseDatetime(weekOfMatch[1].trim());
    if (date) {
      const d = new Date(date);
      const day = d.getDay();
      d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day)); // rewind to Monday
      return { kind: 'query', intent: 'view_schedule', period: 'week_of', date: d.toISOString().split('T')[0] };
    }
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

// --- Date/time parsing ---

const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const SHORT_MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const SHORT_DAY_NAMES = ['sun','mon','tue','wed','thu','fri','sat'];
const ALL_MONTHS_PATTERN = [...MONTH_NAMES, ...SHORT_MONTH_NAMES].join('|');

function parseDatetime(str) {
  const lower = str.toLowerCase().trim();
  const now = new Date();
  let date = null;
  let time = null;
  let duration = null;
  let durationUnit = null;

  // --- Duration: "for 2 days", "2 days from tuesday", "3 hours" ---
  const durationMatch = lower.match(/\b(?:for\s+)?(\d+)\s+(hour|day)s?\b/);
  if (durationMatch) {
    duration = parseInt(durationMatch[1], 10);
    durationUnit = durationMatch[2] === 'hour' ? 'hours' : 'days';
  }

  // --- Time (most specific first to avoid false matches) ---

  // 1. Explicit am/pm: "9am", "2pm", "9:30am", "14:30pm"
  const ampmMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1], 10);
    const m = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    if (ampmMatch[3] === 'pm' && h < 12) h += 12;
    if (ampmMatch[3] === 'am' && h === 12) h = 0;
    time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // 2. "at HH[:MM]" — unambiguous time prefix
  if (!time) {
    const atMatch = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
    if (atMatch) {
      const h = parseInt(atMatch[1], 10);
      const m = atMatch[2] ? parseInt(atMatch[2], 10) : 0;
      time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }

  // 3. HH:MM with colon (24-hour, both sides exactly)
  if (!time) {
    const hmMatch = lower.match(/\b(\d{2}):(\d{2})\b/);
    if (hmMatch) {
      time = `${hmMatch[1]}:${hmMatch[2]}`;
    }
  }

  // --- Date (most specific first) ---

  // 1. ISO: 2026-03-12
  const isoMatch = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    date = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    return { date, time, duration, durationUnit };
  }

  // 2. UK short date: 12/03 or 12/03/26 or 12/03/2026
  const ukMatch = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (ukMatch) {
    const day = parseInt(ukMatch[1], 10);
    const month = parseInt(ukMatch[2], 10);
    let year = ukMatch[3] ? parseInt(ukMatch[3], 10) : null;
    if (year !== null && year < 100) year += 2000;
    if (year === null) {
      year = now.getFullYear();
      if (new Date(year, month - 1, day) < now) year++;
    }
    date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { date, time, duration, durationUnit };
  }

  // 3. Month name + day: "march 12" or "march 12th"
  const monthDayRe = new RegExp(`\\b(${ALL_MONTHS_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`);
  const monthDayMatch = lower.match(monthDayRe);
  if (monthDayMatch) {
    const mName = monthDayMatch[1];
    const mIdx = MONTH_NAMES.indexOf(mName) !== -1 ? MONTH_NAMES.indexOf(mName) : SHORT_MONTH_NAMES.indexOf(mName);
    const day = parseInt(monthDayMatch[2], 10);
    let year = now.getFullYear();
    if (new Date(year, mIdx, day) < now) year++;
    date = `${year}-${String(mIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { date, time, duration, durationUnit };
  }

  // 4. Day + month name: "12th march" or "12 march"
  const dayMonthRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${ALL_MONTHS_PATTERN})\\b`);
  const dayMonthMatch = lower.match(dayMonthRe);
  if (dayMonthMatch) {
    const day = parseInt(dayMonthMatch[1], 10);
    const mName = dayMonthMatch[2];
    const mIdx = MONTH_NAMES.indexOf(mName) !== -1 ? MONTH_NAMES.indexOf(mName) : SHORT_MONTH_NAMES.indexOf(mName);
    let year = now.getFullYear();
    if (new Date(year, mIdx, day) < now) year++;
    date = `${year}-${String(mIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { date, time, duration, durationUnit };
  }

  // 5. Ordinal day only: "12th", "1st" — no month specified
  // Requires the ordinal suffix to distinguish from bare numbers
  const ordinalMatch = lower.match(/\b(\d{1,2})(st|nd|rd|th)\b/);
  if (ordinalMatch) {
    const day = parseInt(ordinalMatch[1], 10);
    let year = now.getFullYear();
    let month = now.getMonth();
    // If the day of month has already passed this month, use next month
    if (day <= now.getDate()) {
      month++;
      if (month > 11) { month = 0; year++; }
    }
    date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { date, time, duration, durationUnit };
  }

  // 6. today / tomorrow
  if (lower.includes('today')) {
    date = formatDateISO(now);
    return { date, time, duration, durationUnit };
  }
  if (lower.includes('tomorrow')) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    date = formatDateISO(d);
    return { date, time, duration, durationUnit };
  }

  // 7. "next week" → Monday of next week
  if (/\bnext\s+week\b/.test(lower)) {
    const d = new Date(now);
    const daysToNextMon = ((1 - d.getDay() + 7) % 7) || 7;
    d.setDate(d.getDate() + daysToNextMon);
    date = formatDateISO(d);
    return { date, time, duration, durationUnit };
  }

  // 8. "following [day]" → next occurrence + 7
  const followingMatch = lower.match(/\bfollowing\s+(\w+)\b/);
  if (followingMatch) {
    const name = followingMatch[1];
    for (let i = 0; i < 7; i++) {
      if (DAY_NAMES[i] === name || SHORT_DAY_NAMES[i] === name) {
        const current = now.getDay();
        let diff = i - current;
        if (diff <= 0) diff += 7;
        diff += 7; // one week further
        const d = new Date(now);
        d.setDate(d.getDate() + diff);
        date = formatDateISO(d);
        return { date, time, duration, durationUnit };
      }
    }
  }

  // 9. Day names — "monday", "next monday", "fri", etc.
  // Strip "next" prefix so "next monday" behaves the same as "monday"
  const strForDays = lower.replace(/\bnext\s+/, '');
  for (let i = 0; i < 7; i++) {
    if (strForDays.includes(DAY_NAMES[i]) || strForDays.includes(SHORT_DAY_NAMES[i])) {
      const current = now.getDay();
      let diff = i - current;
      if (diff <= 0) diff += 7;
      const d = new Date(now);
      d.setDate(d.getDate() + diff);
      date = formatDateISO(d);
      break;
    }
  }

  return { date, time, duration, durationUnit };
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

module.exports = { parse, normalisePhone, parseLineItems };
