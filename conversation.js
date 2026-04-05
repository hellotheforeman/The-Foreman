const db = require('./db');

const REQUIRED_FIELDS = {
  new_job: ['name', 'phone', 'address', 'description'],
  quote: ['jobId', 'amount'],
  schedule: ['jobId', 'date'],
  done: ['jobId'],
  paid: ['jobId'],
  send_invoice: ['jobId'],
  chase: ['jobId'],
  follow_up: ['jobId'],
  find: ['query'],
  view_schedule: ['period'],
  archive_job: ['jobId'],
};

const FIELD_PROMPTS = {
  name: 'Who is the customer?',
  phone: 'What is their phone number?',
  address: 'What is the address?',
  description: 'What is the job for?',
  postcode: 'What is the postcode?',
  jobId: 'Which customer or job do you mean?',
  amount: 'What amount should I use?',
  items: 'What should I put on the quote?',
  date: 'What day should I book it in for?',
  time: 'What time should I put down?',
  notes: 'Any notes I should include?',
  query: 'Who do you want me to look for?',
  period: 'Do you mean today, tomorrow, or this week?',
};

async function migrate() {
  await db.getAll(`
    CREATE TABLE IF NOT EXISTS conversation_state (
      business_id INTEGER PRIMARY KEY REFERENCES businesses(id),
      intent TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getState(businessId) {
  const row = await db.getAll('SELECT * FROM conversation_state WHERE business_id = $1 LIMIT 1', [businessId]);
  if (!row[0]) return null;
  return {
    ...row[0],
    payload: typeof row[0].payload === 'string' ? JSON.parse(row[0].payload) : row[0].payload,
    missing_fields: typeof row[0].missing_fields === 'string' ? JSON.parse(row[0].missing_fields) : row[0].missing_fields,
  };
}

async function clearState(businessId) {
  await db.getAll('DELETE FROM conversation_state WHERE business_id = $1', [businessId]);
}

async function setState(businessId, intent, payload, missingFields) {
  await db.getAll(
    `INSERT INTO conversation_state (business_id, intent, payload, missing_fields, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, NOW())
     ON CONFLICT (business_id)
     DO UPDATE SET intent = EXCLUDED.intent, payload = EXCLUDED.payload, missing_fields = EXCLUDED.missing_fields, updated_at = NOW()`,
    [businessId, intent, JSON.stringify(payload || {}), JSON.stringify(missingFields || [])]
  );
}

function missingFieldsForIntent(intent) {
  return REQUIRED_FIELDS[intent] || [];
}

function isMissing(value) {
  return value === undefined || value === null || value === '';
}

function computeMissing(intent, payload) {
  const required = missingFieldsForIntent(intent);
  return required.filter((field) => isMissing(payload[field]));
}

function formatJobChoices(jobs) {
  return jobs.map((job, index) => `${index + 1}) ${job.customer_name} — ${job.description}${job.address ? `, ${job.address}` : ''}`).join('\n');
}

function readChoice(intent) {
  const raw = (intent.raw || '').trim();
  if (/^[1-9]\d*$/.test(raw)) {
    return parseInt(raw, 10);
  }
  return null;
}

function buildPrompt(intent, missingFields) {
  if (!missingFields.length) return null;
  const [first] = missingFields;

  if (intent === 'new_job' && first === 'address') {
    return `Got it — I’ve got the customer and number. ${FIELD_PROMPTS.address}`;
  }

  if (intent === 'new_job' && first === 'description') {
    return `Nice — and what is the job for?`;
  }

  if (intent === 'quote' && first === 'jobId') {
    return `Which customer or job do you mean? You can just reply with the customer name.`;
  }

  if (intent === 'quote' && first === 'amount') {
    return `What price should I use on the quote?`;
  }

  if (intent === 'archive_job' && first === 'jobId') {
    return `Which customer or job should I archive? You can reply with the customer name.`;
  }

  if (intent === 'schedule' && first === 'date') {
    return `No problem — ${FIELD_PROMPTS.date}`;
  }

  return FIELD_PROMPTS[first] || 'I need a bit more information to do that.';
}

function mergeIntent(base, update) {
  const merged = {
    ...base,
    ...update,
    intent: base.intent || update.intent,
  };

  if (base.intent === 'new_job') {
    if (update.raw && !update.address && !base.address) {
      merged.address = update.raw;
    } else if (update.raw && !update.description && base.address) {
      merged.description = update.raw;
    }
  }

  if (base.intent === 'quote') {
    if (update.items) merged.items = update.items;
    if (update.amount) merged.amount = update.amount;
    const raw = (update.raw || '').trim();
    const looksLikeAmountOnly = /^£?\s*\d+(?:\.\d{1,2})?$/.test(raw);
    if (raw && !update.items && !base.items && !looksLikeAmountOnly) {
      merged.items = raw;
    }
  }

  return merged;
}

function looksLikeQuoteText(intent) {
  return Boolean(intent.amount || intent.items || (intent.raw && /(£|labou?r|material|door|boiler|quote|price|cost)/i.test(intent.raw)));
}

function extractLookupQuery(intent) {
  if (intent.query) return intent.query;
  if (intent.name) return intent.name;
  if (intent.raw) {
    const forMatch = intent.raw.match(/for\s+([a-z][a-z\s'.-]+)$/i);
    if (forMatch) return forMatch[1].trim();
    const quotedPerson = intent.raw.match(/(?:quote|invoice|chase|follow up|schedule)\s+(?:for\s+)?([a-z][a-z\s'.-]+)/i);
    if (quotedPerson) return quotedPerson[1].trim();
  }
  return intent.raw || '';
}

function looksLikeNewJobBare(intent) {
  return intent.intent === 'new_job' && !intent.address && !intent.description;
}

async function resolveMissingJobReference(state, intent, business) {
  const choice = readChoice(intent);
  if (choice && Array.isArray(state.payload.options) && state.payload.options[choice - 1]) {
    const selected = state.payload.options[choice - 1];
    const merged = mergeIntent({ intent: state.intent, ...state.payload }, { jobId: selected.id });
    delete merged.options;
    const missing = computeMissing(state.intent, merged);
    if (!missing.length) {
      await clearState(business.id);
      return { mode: 'resolved', intent: { ...merged, intent: state.intent } };
    }
    await setState(business.id, state.intent, merged, missing);
    return { mode: 'prompt', message: buildPrompt(state.intent, missing) };
  }

  const query = extractLookupQuery(intent).trim();
  if (!query || query.toLowerCase() === "i don't know" || query.toLowerCase() === 'idk') {
    const openJobs = await db.getOpenJobs(business.id);
    if (!openJobs.length) {
      return { mode: 'prompt', message: `I couldn't find any open jobs to use right now.` };
    }
    const options = openJobs.slice(0, 5);
    await setState(business.id, state.intent, { ...state.payload, options }, state.missing_fields);
    return {
      mode: 'prompt',
      message: `No problem — here are the open jobs I’ve got:\n${formatJobChoices(options)}\n\nReply with 1, 2 or 3.`,
    };
  }

  const likely = await db.findLikelyOpenJobs(business.id, query);
  if (likely.length === 1) {
    const merged = mergeIntent({ intent: state.intent, ...state.payload }, { jobId: likely[0].id });
    const missing = computeMissing(state.intent, merged);
    if (!missing.length) {
      await clearState(business.id);
      return { mode: 'resolved', intent: { ...merged, intent: state.intent } };
    }
    await setState(business.id, state.intent, merged, missing);
    return { mode: 'prompt', message: buildPrompt(state.intent, missing) };
  }

  if (likely.length > 1) {
    await setState(business.id, state.intent, { ...state.payload, options: likely }, state.missing_fields);
    return {
      mode: 'prompt',
      message: `I found a few matches:\n${formatJobChoices(likely)}\n\nReply with 1, 2 or 3.`,
    };
  }

  return {
    mode: 'prompt',
    message: `I couldn't match that to an open job. Try the customer name or what the job was for.`,
  };
}

async function resolveIntent(intent, business) {
  const state = await getState(business.id);

  if (state && state.missing_fields && state.missing_fields.includes('jobId') && (intent.intent === 'unknown' || intent.intent === 'quote' || intent.intent === 'find')) {
    return resolveMissingJobReference(state, intent, business);
  }

  if (state && (intent.intent === 'unknown' || intent.intent === 'confirm' || intent.intent === 'quote')) {
    const merged = mergeIntent({ intent: state.intent, ...state.payload }, intent);
    const missing = computeMissing(state.intent, merged);

    if (missing.length) {
      await setState(business.id, state.intent, merged, missing);
      return {
        mode: 'prompt',
        message: buildPrompt(state.intent, missing),
      };
    }

    await clearState(business.id);
    return {
      mode: 'resolved',
      intent: { ...merged, intent: state.intent },
    };
  }

  if (!state && intent.intent === 'archive_job' && !intent.jobId) {
    const query = extractLookupQuery(intent);
    const likely = await db.findLikelyOpenJobs(business.id, query);
    if (likely.length === 1) {
      await clearState(business.id);
      return {
        mode: 'resolved',
        intent: { intent: 'archive_job', jobId: likely[0].id },
      };
    }
    if (likely.length > 1) {
      await setState(business.id, 'archive_job', { intent: 'archive_job', options: likely }, ['jobId']);
      return {
        mode: 'prompt',
        message: `I found a few matches:\n${formatJobChoices(likely)}\n\nReply with 1, 2 or 3.`,
      };
    }
  }

  if (!state && intent.intent === 'quote' && !intent.jobId) {
    const query = extractLookupQuery(intent);
    const likely = await db.findLikelyOpenJobs(business.id, query);
    if (likely.length === 1) {
      const merged = {
        intent: 'quote',
        jobId: likely[0].id,
        amount: intent.amount,
        items: intent.items || likely[0].description,
      };
      const missing = computeMissing('quote', merged);
      await setState(business.id, 'quote', merged, missing);
      if (!missing.length) {
        await clearState(business.id);
        return {
          mode: 'resolved',
          intent: merged,
        };
      }

      return {
        mode: 'prompt',
        message: `I found ${db.formatJobId(likely[0].id)} for ${likely[0].customer_name} (${likely[0].description}). What price should I use?`,
      };
    }
  }

  if (!state && looksLikeNewJobBare(intent)) {
    const query = [intent.name, intent.phone, intent.raw].filter(Boolean).join(' ');
    const likely = await db.findLikelyOpenJobs(business.id, query);
    if (likely.length === 1) {
      await setState(business.id, 'quote', {
        intent: 'quote',
        jobId: likely[0].id,
        items: likely[0].description,
      }, ['amount']);
      return {
        mode: 'prompt',
        message: `I’ve already got ${db.formatJobId(likely[0].id)} open for ${likely[0].customer_name} (${likely[0].description}). What price should I use on the quote?`,
      };
    }
  }

  if (!state && (intent.intent === 'unknown' || intent.intent === 'quote') && looksLikeQuoteText(intent)) {
    const openJobs = await db.getOpenJobs(business.id);
    if (openJobs.length === 1) {
      return {
        mode: 'resolved',
        intent: {
          intent: 'quote',
          jobId: openJobs[0].id,
          amount: intent.amount,
          items: intent.items || intent.raw,
        },
      };
    }
  }

  const missing = computeMissing(intent.intent, intent);
  if (missing.length) {
    await setState(business.id, intent.intent, intent, missing);
    return {
      mode: 'prompt',
      message: buildPrompt(intent.intent, missing),
    };
  }

  if (state) {
    await clearState(business.id);
  }

  return {
    mode: 'resolved',
    intent,
  };
}

async function beginFlow(businessId, intent, payload) {
  const missing = computeMissing(intent, { intent, ...payload });
  await setState(businessId, intent, { intent, ...payload }, missing);
  return buildPrompt(intent, missing) || null;
}

module.exports = {
  migrate,
  resolveIntent,
  clearState,
  beginFlow,
};
