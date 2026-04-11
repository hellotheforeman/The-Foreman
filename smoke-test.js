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

function testParseBookKeyword() {
  const r1 = parse('book 14 friday at 10');
  assert.equal(r1.intent, 'schedule');
  assert.equal(r1.jobId, 14);
  assert.ok(r1.date);
  assert.equal(r1.time, '10:00');

  const r2 = parse('book job 14 friday at 10');
  assert.equal(r2.intent, 'schedule');
  assert.equal(r2.jobId, 14);
  assert.ok(r2.date);
  assert.equal(r2.time, '10:00');
}

function testParseExplicitDates() {
  // ISO date
  const iso = parse('schedule 14 2026-06-15 9am');
  assert.equal(iso.date, '2026-06-15');
  assert.equal(iso.time, '09:00');

  // UK date 12/03
  const uk = parse('schedule 14 12/06');
  assert.equal(uk.date?.slice(5), '06-12'); // YYYY-06-12

  // Ordinal + month
  const ordMonth = parse('schedule 14 12th june at 9');
  assert.equal(ordMonth.date?.slice(5), '06-12');
  assert.equal(ordMonth.time, '09:00');

  // Day + month name
  const dayMonth = parse('schedule 14 15 june 9am');
  assert.equal(dayMonth.date?.slice(5), '06-15');

  // Ordinal only — just check it parses a date without asserting exact value (depends on today's date)
  const ordOnly = parse('schedule 14 15th');
  assert.ok(ordOnly.date, 'ordinal-only should produce a date');
}

function testParseDuration() {
  const r = parse('book 14 for 2 days from tuesday');
  assert.equal(r.intent, 'schedule');
  assert.equal(r.duration, 2);
  assert.equal(r.durationUnit, 'days');
  assert.ok(r.date);

  const r2 = parse('book 14 on 12/06 for 3 days');
  assert.equal(r2.duration, 3);
  assert.equal(r2.durationUnit, 'days');
}

function testParseFollowingDay() {
  // "following monday" should be further out than plain "monday"
  const plain = parse('schedule 14 monday');
  const following = parse('schedule 14 following monday');
  assert.ok(following.date > plain.date, 'following monday should be after next monday');
}

function testParseAddBlock() {
  const r = parse('and then 3 days from following monday');
  assert.equal(r.intent, 'add_block');
  assert.equal(r.jobId, null);
  assert.equal(r.duration, 3);
  assert.equal(r.durationUnit, 'days');
  assert.ok(r.date);

  const r2 = parse('also friday at 9');
  assert.equal(r2.intent, 'add_block');
  assert.ok(r2.date);
  assert.equal(r2.time, '09:00');
}

function testParseRescheduleWithJobKeyword() {
  const r = parse('reschedule job 14 to Thursday at 9');
  assert.equal(r.intent, 'reschedule');
  assert.equal(r.jobId, 14);
  assert.ok(r.date);
  assert.equal(r.time, '09:00');
}

function testParseItemisedQuote() {
  // Multi-item
  const multi = parse('quote 14 boiler service 250, parts 45, callout 50');
  assert.equal(multi.kind, 'command');
  assert.equal(multi.intent, 'quote');
  assert.equal(multi.jobId, 14);
  assert.equal(multi.amount, 345);
  assert.ok(Array.isArray(multi.lineItems));
  assert.equal(multi.lineItems.length, 3);
  assert.equal(multi.lineItems[0].description, 'boiler service');
  assert.equal(multi.lineItems[0].amount, 250);
  assert.equal(multi.lineItems[2].amount, 50);

  // Single item (description before amount, no pipe)
  const single = parse('quote 14 boiler service 250');
  assert.equal(single.intent, 'quote');
  assert.equal(single.jobId, 14);
  assert.equal(single.amount, 250);
  assert.equal(single.lineItems.length, 1);
  assert.equal(single.lineItems[0].description, 'boiler service');
}

function testParseInvoiceVariants() {
  // Simple (invoice from quote)
  const simple = parse('invoice 14');
  assert.equal(simple.kind, 'command');
  assert.equal(simple.intent, 'send_invoice');
  assert.equal(simple.jobId, 14);
  assert.equal(simple.amount, undefined);

  // Quick with amount
  const quick = parse('invoice 14 350 boiler service');
  assert.equal(quick.intent, 'send_invoice');
  assert.equal(quick.jobId, 14);
  assert.equal(quick.amount, 350);
  assert.equal(quick.items, 'boiler service');

  // Itemised
  const itemised = parse('invoice 14 boiler service 250, parts 45');
  assert.equal(itemised.intent, 'send_invoice');
  assert.equal(itemised.amount, 295);
  assert.equal(itemised.lineItems.length, 2);
}

function testParseAmendInvoice() {
  // Quick
  const quick = parse('amend 14 450 updated service');
  assert.equal(quick.kind, 'command');
  assert.equal(quick.intent, 'amend_invoice');
  assert.equal(quick.jobId, 14);
  assert.equal(quick.amount, 450);
  assert.equal(quick.items, 'updated service');

  // Itemised
  const itemised = parse('amend invoice 14 service 280, parts 55');
  assert.equal(itemised.intent, 'amend_invoice');
  assert.equal(itemised.jobId, 14);
  assert.equal(itemised.amount, 335);
  assert.equal(itemised.lineItems.length, 2);
  assert.equal(itemised.lineItems[0].description, 'service');
  assert.equal(itemised.lineItems[1].amount, 55);
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
  assert.ok(result.message.startsWith('What price should I use?'));
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

async function testScheduleWorkflowCollectsDate() {
  // time is now optional — providing jobId + date is enough to complete
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

  assert.equal(second.type, 'action');
  assert.equal(second.intent.intent, 'schedule');
  assert.equal(second.intent.jobId, 7);
  assert.equal(second.intent.date, '2026-04-09');
  assert.equal(second.intent.time, null);
}

async function testScheduleWorkflowCollectsDateAndTimeWhenBothProvided() {
  // When both date and time are in the initial message, resolve immediately
  const result = await workflowEngine.handleMessage({
    business: { id: 1 },
    raw: 'schedule 7 thursday 9am',
    parsedIntent: { kind: 'command', intent: 'schedule', jobId: 7, date: '2026-04-09', time: '09:00' },
    currentState: null,
    resolveJobReference: async () => ({
      status: 'resolved',
      job: { id: 7, description: 'boiler service', customer_name: 'Wood' },
    }),
  });

  assert.equal(result.type, 'action');
  assert.equal(result.intent.jobId, 7);
  assert.equal(result.intent.date, '2026-04-09');
  assert.equal(result.intent.time, '09:00');
}

async function testScheduleWorkflowDateOnlyNoTimePrompt() {
  // With time now optional, providing only a date should resolve immediately
  const result = await workflowEngine.handleMessage({
    business: { id: 1 },
    raw: 'schedule 7 thursday',
    parsedIntent: { kind: 'command', intent: 'schedule', jobId: 7, date: '2026-04-17', time: null },
    currentState: null,
    resolveJobReference: async () => ({ status: 'resolved', job: { id: 7, description: 'boiler service', customer_name: 'Wood' } }),
  });

  assert.equal(result.type, 'action');
  assert.equal(result.intent.jobId, 7);
  assert.equal(result.intent.date, '2026-04-17');
  assert.equal(result.intent.time, null);
}

async function testAddBlockWorkflowWithContext() {
  // Simulates: user sends "and then friday at 9" after a schedule action has left follow-up state
  // The jobId has been injected from context before reaching the workflow engine
  const result = await workflowEngine.handleMessage({
    business: { id: 1 },
    raw: 'and then friday at 9',
    parsedIntent: { kind: 'command', intent: 'add_block', jobId: 14, date: '2026-04-18', time: '09:00', duration: null, durationUnit: null },
    currentState: {
      workflow: 'add_block',
      focus: { jobId: 14 },
      collected: { jobId: 14 },
      pending: null,
      options: [],
    },
    resolveJobReference: async () => ({ status: 'resolved', job: { id: 14, description: 'boiler service', customer_name: 'Smith' } }),
  });

  assert.equal(result.type, 'action');
  assert.equal(result.intent.intent, 'add_block');
  assert.equal(result.intent.jobId, 14);
  assert.equal(result.intent.date, '2026-04-18');
  assert.equal(result.intent.time, '09:00');
}

async function testAddBlockWorkflowWithoutContextPromptsForJob() {
  const result = await workflowEngine.handleMessage({
    business: { id: 1 },
    raw: 'and then friday at 9',
    parsedIntent: { kind: 'command', intent: 'add_block', jobId: null, date: '2026-04-18', time: '09:00' },
    currentState: null,
    resolveJobReference: async () => ({ status: 'not_found' }),
  });

  assert.equal(result.type, 'prompt');
  assert.equal(result.state.pending.field, 'jobId');
}

async function testScheduleWorkflowWithDuration() {
  const result = await workflowEngine.handleMessage({
    business: { id: 1 },
    raw: 'book 14 for 2 days from tuesday',
    parsedIntent: { kind: 'command', intent: 'schedule', jobId: 14, date: '2026-04-15', time: null, duration: 2, durationUnit: 'days' },
    currentState: null,
    resolveJobReference: async () => ({ status: 'resolved', job: { id: 14, description: 'boiler service', customer_name: 'Jones' } }),
  });

  assert.equal(result.type, 'action');
  assert.equal(result.intent.duration, 2);
  assert.equal(result.intent.durationUnit, 'days');
}

async function run() {
  testParseNewJob();
  testParseQuote();
  testParseSchedule();
  testParseScheduleWithoutDateDoesNotAssumeToday();
  testParseBookKeyword();
  testParseExplicitDates();
  testParseDuration();
  testParseFollowingDay();
  testParseAddBlock();
  testParseRescheduleWithJobKeyword();
  testParseItemisedQuote();
  testParseInvoiceVariants();
  testParseAmendInvoice();
  testParseQueriesAndContinuations();
  testTemplateRendering();
  await testWorkflowCancelClearsPending();
  await testWorkflowHelpDoesNotClearPending();
  testWorkflowExplicitCommandOverride();
  await testQuoteWorkflowPromptsForAmountAfterResolvingByName();
  await testQuoteWorkflowAmbiguousMatchPromptsForSelection();
  await testScheduleWorkflowCollectsDate();
  await testScheduleWorkflowCollectsDateAndTimeWhenBothProvided();
  await testScheduleWorkflowDateOnlyNoTimePrompt();
  await testAddBlockWorkflowWithContext();
  await testAddBlockWorkflowWithoutContextPromptsForJob();
  await testScheduleWorkflowWithDuration();
  console.log('smoke-test: ok');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
