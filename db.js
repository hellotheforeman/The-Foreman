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
    CREATE TABLE IF NOT EXISTS businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      email TEXT,
      payment_details TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      plan TEXT NOT NULL DEFAULT 'trial',
      trial_ends_at TEXT,
      stripe_customer_id TEXT,
      subscription_status TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      postcode TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(business_id, phone)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
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
      business_id INTEGER NOT NULL REFERENCES businesses(id),
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
      business_id INTEGER REFERENCES businesses(id),
      direction TEXT NOT NULL,
      participant TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      job_id INTEGER REFERENCES jobs(id),
      body TEXT,
      timestamp TEXT DEFAULT (datetime('now')),
      whatsapp_message_id TEXT
    )
  `);

  // Migrations for existing databases (silently ignored if column already exists)
  const migrations = [
    'ALTER TABLE customers ADD COLUMN business_id INTEGER REFERENCES businesses(id)',
    'ALTER TABLE jobs ADD COLUMN business_id INTEGER REFERENCES businesses(id)',
    'ALTER TABLE invoices ADD COLUMN business_id INTEGER REFERENCES businesses(id)',
    'ALTER TABLE message_log ADD COLUMN business_id INTEGER REFERENCES businesses(id)',
    'ALTER TABLE businesses ADD COLUMN payment_details TEXT',
  ];
  for (const sql of migrations) {
    try { db.run(sql); } catch (_) {}
  }

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

// --- Business queries ---

function findBusinessByPhone(phone) {
  return getOne('SELECT * FROM businesses WHERE phone = ?', [phone]);
}

function getBusiness(id) {
  return getOne('SELECT * FROM businesses WHERE id = ?', [id]);
}

function createBusiness({ business_name, contact_name, phone, email }) {
  run(
    'INSERT INTO businesses (business_name, contact_name, phone, email) VALUES (?, ?, ?, ?)',
    [business_name, contact_name, phone, email || null]
  );
  return getOne('SELECT * FROM businesses WHERE id = ?', [lastInsertId()]);
}

function updateBusinessStatus(id, status) {
  run('UPDATE businesses SET status = ? WHERE id = ?', [status, id]);
}

function getAllActiveBusinesses() {
  return getAll("SELECT * FROM businesses WHERE status = 'active'");
}

// --- Customer queries ---

function findOrCreateCustomer(businessId, name, phone, postcode) {
  let customer = getOne(
    'SELECT * FROM customers WHERE business_id = ? AND phone = ?',
    [businessId, phone]
  );
  if (!customer) {
    run(
      'INSERT INTO customers (business_id, name, phone, postcode) VALUES (?, ?, ?, ?)',
      [businessId, name, phone, postcode || null]
    );
    customer = getOne('SELECT * FROM customers WHERE id = ?', [lastInsertId()]);
  } else if (postcode && !customer.postcode) {
    run('UPDATE customers SET postcode = ? WHERE id = ?', [postcode, customer.id]);
    customer.postcode = postcode;
  }
  return customer;
}

function findCustomerByName(businessId, name) {
  return getAll(
    "SELECT * FROM customers WHERE business_id = ? AND LOWER(name) LIKE '%' || LOWER(?) || '%'",
    [businessId, name]
  );
}

function getCustomer(id) {
  return getOne('SELECT * FROM customers WHERE id = ?', [id]);
}

// --- Job queries ---

function createJob(businessId, customerId, description, postcode) {
  run(
    'INSERT INTO jobs (business_id, customer_id, description, postcode, status) VALUES (?, ?, ?, ?, ?)',
    [businessId, customerId, description, postcode || null, 'NEW']
  );
  return getOne('SELECT * FROM jobs WHERE id = ?', [lastInsertId()]);
}

function getJob(businessId, id) {
  return getOne('SELECT * FROM jobs WHERE id = ? AND business_id = ?', [id, businessId]);
}

function getJobWithCustomer(businessId, id) {
  const job = getJob(businessId, id);
  if (!job) return null;
  job.customer = getCustomer(job.customer_id);
  return job;
}

function setQuote(businessId, jobId, amount, items) {
  run(
    'UPDATE jobs SET quoted_amount = ?, quote_items = ?, status = ? WHERE id = ? AND business_id = ?',
    [amount, items, 'QUOTED', jobId, businessId]
  );
  return getJob(businessId, jobId);
}

function scheduleJob(businessId, jobId, date, time) {
  run(
    'UPDATE jobs SET scheduled_date = ?, scheduled_time = ?, status = ? WHERE id = ? AND business_id = ?',
    [date, time || null, 'SCHEDULED', jobId, businessId]
  );
  return getJob(businessId, jobId);
}

function completeJob(businessId, jobId, notes) {
  run(
    "UPDATE jobs SET status = ?, completion_notes = ?, completed_at = datetime('now') WHERE id = ? AND business_id = ?",
    ['COMPLETE', notes || null, jobId, businessId]
  );
  return getJob(businessId, jobId);
}

function getScheduleForDate(businessId, dateStr) {
  return getAll(
    "SELECT j.*, c.name AS customer_name, c.phone AS customer_phone FROM jobs j JOIN customers c ON j.customer_id = c.id WHERE j.business_id = ? AND j.scheduled_date = ? AND j.status IN ('SCHEDULED', 'IN_PROGRESS') ORDER BY j.scheduled_time",
    [businessId, dateStr]
  );
}

function getScheduleRange(businessId, startDate, endDate) {
  return getAll(
    "SELECT j.*, c.name AS customer_name, c.phone AS customer_phone FROM jobs j JOIN customers c ON j.customer_id = c.id WHERE j.business_id = ? AND j.scheduled_date BETWEEN ? AND ? AND j.status IN ('SCHEDULED', 'IN_PROGRESS') ORDER BY j.scheduled_date, j.scheduled_time",
    [businessId, startDate, endDate]
  );
}

function getOpenJobs(businessId) {
  return getAll(
    "SELECT j.*, c.name AS customer_name FROM jobs j JOIN customers c ON j.customer_id = c.id WHERE j.business_id = ? AND j.status IN ('NEW', 'QUOTED', 'SCHEDULED', 'IN_PROGRESS') ORDER BY j.created_at DESC",
    [businessId]
  );
}

// --- Invoice queries ---

function createInvoice(businessId, jobId, amount, lineItems) {
  run(
    'INSERT INTO invoices (business_id, job_id, amount, line_items) VALUES (?, ?, ?, ?)',
    [businessId, jobId, amount, lineItems || null]
  );
  return getOne('SELECT * FROM invoices WHERE id = ?', [lastInsertId()]);
}

function getInvoiceByJob(businessId, jobId) {
  return getOne(
    'SELECT * FROM invoices WHERE job_id = ? AND business_id = ?',
    [jobId, businessId]
  );
}

function markInvoicePaid(businessId, invoiceId) {
  run(
    "UPDATE invoices SET status = 'PAID', paid_at = datetime('now') WHERE id = ? AND business_id = ?",
    [invoiceId, businessId]
  );
  return getOne('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
}

function getUnpaidInvoices(businessId) {
  return getAll(
    "SELECT i.*, j.description AS job_description, c.name AS customer_name, c.phone AS customer_phone FROM invoices i JOIN jobs j ON i.job_id = j.id JOIN customers c ON j.customer_id = c.id WHERE i.business_id = ? AND i.status IN ('SENT', 'OVERDUE') ORDER BY i.sent_at",
    [businessId]
  );
}

// --- Message log ---

function logMessage(businessId, direction, participant, body, { customerId, jobId, whatsappMessageId } = {}) {
  run(
    'INSERT INTO message_log (business_id, direction, participant, customer_id, job_id, body, whatsapp_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [businessId, direction, participant, customerId || null, jobId || null, body, whatsappMessageId || null]
  );
}

module.exports = {
  init,
  save,
  formatJobId,
  parseJobId,
  findBusinessByPhone,
  getBusiness,
  createBusiness,
  updateBusinessStatus,
  getAllActiveBusinesses,
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
