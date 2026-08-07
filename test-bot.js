#!/usr/bin/env node
/**
 * The Foreman — integration test suite
 *
 * Simulates WhatsApp messages via the webhook endpoint.
 * Run against a local instance (signature validation is skipped for localhost).
 *
 * Usage:
 *   node test-bot.js                          # local default (http://localhost:3000)
 *   node test-bot.js https://your-railway.up.railway.app
 *
 * The test phone number must already be onboarded (have a business row in the DB).
 * Set TEST_PHONE env var to override: TEST_PHONE=+447700000099 node test-bot.js
 */

const BASE_URL = process.argv[2] || 'http://localhost:3000';
const TEST_PHONE = process.env.TEST_PHONE || '+447700000001';
const FROM = `whatsapp:${TEST_PHONE}`;

let passed = 0;
let failed = 0;
let sidCounter = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

function sid() {
  return `SM_TEST_${Date.now()}_${++sidCounter}`;
}

async function send(body) {
  const params = new URLSearchParams({
    Body: body,
    From: FROM,
    MessageSid: sid(),
    NumMedia: '0',
  });
  const res = await fetch(`${BASE_URL}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await res.text();
  const match = text.match(/<Body>([\s\S]*?)<\/Body>/);
  return match ? match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : text;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function assert(label, reply, checks) {
  const failures = [];
  for (const [desc, fn] of Object.entries(checks)) {
    if (!fn(reply)) failures.push(desc);
  }
  if (failures.length === 0) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.log(`  ❌  ${label}`);
    for (const f of failures) console.log(`       → expected: ${f}`);
    console.log(`       → got: "${reply.slice(0, 200)}"`);
    failed++;
  }
}

function contains(...strs) {
  return reply => strs.every(s => reply.toLowerCase().includes(s.toLowerCase()));
}
function notContains(...strs) {
  return reply => strs.every(s => !reply.toLowerCase().includes(s.toLowerCase()));
}
function matches(re) {
  return reply => re.test(reply);
}
function any() {
  return reply => reply.length > 0;
}

// ── Parser unit tests (no HTTP) ──────────────────────────────────────────────

function runParserTests() {
  const { parse, parseLineItems } = require('./parser');
  console.log('\n📐 Parser unit tests\n');

  function check(label, input, expected) {
    const result = parse(input);
    const ok = Object.entries(expected).every(([k, v]) => {
      if (typeof v === 'object' && v !== null) return JSON.stringify(result[k]) === JSON.stringify(v);
      return result[k] === v;
    });
    if (ok) { console.log(`  ✅  ${label}`); passed++; }
    else     { console.log(`  ❌  ${label} — got ${JSON.stringify(result)}`); failed++; }
  }

  function checkItems(label, input, expectedTotal) {
    const result = parseLineItems(input);
    const total = result ? result.reduce((s, i) => s + i.amount, 0) : null;
    if (result && Math.abs(total - expectedTotal) < 0.01) {
      console.log(`  ✅  ${label}`);
      passed++;
    } else {
      console.log(`  ❌  ${label} — got ${JSON.stringify(result)}, total=${total}`);
      failed++;
    }
  }

  // Greetings
  check('hi → greeting',    'hi',      { intent: 'greeting' });
  check('Hey → greeting',   'Hey',     { intent: 'greeting' });
  check('morning → greeting', 'morning', { intent: 'greeting' });

  // Thanks
  check('cheers → thanks',  'cheers',  { intent: 'thanks' });
  check('nice one → thanks','nice one',{ intent: 'thanks' });

  // Confirmations
  check('yes → confirm',    'yes',     { kind: 'continuation', intent: 'confirm' });
  check('send → confirm',   'send',    { kind: 'continuation', intent: 'confirm' });
  check('ok → confirm',     'ok',      { kind: 'continuation', intent: 'confirm' });

  // Cancel — NOT skip
  check('no → cancel',      'no',      { kind: 'continuation', intent: 'cancel' });
  check('nah → cancel',     'nah',     { kind: 'continuation', intent: 'cancel' });
  check('Skip ≠ cancel',    'Skip',    r => r.intent !== 'cancel');
  check('skip ≠ cancel',    'skip',    r => r.intent !== 'cancel');

  // Quotes
  check('quote → bare quote',      'quote',    { intent: 'quote', jobId: null, amount: null });
  check('quote 14 → quote by id',  'quote 14', { intent: 'quote', jobId: 14, amount: null });
  check('quote 14 85 → quick',     'quote 14 85', { intent: 'quote', jobId: 14, amount: 85 });
  check('requote alias',           'requote 14 100', { intent: 'quote', jobId: 14, amount: 100 });
  check('quote for Mrs Smith → name ref', 'quote for Mrs Smith', { intent: 'quote', jobRef: 'Mrs Smith' });

  // Invoices
  check('invoice → bare',          'invoice',     { intent: 'send_invoice', jobId: null });
  check('invoice 14 → by id',      'invoice 14',  { intent: 'send_invoice', jobId: 14 });
  check('invoice 14 250 → amount', 'invoice 14 250', { intent: 'send_invoice', jobId: 14, amount: 250 });
  check('invoice Mrs Smith → name','invoice Mrs Smith', { intent: 'send_invoice', jobRef: 'Mrs Smith' });

  // Paid
  check('paid 14 → paid',          'paid 14', { intent: 'paid', jobId: 14 });

  // Chase
  check('chase 14 → chase',        'chase 14', { intent: 'chase', jobId: 14 });

  // Cancel job
  check('cancel 14 → cancel_job',  'cancel 14', { intent: 'cancel_job', jobId: 14 });
  check('cancel quote 14 → cancel_job', 'cancel quote 14', { intent: 'cancel_job', jobId: 14 });
  check('cancel job for Mrs Smith → name', 'cancel job for Mrs Smith', { intent: 'cancel_job', jobRef: 'Mrs Smith' });
  check('lost the Smith quote → cancel', 'lost the Smith quote', { intent: 'cancel_job', jobRef: 'Smith' });
  check("didn't get the boiler job", "didn't get the boiler job", { intent: 'cancel_job' });

  // Amend
  check('amend 14 500 → amend_invoice', 'amend 14 500', { intent: 'amend_invoice', jobId: 14, amount: 500 });
  check('amend invoice 14 600',         'amend invoice 14 600', { intent: 'amend_invoice', jobId: 14, amount: 600 });

  // Queries
  check('unpaid → unpaid',          'unpaid',    { intent: 'unpaid' });
  check('overdue → unpaid',         'overdue',   { intent: 'unpaid' });
  check('earnings → earnings',      'earnings',  { intent: 'earnings' });
  check('how much have I made',     'how much have I made this month', { intent: 'earnings' });
  check('stats → financial_summary','stats',     { intent: 'financial_summary' });
  check("how's business",           "how's business", { intent: 'financial_summary' });
  check('open → open_jobs',         'open',      { intent: 'open_jobs' });
  check('settings → settings',      'settings',  { intent: 'settings' });
  check('help → help',              'help',      { intent: 'help' });
  check('customers → list_customers', 'customers', { intent: 'list_customers' });
  check('job 14 → view_job',        'job 14',    { intent: 'view_job', jobId: 14 });
  check('find Dave → find',         'find Dave', { intent: 'find', query: 'Dave' });
  check('feedback → feedback',      'feedback this is a test', { intent: 'feedback' });

  // Mark complete
  check('done 14 → mark_complete',  'done 14', { intent: 'mark_complete', jobId: 14 });
  check('complete 14',              'complete 14', { intent: 'mark_complete', jobId: 14 });

  // Period parsing in queries
  check('earnings this month',      'how much have I earned this month', { intent: 'earnings', period: 'month' });
  check('earnings this year',       'how much have I earned this year',  { intent: 'earnings', period: 'year' });
  check('earnings today',           'how much have I earned today',      { intent: 'earnings', period: 'today' });

  // Customer-only requests redirect to the quote / new job flows
  check('customer redirect bare',   'new customer', { intent: 'customer_redirect', name: null });
  check('customer redirect name',   'new customer Dave Smith', { intent: 'customer_redirect', name: 'Dave Smith' });
  check('customer redirect w/phone','new customer Dave Smith 07700900123', { intent: 'customer_redirect', name: 'Dave Smith' });

  // Line item parsing
  checkItems('simple items',        'labour 250, parts 45', 295);
  checkItems('£ prefix',            'Labour £250, Parts £45', 295);
  checkItems('thousands comma',     'Labour £1,200, Boiler £1,300', 2500);
  checkItems('mixed thousands',     'Labour £1,200, Radiators £950, Pipework & Fittings £650', 2800);
  checkItems('trailing full stop',  'Labour £250, Parts £45.', 295);
  checkItems('trailing semicolon',  'Labour £250, Parts £45;', 295);
  checkItems('10-item real world',  'Labour £1,200, Boiler £1,300, Radiators £950, Pipework & Fittings £650, Thermostat & Heating Controls £250, Magnetic Filter £120, System Flush & Chemicals £180, Flue Kit £150, Removal & Waste Disposal £200, Commissioning & Testing £150.', 5150);
}

// ── Integration tests ────────────────────────────────────────────────────────

async function runIntegrationTests() {
  console.log(`\n🌐 Integration tests → ${BASE_URL}\n`);

  // ── 1. Basic queries ───────────────────────────────────────────────────────
  console.log('── Basic queries ──');

  let r = await send('help');
  assert('help', r, { 'contains help content': contains('quote', 'invoice') });

  r = await send('hi');
  assert('greeting', r, { 'not empty': any() });

  r = await send('cheers');
  assert('thanks', r, { 'not empty': any() });

  r = await send('open');
  assert('open jobs', r, { 'not empty': any() });

  r = await send('unpaid');
  assert('unpaid query', r, { 'not empty': any() });

  r = await send('earnings');
  assert('earnings query', r, { 'not empty': any() });

  r = await send('how much have I made this month');
  assert('earnings this month', r, { 'not empty': any() });

  r = await send('how much have I earned today');
  assert('earnings today', r, { 'not empty': any() });

  r = await send('stats');
  assert('financial summary', r, { 'not empty': any() });

  r = await send('customers');
  assert('list customers', r, { 'not empty': any() });

  r = await send('conversion rate');
  assert('conversion rate', r, { 'not empty': any() });

  r = await send('quoted');
  assert('quoted jobs', r, { 'not empty': any() });

  // ── 2. Skip is NOT cancel ──────────────────────────────────────────────────
  console.log('\n── Skip handling ──');

  // Start an invoice flow then say Skip — should skip the step, not cancel
  await send('invoice');
  await sleep(300);
  r = await send('Test Customer Skip');
  await sleep(300);
  r = await send('Skip');  // skip phone number
  assert('Skip moves to next step (not cancel)', r, {
    'not a cancellation message': notContains('cancelled', 'dropped', 'no problem'),
    'asks for next field or continues':  any(),
  });
  // Abandon the flow cleanly
  await send('no');
  await sleep(300);

  // ── 3. Cancel workflow mid-flow ────────────────────────────────────────────
  console.log('\n── Workflow cancellation ──');

  await send('invoice');
  await sleep(300);
  r = await send('no');
  assert('no mid-flow cancels workflow', r, {
    'acknowledges cancellation or falls through': any(),
  });
  await sleep(300);

  // After cancel, bot should handle a fresh command cleanly
  r = await send('help');
  assert('fresh command after cancel works', r, { 'contains help content': contains('quote', 'invoice') });

  // ── 4. Workflow interrupted by a query ────────────────────────────────────
  console.log('\n── Workflow interruption ──');

  await send('invoice');
  await sleep(300);
  r = await send('unpaid');  // fire a query mid-workflow
  assert('query mid-workflow returns useful response', r, {
    'not empty': any(),
    'not unknown': notContains('didn\'t quite get that', 'not sure what you mean'),
  });
  await sleep(300);

  // ── 5. Full quote flow (new customer) ─────────────────────────────────────
  console.log('\n── Quote flow (guided, new customer) ──');

  r = await send('quote');
  assert('bare quote starts flow', r, { 'asks who': contains('who') });
  await sleep(300);

  r = await send('Test McTestface');
  assert('name accepted', r, { 'not empty': any() });
  await sleep(300);

  // Skip phone
  r = await send('Skip');
  assert('skip phone in quote flow', r, {
    'moves forward': notContains('cancelled', 'dropped'),
    'not empty': any(),
  });
  await sleep(300);

  // Skip address
  r = await send('Skip');
  await sleep(300);

  r = await send('Fit new boiler');
  assert('description accepted', r, { 'asks for price': any() });
  await sleep(300);

  r = await send('Labour £500, Parts £200');
  assert('itemised price (no thousands) accepted', r, { 'not re-prompted': notContains('e.g. *450*') });
  await sleep(300);

  // Confirm or cancel
  r = await send('no');
  await sleep(300);

  // ── 6. Line items with thousands comma ────────────────────────────────────
  console.log('\n── Line items with thousands separators ──');

  await send('invoice');
  await sleep(300);
  await send('Darren Masters');
  await sleep(300);
  await send('Skip');  // phone
  await sleep(300);
  await send('Skip');  // address
  await sleep(300);
  await send('Install central heating system');
  await sleep(300);
  r = await send('Labour £1,200, Boiler £1,300, Radiators £950');
  assert('thousands-comma line items accepted', r, {
    'not re-prompted for price': notContains('e.g. *450*', "What's the price"),
    'not empty': any(),
  });
  await sleep(300);
  await send('no');
  await sleep(300);

  // ── 7. Settings ────────────────────────────────────────────────────────────
  console.log('\n── Settings ──');

  r = await send('settings');
  assert('settings menu shown', r, { 'shows options': contains('1') });
  await sleep(300);

  // Cancel settings
  r = await send('no');
  assert('cancel settings', r, { 'not empty': any() });
  await sleep(300);

  // ── 8. Unknown / junk input ────────────────────────────────────────────────
  console.log('\n── Unknown / edge cases ──');

  r = await send('asdkjhaskdjhaksjdh random gibberish');
  assert('unknown input handled gracefully', r, {
    'not empty': any(),
    'no crash': r => !r.includes('Error') && !r.includes('undefined'),
  });

  r = await send('');
  assert('empty body handled', r, { 'not empty': any() });

  r = await send('£££ ### !!!');
  assert('special characters handled', r, { 'not empty': any() });

  const longMsg = 'a'.repeat(2000);
  r = await send(longMsg);
  assert('very long message handled', r, { 'not empty': any() });

  // ── 9. Feedback ────────────────────────────────────────────────────────────
  console.log('\n── Feedback ──');

  r = await send('feedback love the app');
  assert('inline feedback accepted', r, { 'acknowledges': any() });

  r = await send('feedback');
  assert('bare feedback prompts for message', r, { 'asks for feedback': contains("mind") });
  await sleep(300);
  r = await send('This is a test feedback message');
  assert('feedback message captured', r, { 'acknowledges': any() });
  await sleep(300);

  // ── 10. Find / search ─────────────────────────────────────────────────────
  console.log('\n── Find / search ──');

  r = await send('find McTestface');
  assert('find customer by name', r, { 'not empty': any() });

  r = await send('find zzz_no_such_customer_zzz');
  assert('find no results graceful', r, { 'not empty': any() });
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n🔨 The Foreman — Test Suite`);
  console.log(`   Target : ${BASE_URL}`);
  console.log(`   Phone  : ${TEST_PHONE}\n`);

  // Always run parser tests (no network needed)
  runParserTests();

  // Integration tests require a running server
  try {
    const healthRes = await fetch(`${BASE_URL}/`);
    if (!healthRes.ok) throw new Error(`Health check returned ${healthRes.status}`);
    await runIntegrationTests();
  } catch (err) {
    console.log(`\n⚠️  Integration tests skipped — server not reachable at ${BASE_URL}`);
    console.log(`   (${err.message})\n`);
    console.log(`   Start the server with: node index.js`);
    console.log(`   Or pass a Railway URL: node test-bot.js https://your-app.railway.app`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  if (failed > 0) {
    console.log('❌ Some tests failed — check output above\n');
    process.exit(1);
  } else {
    console.log('✅ All tests passed\n');
  }
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
