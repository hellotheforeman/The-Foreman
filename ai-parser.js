const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const FOREMAN_CONTEXT = fs.readFileSync(path.join(__dirname, 'foreman-context.md'), 'utf8');

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
            'new_customer', 'new_job', 'quote',
            'send_invoice', 'resend_invoice', 'resend_quote', 'amend_invoice', 'amend_quote', 'paid', 'chase', 'review',
            'cancel_job', 'mark_complete', 'add_note', 'update_customer',
            // Queries
            'unpaid', 'open_jobs',
            'jobs_by_status', 'find', 'list_customers', 'earnings',
            'financial_summary', 'conversion_rate', 'avg_payment_time',
            'settings', 'help', 'pricing',
            'greeting', 'thanks',
          ],
          description: 'The specific intent identified from the message.',
        },
        jobRef: {
          type: 'string',
          description: 'Customer name, e.g. "Mrs Patel" or "Darren". Always use this — never use a job number.',
        },
        amount: {
          type: 'number',
          description: 'Monetary amount in GBP as a number, e.g. 450 or 85.50. Do not include currency symbols.',
        },
        items: {
          type: 'string',
          description: 'Line items as raw text, e.g. "Labour 200, Parts 50, Callout 40".',
        },
        status: {
          type: 'string',
          enum: ['quoted', 'invoiced', 'paid', 'cancelled'],
          description: 'Job status for the jobs_by_status query.',
        },
        period: {
          type: 'string',
          description: 'Time period for earnings/stats queries. Use: "today", "week", "month", "year", or "last_N_days"/"last_N_weeks"/"last_N_months" (e.g. "last_3_months", "last_90_days"). Default: "month".',
        },
        name: {
          type: 'string',
          description: 'Customer full name for new_customer, new_job, or paid (when customer name is mentioned, e.g. "Joe Duck now paid").',
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

const REPLY_TOOL = {
  type: 'function',
  function: {
    name: 'reply_directly',
    description: 'Send a plain-English reply to a general question about The Foreman (what it does, pricing, features, how to sign up, etc.). Only use this when the message cannot be mapped to a specific intent.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The reply to send to the tradesperson. Keep it brief and friendly.',
        },
      },
      required: ['message'],
    },
  },
};

function buildSystemPrompt(today, userStatus = 'Unknown.') {
  return `You are an intent parser for The Foreman — a WhatsApp business assistant for UK sole traders (plumbers, electricians, builders, decorators etc.).

Today's date is ${today}. The week starts on Monday.

Your only job is to call dispatch_intent with the correct intent and fields. Never reply in plain text.

FIELD RULES:
- Always use jobRef (customer name) to identify who a message is about. Never use jobId — users don't know job numbers exist.
- Amounts must be numbers only — no £ symbols, no words like "four fifty".
- Phone numbers must be UK format: 07xxx or +447xxx.

COMMAND PHRASING:
- "Can you X", "Can I X", "I'd like to X", "I want to X", "can we X", "how do I X" are always commands, not questions. Map to the appropriate intent.

INTENT GUIDE:
- new_customer: explicit request to save a contact with no job yet — "add a customer", "new customer John Smith 07700900123", "save Mrs Jones as a contact", "add a new client"
- new_job: explicit request to log a job without quoting — "new job for Mrs Patel", "log a job for Smith", "add a job for Darren", "I've got a new job"
- quote: create or send a quote — "quote for Mrs Smith", "send a quote to Patel", "put a quote together for Darren", "get a price out to Smith", "I need to quote for a bathroom job for Mrs Jones", "create a quote for the boiler refit", "need to send a quote to Jones" — use jobRef for customer name, items for description/scope
- send_invoice: create a new invoice — "invoice Mrs Patel", "send Darren an invoice", "get an invoice out to Smith", "invoice for the work I did for Patel", "create an invoice", "build me an invoice" — use jobRef for customer name; if no name given return null jobRef (never use reply_directly)
- resend_invoice: retrieve or resend an existing invoice — "give me Chloe's invoice", "resend the invoice to Smith", "send me Patel's invoice again", "share Darren's invoice", "share with me the invoice for Chloe", "share with me Chloe's invoice", "forward the invoice to Jones", "what was the invoice for Smith", "can I get the invoice for Darren" — use jobRef for name
- resend_quote: retrieve or resend an existing quote — "give me Smith's quote", "resend the quote to Patel", "share Mrs Jones's quote", "share with me the quote for Smith", "share with me Smith's quote", "forward the quote to Darren", "what was the quote for Smith", "can I get the quote for Patel" — use jobRef for name
- amend_quote: change an existing quote — "amend the quote", "change the quote for Smith", "knock the price down", "update the quote for Patel", "wrong price on the quote", "requote Smith at 850", "the quote needs to be higher"
- amend_invoice: change an existing invoice — "amend the invoice", "wrong amount on the invoice", "update the price on Patel's invoice", "fix the invoice", "change the invoice for Smith"
- paid: mark a job as paid — "Darren's paid", "Smith paid up", "just got paid by Patel", "payment received from Mrs Jones", "money's in from Darren", "mark Smith as paid", "Jones has settled" — use jobRef for name
- chase: send a payment reminder — "chase Darren", "send Smith a reminder", "nudge Patel about their invoice", "follow up with Mrs Jones", "chase up Smith's payment", "send a chaser to Darren" — use jobRef for name
- review: request a review from a customer — "ask Patel for a review", "send Smith a review request", "can you get a review from Darren", "ask Mrs Jones to leave a review" — use jobRef for name
- cancel_job: drop or cancel a quote/job — "cancel the quote for Mrs Smith", "lost the Smith job", "didn't get that one", "not getting the Patel job", "drop the quote for Darren", "Smith went elsewhere" — use jobRef for name
- mark_complete: mark a job as finished — "Darren's done", "finished the Smith job", "all done for Patel", "wrapped up with Mrs Jones", "job's done for Darren", "mark Patel as complete" — use jobRef for name
- add_note: add a note to a job — "note for Darren: customer wants callback", "add a note on Smith's job", "make a note for Patel: early start", "note on the Jones job: no parking" — use jobRef for name, note text in note field
- update_customer: update a customer's contact details — "update Smith's phone to 07700900456", "change Patel's email", "Darren's got a new number", "Mrs Jones's address has changed" — use jobRef for name
- unpaid: view outstanding invoices — "unpaid", "who owes me money", "outstanding invoices", "what's still owed", "who hasn't paid", "how many days ago did I invoice Patel", "when did I invoice Smith" — use jobRef for name where given
- open_jobs: view all current open work — "jobs", "open jobs", "what have I got on", "show me what's on", "what's in my pipeline", "what jobs do I have", "what am I working on"
- jobs_by_status: view jobs by status — "what quotes do I have out", "quotes out", "my quotes", "outstanding quotes" → status=quoted; "invoiced jobs", "what's been invoiced", "invoices out" → status=invoiced; "paid jobs", "completed jobs", "done jobs", "jobs I've done" → status=paid; "cancelled jobs" → status=cancelled
- find: look up any customer or job — "show me Darren's details", "pull up Mrs Patel", "what's on for Smith", "where are we with Jones", "find Mrs Patel", "look up Smith", "do I have a customer called Smith", "have I worked for Darren before", "what have I got for Patel" — use query field for the customer name. For documents use resend_quote or resend_invoice instead.
- list_customers: list all customers — "customers", "all my customers", "show me my customers", "who are my customers", "list everyone I've worked for"
- earnings: income for a period — "how much have I made this month", "what have I turned over this week", "what did I earn last month", "how much came in this year". Periods: "last 3 months" → last_3_months, "last quarter" → last_3_months, "this year" → year, "this week" → week. Default: month.
- financial_summary: overall business overview — "how's business", "stats", "how am I doing", "give me an overview", "how have I done this year"
- conversion_rate: "what's my conversion rate", "how many quotes am I winning", "what percentage of quotes do I win"
- avg_payment_time: "how long does it take to get paid", "average payment time", "how quickly do customers pay"
- settings: any request to view or update business details — always dispatch here, never reply_directly. Covers all of: business name, trade, email, address, bank details / sort code / account number, VAT registration and VAT number, logo, payment terms. Examples: "change my business name", "I'm VAT registered", "add my VAT number", "update my bank details", "upload my logo", "set my payment terms to 30 days", "change my email", "update my address", "I'm a plumber not an electrician", "settings", "update my profile"
- help: "help", "what can you do", "what are my options", "what do you help with"
- pricing: "how much does this cost", "is this free", "what's the price", "is there a subscription", "do I have to pay"
- greeting: "hi", "hello", "hey", "morning", "alright", "yo", "hiya"
- thanks: "thanks", "cheers", "thank you", "brilliant", "perfect", "great", "nice one"

TOOL CHOICE:
- Use dispatch_intent for anything the tradesperson wants to DO or QUERY.
- Use reply_directly ONLY for open-ended product questions that genuinely don't map to any intent — e.g. "how does quoting work?", "can you contact my customers directly?". Never give tax or legal advice. Never compare to competitors.

PRODUCT CONTEXT (for reply_directly only):
${FOREMAN_CONTEXT}

USER STATUS:
${userStatus}`;
}

async function parseWithAI(rawMessage, userContext = {}) {
  const today = new Date().toISOString().split('T')[0];
  const userStatus = userContext.onboarded
    ? `Already set up on The Foreman as "${userContext.businessName}". If they ask how to get started or sign up, tell them they're already set up and point them to what they can do instead (e.g. quote, invoice, jobs, help).`
    : 'Not yet set up.';

  try {
    const openai = getClient();

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildSystemPrompt(today, userStatus) },
        { role: 'user', content: rawMessage },
      ],
      tools: [DISPATCH_TOOL, REPLY_TOOL],
      tool_choice: 'required',
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

    if (toolCall.function.name === 'reply_directly') {
      if (!args.message) return null;
      console.log(`🤖 AI direct reply for "${rawMessage}"`);
      return { type: 'reply', message: args.message };
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
