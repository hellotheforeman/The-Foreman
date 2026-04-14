const OpenAI = require('openai');

let client = null;

function getClient() {
  if (!client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');
    client = new OpenAI({ apiKey });
  }
  return client;
}

// Single tool definition — the model must call this with the parsed intent.
// Maps directly to the intent schema consumed by the workflow engine and handlers.
const DISPATCH_TOOL = {
  type: 'function',
  function: {
    name: 'dispatch_intent',
    description: 'Extract the tradesperson\'s intent and structured fields from their WhatsApp message.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['command', 'query'],
          description: 'command = an action to perform; query = a request for information',
        },
        intent: {
          type: 'string',
          enum: [
            // Commands
            'new_customer', 'new_job', 'quote', 'schedule', 'reschedule', 'add_block',
            'send_invoice', 'amend_invoice', 'paid', 'chase', 'review',
            'cancel_job', 'mark_complete', 'add_note', 'update_customer',
            // Queries
            'view_schedule', 'unpaid', 'open_jobs', 'unscheduled_jobs',
            'jobs_by_status', 'view_job', 'find', 'earnings', 'settings', 'help',
          ],
          description: 'The specific intent identified from the message.',
        },
        jobId: {
          type: 'integer',
          description: 'Numeric job ID when explicitly mentioned, e.g. "job 14" or "#0014" → 14.',
        },
        jobRef: {
          type: 'string',
          description: 'Customer name or job description when no job number is given, e.g. "Mrs Patel" or "boiler service".',
        },
        amount: {
          type: 'number',
          description: 'Monetary amount in GBP as a number, e.g. 450 or 85.50. Do not include currency symbols.',
        },
        items: {
          type: 'string',
          description: 'Line items as raw text, e.g. "Labour 200, Parts 50, Callout 40".',
        },
        date: {
          type: 'string',
          description: 'Date in YYYY-MM-DD format. Resolve relative expressions like "thursday", "next monday", "2nd May" using today\'s date. Always use the next upcoming occurrence.',
        },
        time: {
          type: 'string',
          description: 'Time in HH:MM 24-hour format, e.g. "09:00" or "14:30".',
        },
        duration: {
          type: 'number',
          description: 'Duration value, e.g. 3 (for "3 days" or "2 hours").',
        },
        durationUnit: {
          type: 'string',
          enum: ['hours', 'days'],
          description: 'Unit for the duration field.',
        },
        period: {
          type: 'string',
          enum: ['today', 'tomorrow', 'this_week', 'next_week', 'week_after_next', 'date', 'week_of'],
          description: 'Schedule view period. Use "date" when a specific date is given. Use "week_of" when a date is given as a week anchor.',
        },
        status: {
          type: 'string',
          enum: ['new', 'in progress', 'complete', 'cancelled', 'outstanding'],
          description: 'Job status for the jobs_by_status query.',
        },
        name: {
          type: 'string',
          description: 'Customer full name for new_customer or new_job.',
        },
        phone: {
          type: 'string',
          description: 'UK phone number, e.g. 07700900123 or +447700900123.',
        },
        email: {
          type: 'string',
          description: 'Email address.',
        },
        description: {
          type: 'string',
          description: 'Job description for new_job.',
        },
        note: {
          type: 'string',
          description: 'Note text for add_note intent.',
        },
        query: {
          type: 'string',
          description: 'Search string for the find intent.',
        },
        field: {
          type: 'string',
          description: 'Field name to update for update_customer (name, phone, email, address).',
        },
        value: {
          type: 'string',
          description: 'New value for the update_customer field.',
        },
      },
      required: ['kind', 'intent'],
    },
  },
};

function buildSystemPrompt(today) {
  return `You are an intent parser for The Foreman — a WhatsApp business assistant for UK sole traders (plumbers, electricians, builders, decorators etc.).

Today's date is ${today}. The week starts on Monday.

Your only job is to call dispatch_intent with the correct intent and fields extracted from the tradesperson's message. Never reply in plain text.

DATE RULES:
- Resolve all relative dates to YYYY-MM-DD using today's date.
- "Thursday" or "this Thursday" = the next Thursday from today.
- "Next Thursday" = the Thursday of next week (7–13 days away).
- "The 3rd" or "3rd May" = the next upcoming occurrence of that date.
- If a date has already passed this month, use next month.

FIELD RULES:
- Use jobId (integer) when a job number is explicitly mentioned. Use jobRef (string) otherwise.
- Amounts must be numbers only — no £ symbols, no words like "four fifty".
- Phone numbers must be UK format: 07xxx or +447xxx.
- For view_schedule with "today" / "tomorrow" / "this week" / "next week": set period only, no date field.
- For view_schedule with a specific date: set period="date" and the date field.

INTENT GUIDE:
- new_customer: "add a customer", "new customer John Smith 07700900123"
- new_job: "new job", "add a job for Mrs Patel"
- quote: "quote job 14", "send quote to Patel", "requote 14 850"
- schedule: "book job 14 thursday 9am", "schedule Mrs Patel friday"
- reschedule: "move job 14 to monday", "reschedule boiler service"
- add_block: "and then friday", "also next tuesday"
- send_invoice: "invoice job 14", "invoice Mrs Patel 450"
- amend_invoice: "amend invoice 14", "change invoice 14 to 500"
- paid: "paid 14", "job 14 paid", "mark 14 as paid"
- chase: "chase 14", "send reminder for job 14"
- review: "review 14", "ask Patel for a review"
- cancel_job: "cancel job 14"
- mark_complete: "complete 14", "done 14", "mark job 14 as done"
- add_note: "note on job 14: customer wants callback"
- update_customer: "update Patel's phone to 07700900456"
- view_schedule: "today", "this week", "thursday", "what's on 14th April"
- unpaid: "unpaid", "outstanding invoices"
- open_jobs: "jobs", "open jobs", "pipeline"
- unscheduled_jobs: "unscheduled", "not booked in"
- jobs_by_status: "new jobs", "in progress", "completed jobs"
- view_job: "job 14", "show me job 3"
- find: "find Mrs Patel", "look up Smith"
- earnings: "earnings", "how much have I made this month"
- settings: "settings", "change my business name"
- help: "help", "what can you do"`;
}

async function parseWithAI(rawMessage) {
  const today = new Date().toISOString().split('T')[0];

  try {
    const openai = getClient();

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildSystemPrompt(today) },
        { role: 'user', content: rawMessage },
      ],
      tools: [DISPATCH_TOOL],
      tool_choice: { type: 'function', function: { name: 'dispatch_intent' } },
      temperature: 0,
    });

    const toolCall = response.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      console.warn('AI parser: no tool call returned');
      return null;
    }

    let args;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      console.warn('AI parser: could not parse tool arguments');
      return null;
    }

    if (!args.kind || !args.intent) return null;

    console.log(`🤖 AI parsed "${rawMessage}" → ${args.intent}`);
    return args;

  } catch (err) {
    console.error('AI parser error:', err.message);
    return null;
  }
}

module.exports = { parseWithAI };
