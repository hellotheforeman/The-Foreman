const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function init() {
  await migrate();
  console.log('📦 Database ready');
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS businesses (
      id SERIAL PRIMARY KEY,
      business_name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      plan TEXT NOT NULL DEFAULT 'trial',
      trial_ends_at TIMESTAMPTZ,
      stripe_customer_id TEXT,
      subscription_status TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      postcode TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(business_id, phone)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'NEW',
      postcode TEXT,
      quoted_amount NUMERIC,
      quote_items TEXT,
      scheduled_date DATE,
      scheduled_time TEXT,
      completed_at TIMESTAMPTZ,
      completion_notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      amount NUMERIC NOT NULL,
      line_items TEXT,
      status TEXT NOT NULL DEFAULT 'SENT',
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_log (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      direction TEXT NOT NULL,
      participant TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      job_id INTEGER REFERENCES jobs(id),
      body TEXT,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      whatsapp_message_id TEXT
    )
  `);
}

function save() {}

async function close() {
  await pool.end();
}

// --- Helpers ---

async function getOne(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function getAll(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

function formatJobId(id) {
  return `#${String(id).padStart(4, '0')}`;
}

function parseJobId(str) {
  const match = str.match(/#?(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// --- Business queries ---

async function findBusinessByPhone(phone) {
  return getOne('SELECT * FROM businesses WHERE phone = $1', [phone]);
}

async function getBusiness(id) {
  return getOne('SELECT * FROM businesses WHERE id = $1', [id]);
}

async function createBusiness({ business_name, contact_name, phone, email }) {
  const result = await pool.query(
    'INSERT INTO businesses (business_name, contact_name, phone, email) VALUES ($1, $2, $3, $4) RETURNING *',
    [business_name, contact_name, phone, email || null]
  );
  return result.rows[0];
}

async function updateBusinessStatus(id, status) {
  await pool.query('UPDATE businesses SET status = $1 WHERE id = $2', [status, id]);
}

async function getAllActiveBusinesses() {
  return getAll("SELECT * FROM businesses WHERE status = 'active'");
}

// --- Customer queries ---

async function findOrCreateCustomer(businessId, name, phone, postcode) {
  let customer = await getOne(
    'SELECT * FROM customers WHERE business_id = $1 AND phone = $2',
    [businessId, phone]
  );
  if (!customer) {
    const result = await pool.query(
      'INSERT INTO customers (business_id, name, phone, postcode) VALUES ($1, $2, $3, $4) RETURNING *',
      [businessId, name, phone, postcode || null]
    );
    customer = result.rows[0];
  } else if (postcode && !customer.postcode) {
    await pool.query('UPDATE customers SET postcode = $1 WHERE id = $2', [postcode, customer.id]);
    customer.postcode = postcode;
  }
  return customer;
}

async function findCustomerByName(businessId, name) {
  return getAll(
    'SELECT * FROM customers WHERE business_id = $1 AND name ILIKE $2',
    [businessId, `%${name}%`]
  );
}

async function getCustomer(id) {
  return getOne('SELECT * FROM customers WHERE id = $1', [id]);
}

// --- Job queries ---

async function createJob(businessId, customerId, description, postcode) {
  const result = await pool.query(
    "INSERT INTO jobs (business_id, customer_id, description, postcode, status) VALUES ($1, $2, $3, $4, 'NEW') RETURNING *",
    [businessId, customerId, description, postcode || null]
  );
  return result.rows[0];
}

async function getJob(id) {
  return getOne('SELECT * FROM jobs WHERE id = $1', [id]);
}

async function getJobWithCustomer(id) {
  const job = await getJob(id);
  if (!job) return null;
  job.customer = await getCustomer(job.customer_id);
  return job;
}

async function setQuote(jobId, amount, items) {
  await pool.query(
    "UPDATE jobs SET quoted_amount = $1, quote_items = $2, status = 'QUOTED' WHERE id = $3",
    [amount, items, jobId]
  );
  return getJob(jobId);
}

async function scheduleJob(jobId, date, time) {
  await pool.query(
    "UPDATE jobs SET scheduled_date = $1, scheduled_time = $2, status = 'SCHEDULED' WHERE id = $3",
    [date, time || null, jobId]
  );
  return getJob(jobId);
}

async function completeJob(jobId, notes) {
  await pool.query(
    "UPDATE jobs SET status = 'COMPLETE', completion_notes = $1, completed_at = NOW() WHERE id = $2",
    [notes || null, jobId]
  );
  return getJob(jobId);
}

async function getScheduleForDate(businessId, dateStr) {
  return getAll(
    "SELECT j.*, c.name AS customer_name, c.phone AS customer_phone FROM jobs j JOIN customers c ON j.customer_id = c.id WHERE j.business_id = $1 AND j.scheduled_date = $2 AND j.status IN ('SCHEDULED', 'IN_PROGRESS') ORDER BY j.scheduled_time",
    [businessId, dateStr]
  );
}

async function getScheduleRange(businessId, startDate, endDate) {
  return getAll(
    "SELECT j.*, c.name AS customer_name, c.phone AS customer_phone FROM jobs j JOIN customers c ON j.customer_id = c.id WHERE j.business_id = $1 AND j.scheduled_date BETWEEN $2 AND $3 AND j.status IN ('SCHEDULED', 'IN_PROGRESS') ORDER BY j.scheduled_date, j.scheduled_time",
    [businessId, startDate, endDate]
  );
}

async function getOpenJobs(businessId) {
  return getAll(
    "SELECT j.*, c.name AS customer_name FROM jobs j JOIN customers c ON j.customer_id = c.id WHERE j.business_id = $1 AND j.status IN ('NEW', 'QUOTED', 'SCHEDULED', 'IN_PROGRESS') ORDER BY j.created_at DESC",
    [businessId]
  );
}

// --- Invoice queries ---

async function createInvoice(businessId, jobId, amount, lineItems) {
  const result = await pool.query(
    'INSERT INTO invoices (business_id, job_id, amount, line_items) VALUES ($1, $2, $3, $4) RETURNING *',
    [businessId, jobId, amount, lineItems || null]
  );
  return result.rows[0];
}

async function getInvoiceByJob(jobId) {
  return getOne('SELECT * FROM invoices WHERE job_id = $1', [jobId]);
}

async function markInvoicePaid(invoiceId) {
  await pool.query(
    "UPDATE invoices SET status = 'PAID', paid_at = NOW() WHERE id = $1",
    [invoiceId]
  );
  return getOne('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
}

async function getUnpaidInvoices(businessId) {
  return getAll(
    "SELECT i.*, j.description AS job_description, c.name AS customer_name, c.phone AS customer_phone FROM invoices i JOIN jobs j ON i.job_id = j.id JOIN customers c ON j.customer_id = c.id WHERE i.business_id = $1 AND i.status IN ('SENT', 'OVERDUE') ORDER BY i.sent_at",
    [businessId]
  );
}

// --- Message log ---

async function logMessage(businessId, direction, participant, body, { customerId, jobId, whatsappMessageId } = {}) {
  await pool.query(
    'INSERT INTO message_log (business_id, direction, participant, customer_id, job_id, body, whatsapp_message_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [businessId, direction, participant, customerId || null, jobId || null, body, whatsappMessageId || null]
  );
}

module.exports = {
  init,
  save,
  close,
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
