const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'foreman.db');

let db = null;

async function init() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      postcode TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'NEW',
      postcode TEXT,
      quoted_amount REAL,
      quote_items TEXT,
      scheduled_date TEXT,
      scheduled_time TEXT,
      completed_at TEXT,
      completion_notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      amount REAL NOT NULL,
      line_items TEXT,
      status TEXT NOT NULL DEFAULT 'SENT',
      sent_at TEXT DEFAULT (datetime('now')),
      paid_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      participant TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      job_id INTEGER REFERENCES jobs(id),
      body TEXT,
      timestamp TEXT DEFAULT (datetime('now')),
      whatsapp_message_id TEXT
    )
  `);

  console.log('📦 Database ready');
  return db;
}

// Save DB to disk
function save() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Auto-save every 30 seconds
setInterval(() => save(), 30000);

// Save on exit
process.on('exit', () => save());
process.on('SIGINT', () => { save(); process.exit(); });
process.on('SIGTERM', () => { save(); process.exit(); });

// --- Helpers ---

function getOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function getAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  save();
}

function lastInsertId() {
  const row = getOne('SELECT last_insert_rowid() as id');
  return row ? row.id : null;
}

function formatJobId(id) {
  return `#${String(id).padStart(4, '0')}`;
}

function parseJobId(str) {
  const match = str.match(/#?(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// --- Customer queries ---

function findOrCreateCustomer(name, phone, postcode) {
  let customer = getOne('SELECT * FROM customers WHERE phone = ?', [phone]);
  if (!customer) {
    run('INSERT INTO customers (name, phone, postcode) VALUES (?, ?, ?)', [name, phone, postcode || null]);
    customer = getOne('SELECT * FROM customers WHERE id = ?', [lastInsertId()]);
  } else if (postcode && !customer.postcode) {
    run('UPDATE customers SET postcode = ? WHERE id = ?', [postcode, customer.id]);
    customer.postcode = postcode;
  }
  return customer;
}

function findCustomerByName(name) {
  return getAll("SELECT * FROM customers WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'", [name]);
}

function getCustomer(id) {
  return getOne('SELECT * FROM customers WHERE id = ?', [id]);
}

// --- Job queries ---

function createJob(customerId, description, postcode) {
  run('INSERT INTO jobs (customer_id, description, postcode, status) VALUES (?, ?, ?, ?)', [customerId, description, postcode || null, 'NEW']);
  return getOne('SELECT * FROM jobs WHERE id = ?', [lastInsertId()]);
}

function getJob(id) {
  return getOne('SELECT * FROM jobs WHERE id = ?', [id]);
}

function getJobWithCustomer(id) {
  const job = getJob(id);
  if (!job) return null;
  job.customer = getCustomer(job.customer_id);
  return job;
}

function setQuote(jobId, amount, items) {
  run('UPDATE jobs SET quoted_amount = ?, quote_items = ?, status = ? WHERE id = ?', [amount, items, 'QUOTED', jobId]);
  return getJob(jobId);
}

function scheduleJob(jobId, date, time) {
  run('UPDATE jobs SET scheduled_date = ?, scheduled_time = ?, status = ? WHERE id = ?', [date, time || null, 'SCHEDULED', jobId]);
  return getJob(jobId);
}

function completeJob(jobId, notes) {
  run("UPDATE jobs SET status = ?, completion_notes = ?, completed_at = datetime('now') WHERE id = ?", ['COMPLETE', notes || null, jobId]);
  return getJob(jobId);
}

function getScheduleForDate(dateStr) {
  return getAll(
    "SELECT j.*, c.name AS customer_name, c.phone AS customer_phone FROM jobs j JOIN customers c ON j.customer_id = c.id WHERE j.scheduled_date = ? AND j.status IN ('SCHEDULED', 'IN_PROGRESS') ORDER BY j.scheduled_time",
    [dateStr]
  );
}

function getScheduleRange(startDate, endDate) {
  return getAll(
    "SELECT j.*, c.name AS customer_name, c.phone AS customer_phone FROM jobs j JOIN customers c ON j.customer_id = c.id WHERE j.scheduled_date BETWEEN ? AND ? AND j.status IN ('SCHEDULED', 'IN_PROGRESS') ORDER BY j.scheduled_date, j.scheduled_time",
    [startDate, endDate]
  );
}

function getOpenJobs() {
  return getAll(
    "SELECT j.*, c.name AS customer_name FROM jobs j JOIN customers c ON j.customer_id = c.id WHERE j.status IN ('NEW', 'QUOTED', 'SCHEDULED', 'IN_PROGRESS') ORDER BY j.created_at DESC"
  );
}

// --- Invoice queries ---

function createInvoice(jobId, amount, lineItems) {
  run('INSERT INTO invoices (job_id, amount, line_items) VALUES (?, ?, ?)', [jobId, amount, lineItems || null]);
  return getOne('SELECT * FROM invoices WHERE id = ?', [lastInsertId()]);
}

function getInvoiceByJob(jobId) {
  return getOne('SELECT * FROM invoices WHERE job_id = ?', [jobId]);
}

function markInvoicePaid(invoiceId) {
  run("UPDATE invoices SET status = 'PAID', paid_at = datetime('now') WHERE id = ?", [invoiceId]);
  return getOne('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
}

function getUnpaidInvoices() {
  return getAll(
    "SELECT i.*, j.description AS job_description, c.name AS customer_name, c.phone AS customer_phone FROM invoices i JOIN jobs j ON i.job_id = j.id JOIN customers c ON j.customer_id = c.id WHERE i.status IN ('SENT', 'OVERDUE') ORDER BY i.sent_at"
  );
}

// --- Message log ---

function logMessage(direction, participant, body, { customerId, jobId, whatsappMessageId } = {}) {
  run(
    'INSERT INTO message_log (direction, participant, customer_id, job_id, body, whatsapp_message_id) VALUES (?, ?, ?, ?, ?, ?)',
    [direction, participant, customerId || null, jobId || null, body, whatsappMessageId || null]
  );
}

module.exports = {
  init,
  save,
  formatJobId,
  parseJobId,
  findOrCreateCustomer,
  findCustomerByName,
  getCustomer,
  createJob,
  getJob,
  getJobWithCustomer,
  setQuote,
  scheduleJob,
  completeJob,
  getScheduleForDate,
  getScheduleRange,
  getOpenJobs,
  createInvoice,
  getInvoiceByJob,
  markInvoicePaid,
  getUnpaidInvoices,
  logMessage,
  getAll,
};
