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
};

const FIELD_PROMPTS = {
  name: 'Who is the customer?',
  phone: 'What is their phone number?',
  address: 'What is the address?',
  description: 'What is the job for?',
  postcode: 'What is the postcode?',
  jobId: 'Which job number is this for?',
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
  return row[0] || null;
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

function buildPrompt(intent, missingFields) {
  if (!missingFields.length) return null;
  const [first] = missingFields;

  if (intent === 'new_job' && first === 'address') {
    return `Got it — I’ve got the customer and number. ${FIELD_PROMPTS.address}`;
  }

  if (intent === 'new_job' && first === 'description') {
    return `Nice — and what is the job for?`;
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

  return merged;
}

async function resolveIntent(intent, business) {
  const state = await getState(business.id);

  if (state && (intent.intent === 'unknown' || intent.intent === 'confirm')) {
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

module.exports = {
  migrate,
  resolveIntent,
  clearState,
};
