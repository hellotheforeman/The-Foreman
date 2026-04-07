const assert = require('assert');
const { parse } = require('./parser');
const templates = require('./templates');

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
  const followUp = templates.followUpMessage(job, customer, business);
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

function run() {
  testParseNewJob();
  testParseQuote();
  testParseSchedule();
  testParseScheduleWithoutDateDoesNotAssumeToday();
  testParseQueriesAndContinuations();
  testTemplateRendering();
  console.log('smoke-test: ok');
}

run();
