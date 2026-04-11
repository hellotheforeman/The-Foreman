const assert = require('assert');
const { parse } = require('./parser');
const templates = require('./templates');
const workflowEngine = require('./workflow-engine');

function testParseNewJob() {
  const result = parse('new job Mrs Patel 07700900123 boiler service BD7 1AH');
  assert.equal(result.kind, 'command');
  assert.equal(result.intent, 'new_job');
  assert.equal(result.name, 'Mrs Patel');
  assert.equal(result.phone, '+447700900123');
  assert.equal(result.description, 'boiler service');
  assert.equal(result.postcode, 'BD7 1AH');
}

function testParseQuote() {
  const result = parse('quote 12 85 boiler service');
  assert.equal(result.kind, 'command');
  assert.equal(result.intent, 'quote');
  assert.equal(result.jobId, 12);
  assert.equal(result.amount, 85);
  assert.equal(result.items, 'boiler service');
}

function testParseSchedule() {
  const result = parse('schedule 12 thursday 9am');
  assert.equal(result.kind, 'command');
  assert.equal(result.intent, 'schedule');
  assert.equal(result.jobId, 12);
  assert.ok(result.date);
  assert.equal(result.time, '09:00');
}

function testParseScheduleWithoutDateDoesNotAssumeToday() {
  const result = parse('schedule 12 9am');
  assert.equal(result.kind, 'command');
  assert.equal(result.intent, 'schedule');
  assert.equal(result.jobId, 12);
  assert.equal(result.time, '09:00');
  assert.equal(result.date, null);
}

function testParseQueriesAndContinuations() {
  const jobs = parse('jobs');
  assert.equal(jobs.kind, 'query');
  assert.equal(jobs.intent, 'open_jobs');

  const yes = parse('yes');
  assert.equal(yes.kind, 'continuation');
  assert.equal(yes.intent, 'confirm');

  const cancel = parse('cancel');
  assert.equal(cancel.kind, 'continuation');
  assert.equal(cancel.intent, 'cancel');
}

function testTemplateRendering() {
  const business = {
    name: 'Boiler & Co',
  };

  const customer = {
    name: 'Mrs Patel',
    phone: '+447700900123',
  };

  const job = {
    id: 12,
    description: 'Boiler service',
    quote_items: 'Boiler service',
    quoted_amount: 85,
    scheduled_date: '2026-04-09',
    scheduled_time: '09:00',
    postcode: 'BD7 1AH',
  };

  const invoice = {
    amount: 85,
    line_items: 'Boiler service',
    sent_at: new Date().toISOString(),
  };

  const quote = templates.quoteMessage(job, customer, business);
  const schedule = templates.scheduleConfirmation(job, customer, business);
  const invoiceMsg = templates.invoiceMessage(job, invoice, customer, business);
  const reminder = templates.paymentReminder(job, invoice, customer, business);
  const followUp = templates.reviewRequestMessage(job, customer, business);
  const scheduleDay = templates.formatScheduleDay([
    {
      customer_name: 'Mrs Patel',
      description: 'Boiler service',
      scheduled_time: '09:00',
      postcode: 'BD7 1AH',
    },
  ], '2026-04-09');

  assert.ok(quote.includes('Boiler & Co'));
  assert.ok(schedule.includes('BD7 1AH'));
  assert.ok(invoiceMsg.includes('£85.00'));
  assert.ok(reminder.includes('£85.00'));
  assert.ok(followUp.includes('Boiler & Co'));
  assert.ok(scheduleDay.includes('Mrs Patel'));
}

async function testWorkflowCancelClearsPending() {
  const result = await workflowEngine.handleMessage({
    business: { id: 1 },
    raw: 'cancel',
    parsedIntent: { kind: 'continuation', intent: 'cancel' },
    currentState: {
      workflow: 'quote',
      focus: {},
      collected: {},
      pending: { type: 'field', field: 'jobId' },
      options: [],
    },
  });

  assert.equal(result.type, 'cancel');
}

async function testWorkflowHelpDoesNotClearPending() {
  const result = await workflowEngine.handleMessage({
    business: { id: 1 },
    raw: 'help',
    parsedIntent: { kind: 'query', intent: 'help' },
    currentState: {
      workflow: 'quote',
      focus: {},
      collected: {},
      pending: { type: 'field', field: 'jobId' },
      options: [],
    },
  });

  assert.equal(result.type, 'action');
  assert.equal(result.clearState, false);
}

function testWorkflowExplicitCommandOverride() {
  assert.equal(workflowEngine.isExplicitNewCommand({ kind: 'command', intent: 'quote' }), 'quote');
  assert.equal(workflowEngine.isExplicitNewCommand({ kind: 'query', intent: 'help' }), false);
}

async function testQuoteWorkflowPromptsForAmountAfterResolvingByName() {
  const result = await workflowEngine.handleMessage({
    business: { id: 1 },
    raw: 'quote wood',
    parsedIntent: { kind: 'command', intent: 'quote' },
    currentState: null,
    resolveJobReference: async () => ({
      status: 'resolved',
      job: { id: 5, description: 'boiler service', customer_name: 'Wood' },
    }),
  });

  assert.equal(result.type, 'prompt');
  assert.equal(result.workflow, 'quote');
  assert.equal(result.state.collected.jobId, 5);
  assert.equal(result.state.pending.field, 'amount');
  assert.equal(result.message, 'What price should I use?');
}

async function testQuoteWorkflowAmbiguousMatchPromptsForSelection() {
  const result = await workflowEngine.handleMessage({
    business: { id: 1 },
    raw: 'quote wood',
    parsedIntent: { kind: 'command', intent: 'quote' },
    currentState: null,
    resolveJobReference: async () => ({
      status: 'multiple',
      jobs: [
        { id: 5, customer_name: 'Mrs Wood', description: 'boiler service' },
        { id: 6, customer_name: 'John Wood', description: 'radiator leak' },
      ],
    }),
  });

  assert.equal(result.type, 'prompt');
  assert.equal(result.state.pending.type, 'selection');
  assert.equal(result.state.options.length, 2);
  assert.ok(result.message.includes('1. Mrs Wood — boiler service'));
}

async function testScheduleWorkflowCollectsDateThenTime() {
  const first = await workflowEngine.handleMessage({
    business: { id: 1 },
    raw: 'schedule wood',
    parsedIntent: { kind: 'command', intent: 'schedule' },
    currentState: null,
    resolveJobReference: async () => ({
      status: 'resolved',
      job: { id: 7, description: 'boiler service', customer_name: 'Wood' },
    }),
  });

  assert.equal(first.type, 'prompt');
  assert.equal(first.state.pending.field, 'date');
  assert.equal(first.state.collected.jobId, 7);
  assert.equal(first.message, 'What day should I book it in for?');

  const second = await workflowEngine.handleMessage({
    business: { id: 1 },
    raw: 'thursday',
    parsedIntent: { kind: 'unknown', intent: 'unknown', date: '2026-04-09' },
    currentState: first.state,
    resolveJobReference: async () => ({ status: 'resolved', job: { id: 7 } }),
  });

  assert.equal(second.type, 'prompt');
  assert.equal(second.state.pending.field, 'time');
  assert.equal(second.state.collected.jobId, 7);
  assert.equal(second.state.collected.date, '2026-04-09');
  assert.equal(second.message, 'What time should I put down?');

  const third = await workflowEngine.handleMessage({
    business: { id: 1 },
    raw: '9am',
    parsedIntent: { kind: 'unknown', intent: 'unknown', time: '09:00' },
    currentState: second.state,
    resolveJobReference: async () => ({ status: 'resolved', job: { id: 7 } }),
  });

  assert.equal(third.type, 'action');
  assert.equal(third.intent.intent, 'schedule');
  assert.equal(third.intent.jobId, 7);
  assert.equal(third.intent.date, '2026-04-09');
  assert.equal(third.intent.time, '09:00');
}

async function run() {
  testParseNewJob();
  testParseQuote();
  testParseSchedule();
  testParseScheduleWithoutDateDoesNotAssumeToday();
  testParseQueriesAndContinuations();
  testTemplateRendering();
  await testWorkflowCancelClearsPending();
  await testWorkflowHelpDoesNotClearPending();
  testWorkflowExplicitCommandOverride();
  await testQuoteWorkflowPromptsForAmountAfterResolvingByName();
  await testQuoteWorkflowAmbiguousMatchPromptsForSelection();
  await testScheduleWorkflowCollectsDateThenTime();
  console.log('smoke-test: ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
