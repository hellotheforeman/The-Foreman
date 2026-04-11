const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS businesses (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      trade TEXT,
      contact_name TEXT,
      email TEXT,
      phone TEXT NOT NULL UNIQUE,
      postcode TEXT,
      address TEXT,
      payment_details TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      business_id INTEGER REFERENCES businesses(id),
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      postcode TEXT,
      email TEXT,
      address TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS customers_business_phone_idx ON customers (business_id, phone)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      business_id INTEGER REFERENCES businesses(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      postcode TEXT,
      quoted_amount NUMERIC,
      quote_items TEXT,
      quote_line_items_json JSONB,
      scheduled_date TEXT,
      scheduled_time TEXT,
      completed_at TIMESTAMPTZ,
      completion_notes TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      business_id INTEGER REFERENCES businesses(id),
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      amount NUMERIC NOT NULL,
      line_items TEXT,
      line_items_json JSONB,
      status TEXT NOT NULL DEFAULT 'SENT',
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_log (
      id SERIAL PRIMARY KEY,
      business_id INTEGER REFERENCES businesses(id),
      direction TEXT NOT NULL,
      participant TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      job_id INTEGER REFERENCES jobs(id),
      body TEXT,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      whatsapp_message_id TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_state (
      business_id INTEGER PRIMARY KEY REFERENCES businesses(id),
      workflow TEXT NOT NULL,
      focus JSONB NOT NULL DEFAULT '{}'::jsonb,
      collected JSONB NOT NULL DEFAULT '{}'::jsonb,
      pending JSONB,
      options JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id)');
  await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id)');
  await pool.query('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id)');
  await pool.query('ALTER TABLE message_log ADD COLUMN IF NOT EXISTS business_id INTEGER REFERENCES businesses(id)');
  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trade TEXT');
  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS contact_name TEXT');
  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS email TEXT');
  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS postcode TEXT');
  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS notes TEXT');
  await pool.query("ALTER TABLE businesses ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'");
  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()');
  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address TEXT');
  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS payment_details TEXT');
  await pool.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS email TEXT');
  await pool.query('ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT');
  await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notes TEXT');
  await pool.query('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS quote_line_items_json JSONB');
  await pool.query('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS line_items_json JSONB');
  // Legacy column from an old schema — drop the NOT NULL so our INSERT (which omits it) doesn't fail.
  // Wrapped in a DO block so it silently skips if the column doesn't exist on fresh databases.
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE conversation_state ALTER COLUMN intent DROP NOT NULL;
    EXCEPTION WHEN undefined_column THEN NULL;
    END $$
  `);
  await pool.query("ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS focus JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS collected JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS pending JSONB");
  await pool.query("ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query("ALTER TABLE conversation_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()");

  // Normalise job status: collapse all non-cancelled values to 'active'
  await pool.query(`
    UPDATE jobs SET status = CASE
      WHEN LOWER(status) = 'cancelled' THEN 'cancelled'
      ELSE 'active'
    END
    WHERE status NOT IN ('active', 'cancelled')
  `);

  await pool.query(`
    UPDATE customers c
    SET business_id = b.id
    FROM businesses b
    WHERE c.business_id IS NULL AND b.phone = c.phone
  `);

  await pool.query(`
    UPDATE jobs j
    SET business_id = c.business_id
    FROM customers c
    WHERE j.customer_id = c.id AND j.business_id IS NULL
  `);

  await pool.query(`
    UPDATE invoices i
    SET business_id = j.business_id
    FROM jobs j
    WHERE i.job_id = j.id AND i.business_id IS NULL
  `);

  await pool.query(`
    UPDATE message_log
    SET business_id = j.business_id
    FROM jobs j
    WHERE message_log.job_id = j.id
      AND message_log.business_id IS NULL
  `);

  await pool.query(`
    UPDATE message_log
    SET business_id = c.business_id
    FROM customers c
    WHERE message_log.customer_id = c.id
      AND message_log.business_id IS NULL
  `);

  console.log('📦 Database ready');
}

// --- Helpers ---

async function getOne(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

async function getAll(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function run(sql, params = []) {
  await pool.query(sql, params);
}

function formatJobId(id) {
  return `#${String(id).padStart(4, '0')}`;
}

function parseJobId(str) {
  const match = str.match(/#?(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// --- Customer queries ---

async function createBusiness({ name, trade, contact_name, email, phone, postcode, notes }) {
  const existing = await getOne('SELECT * FROM businesses WHERE phone = $1', [phone]);
  if (existing) {
    return existing;
  }

  const { rows } = await pool.query(
    `INSERT INTO businesses (name, trade, contact_name, email, phone, postcode, notes, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING *`,
    [name, trade || null, contact_name || null, email || null, phone, postcode || null, notes || null]
  );

  return rows[0];
}

async function findBusinessByPhone(phone) {
  return getOne('SELECT * FROM businesses WHERE phone = $1', [phone]);
}

async function listBusinesses() {
  return getAll('SELECT * FROM businesses ORDER BY created_at DESC');
}

async function updateBusinessStatus(id, status) {
  const { rows } = await pool.query(
    'UPDATE businesses SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [status, id]
  );
  return rows[0] || null;
}

async function findOrCreateCustomer(businessId, name, phone, postcode, email) {
  let customer = await getOne('SELECT * FROM customers WHERE business_id = $1 AND phone = $2', [businessId, phone]);
  if (!customer) {
    const { rows } = await pool.query(
      'INSERT INTO customers (business_id, name, phone, postcode, email) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [businessId, name, phone, postcode || null, email || null]
    );
    customer = rows[0];
  } else {
    const updates = [];
    const vals = [];
    if (postcode && !customer.postcode) {
      updates.push(`postcode = $${vals.length + 1}`);
      vals.push(postcode);
      customer.postcode = postcode;
    }
    if (email && !customer.email) {
      updates.push(`email = $${vals.length + 1}`);
      vals.push(email);
      customer.email = email;
    }
    if (updates.length) {
      vals.push(customer.id);
      await run(`UPDATE customers SET ${updates.join(', ')} WHERE id = $${vals.length}`, vals);
    }
  }
  return customer;
}

async function findCustomerByName(businessId, name) {
  return getAll("SELECT * FROM customers WHERE business_id = $1 AND LOWER(name) LIKE '%' || LOWER($2) || '%'", [businessId, name]);
}

async function getCustomer(id, businessId) {
  if (businessId) {
    return getOne('SELECT * FROM customers WHERE id = $1 AND business_id = $2', [id, businessId]);
  }
  return getOne('SELECT * FROM customers WHERE id = $1', [id]);
}

// --- Job queries ---

// Derives the display status from job data and its invoice (if any).
// Status is never stored manually — it's always computed from position in the funnel.
function deriveStatus(job, invoice = null) {
  if (job.status === 'cancelled') return 'cancelled';
  if (invoice?.status === 'PAID') return 'complete';
  if (invoice) return 'outstanding';
  if (!job.scheduled_date) return 'new';
  const today = new Date().toISOString().split('T')[0];
  return job.scheduled_date > today ? 'planned' : 'in progress';
}

async function createJob(businessId, customerId, description, postcode) {
  const { rows } = await pool.query(
    'INSERT INTO jobs (business_id, customer_id, description, postcode, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [businessId, customerId, description, postcode || null, 'active']
  );
  return rows[0];
}

async function getJob(id, businessId) {
  if (businessId) {
    return getOne('SELECT * FROM jobs WHERE id = $1 AND business_id = $2', [id, businessId]);
  }
  return getOne('SELECT * FROM jobs WHERE id = $1', [id]);
}

async function getJobWithCustomer(id, businessId) {
  const job = await getJob(id, businessId);
  if (!job) return null;
  job.customer = await getCustomer(job.customer_id, businessId);
  return job;
}

async function setQuote(jobId, amount, items, lineItemsJson) {
  await run(
    'UPDATE jobs SET quoted_amount = $1, quote_items = $2, quote_line_items_json = $3 WHERE id = $4',
    [amount, items, lineItemsJson ? JSON.stringify(lineItemsJson) : null, jobId]
  );
  return getJob(jobId);
}

async function scheduleJob(jobId, date, time) {
  await run('UPDATE jobs SET scheduled_date = $1, scheduled_time = $2 WHERE id = $3', [date, time || null, jobId]);
  return getJob(jobId);
}

async function completeJob(jobId, notes) {
  await run('UPDATE jobs SET completion_notes = $1, completed_at = NOW() WHERE id = $2', [notes || null, jobId]);
  return getJob(jobId);
}

async function cancelJob(jobId, businessId) {
  await run("UPDATE jobs SET status = 'cancelled' WHERE id = $1 AND business_id = $2", [jobId, businessId]);
  return getJob(jobId, businessId);
}

async function getScheduleForDate(dateStr, businessId) {
  return getAll(
    `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone
     FROM jobs j JOIN customers c ON j.customer_id = c.id
     WHERE j.business_id = $1 AND j.scheduled_date = $2 AND j.status != 'cancelled'
     ORDER BY j.scheduled_time`,
    [businessId, dateStr]
  );
}

async function getScheduleRange(startDate, endDate, businessId) {
  return getAll(
    `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone
     FROM jobs j JOIN customers c ON j.customer_id = c.id
     WHERE j.business_id = $1 AND j.scheduled_date BETWEEN $2 AND $3 AND j.status != 'cancelled'
     ORDER BY j.scheduled_date, j.scheduled_time`,
    [businessId, startDate, endDate]
  );
}

async function getOpenJobs(businessId) {
  // Open = not cancelled, and no paid invoice
  return getAll(
    `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone,
            i.id AS invoice_id, i.status AS invoice_status
     FROM jobs j
     JOIN customers c ON j.customer_id = c.id
     LEFT JOIN invoices i ON i.job_id = j.id
     WHERE j.business_id = $1
       AND j.status != 'cancelled'
       AND (i.id IS NULL OR i.status != 'PAID')
     ORDER BY j.created_at DESC`,
    [businessId]
  );
}

async function findOpenJobsByCustomerName(businessId, query) {
  return getAll(
    `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone
     FROM jobs j JOIN customers c ON j.customer_id = c.id
     LEFT JOIN invoices i ON i.job_id = j.id
     WHERE j.business_id = $1 AND j.status != 'cancelled'
       AND (i.id IS NULL OR i.status != 'PAID')
       AND LOWER(c.name) LIKE '%' || LOWER($2) || '%'
     ORDER BY j.created_at DESC LIMIT 10`,
    [businessId, query]
  );
}

async function findJobsByDescription(businessId, query) {
  return getAll(
    `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone
     FROM jobs j JOIN customers c ON j.customer_id = c.id
     LEFT JOIN invoices i ON i.job_id = j.id
     WHERE j.business_id = $1 AND j.status != 'cancelled'
       AND (i.id IS NULL OR i.status != 'PAID')
       AND LOWER(j.description) LIKE '%' || LOWER($2) || '%'
     ORDER BY j.created_at DESC LIMIT 10`,
    [businessId, query]
  );
}

async function findLikelyOpenJobs(businessId, query) {
  const trimmed = (query || '').trim();
  if (!trimmed) return [];

  const [byName, byDescription] = await Promise.all([
    findOpenJobsByCustomerName(businessId, trimmed),
    findJobsByDescription(businessId, trimmed),
  ]);

  const seen = new Set();
  return [...byName, ...byDescription].filter((job) => {
    if (seen.has(job.id)) return false;
    seen.add(job.id);
    return true;
  });
}

// --- Invoice queries ---

async function createInvoice(businessId, jobId, amount, lineItems, lineItemsJson) {
  const { rows } = await pool.query(
    'INSERT INTO invoices (business_id, job_id, amount, line_items, line_items_json) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [businessId, jobId, amount, lineItems || null, lineItemsJson ? JSON.stringify(lineItemsJson) : null]
  );
  return rows[0];
}

async function updateInvoice(jobId, businessId, fields) {
  const allowed = ['amount', 'line_items', 'line_items_json'];
  const updates = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    if (key === 'line_items_json') {
      updates.push(`${key} = $${i++}`);
      values.push(val === null ? null : JSON.stringify(val));
    } else {
      updates.push(`${key} = $${i++}`);
      values.push(val);
    }
  }
  if (!updates.length) return null;
  values.push(jobId, businessId);
  const { rows } = await pool.query(
    `UPDATE invoices SET ${updates.join(', ')} WHERE job_id = $${i++} AND business_id = $${i} AND status != 'PAID' RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function getInvoiceByJob(jobId, businessId) {
  if (businessId) {
    return getOne('SELECT * FROM invoices WHERE job_id = $1 AND business_id = $2', [jobId, businessId]);
  }
  return getOne('SELECT * FROM invoices WHERE job_id = $1', [jobId]);
}

async function markInvoicePaid(invoiceId) {
  await run("UPDATE invoices SET status = 'PAID', paid_at = NOW() WHERE id = $1", [invoiceId]);
  return getOne('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
}

async function getUnpaidInvoices(businessId) {
  return getAll(
    "SELECT i.*, j.description AS job_description, c.name AS customer_name, c.phone AS customer_phone FROM invoices i JOIN jobs j ON i.job_id = j.id JOIN customers c ON j.customer_id = c.id WHERE i.business_id = $1 AND i.status IN ('SENT', 'OVERDUE') ORDER BY i.sent_at",
    [businessId]
  );
}

// --- Update helpers ---

async function updateBusiness(id, fields) {
  const allowed = ['name', 'trade', 'email', 'phone', 'address', 'payment_details', 'contact_name'];
  const updates = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = $${i++}`);
      values.push(val);
    }
  }
  if (!updates.length) return null;
  updates.push('updated_at = NOW()');
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE businesses SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function updateJob(id, businessId, fields) {
  const allowed = ['status', 'scheduled_date', 'scheduled_time', 'notes', 'completion_notes', 'description'];
  const updates = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = $${i++}`);
      values.push(val);
    }
  }
  if (!updates.length) return null;
  values.push(id, businessId);
  const { rows } = await pool.query(
    `UPDATE jobs SET ${updates.join(', ')} WHERE id = $${i++} AND business_id = $${i} RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function appendJobNote(id, businessId, note) {
  const job = await getJob(id, businessId);
  if (!job) return null;
  const newNotes = job.notes ? `${job.notes}\n${note}` : note;
  return updateJob(id, businessId, { notes: newNotes });
}

async function updateCustomer(id, businessId, fields) {
  const allowed = ['name', 'phone', 'email', 'address', 'notes'];
  const updates = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    if (allowed.includes(key)) {
      updates.push(`${key} = $${i++}`);
      values.push(val);
    }
  }
  if (!updates.length) return null;
  values.push(id, businessId);
  const { rows } = await pool.query(
    `UPDATE customers SET ${updates.join(', ')} WHERE id = $${i++} AND business_id = $${i} RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function markAllOverdueInvoices() {
  await run(
    `UPDATE invoices SET status = 'OVERDUE'
     WHERE status = 'SENT' AND sent_at < NOW() - INTERVAL '14 days'`
  );
}

// --- Earnings ---

async function getEarningsSummary(businessId, startDate, endDate) {
  const row = await getOne(
    `SELECT
      COALESCE(SUM(amount), 0)                                           AS total_invoiced,
      COALESCE(SUM(CASE WHEN status = 'PAID'    THEN amount END), 0)    AS total_paid,
      COALESCE(SUM(CASE WHEN status != 'PAID'   THEN amount END), 0)    AS total_unpaid,
      COALESCE(SUM(CASE WHEN status = 'OVERDUE' THEN amount END), 0)    AS total_overdue,
      COUNT(*)                                                           AS invoice_count
     FROM invoices
     WHERE business_id = $1 AND created_at >= $2 AND created_at <= $3`,
    [businessId, startDate, endDate]
  );
  return row;
}

// --- Conversation state ---

async function getConversationState(businessId) {
  const row = await getOne('SELECT * FROM conversation_state WHERE business_id = $1', [businessId]);
  if (!row) return null;
  return {
    business_id: row.business_id,
    workflow: row.workflow,
    focus: row.focus || {},
    collected: row.collected || {},
    pending: row.pending || null,
    options: row.options || [],
    updated_at: row.updated_at,
  };
}

async function setConversationState(businessId, state) {
  await pool.query(
    `INSERT INTO conversation_state (business_id, workflow, focus, collected, pending, options, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, NOW())
     ON CONFLICT (business_id)
     DO UPDATE SET
       workflow = EXCLUDED.workflow,
       focus = EXCLUDED.focus,
       collected = EXCLUDED.collected,
       pending = EXCLUDED.pending,
       options = EXCLUDED.options,
       updated_at = NOW()`,
    [
      businessId,
      state.workflow,
      JSON.stringify(state.focus || {}),
      JSON.stringify(state.collected || {}),
      state.pending == null ? null : JSON.stringify(state.pending),
      JSON.stringify(state.options || []),
    ]
  );
}

async function clearConversationState(businessId) {
  await run('DELETE FROM conversation_state WHERE business_id = $1', [businessId]);
}

// --- Message log ---

async function logMessage(direction, participant, body, { businessId, customerId, jobId, whatsappMessageId } = {}) {
  await run(
    'INSERT INTO message_log (business_id, direction, participant, customer_id, job_id, body, whatsapp_message_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [businessId || null, direction, participant, customerId || null, jobId || null, body, whatsappMessageId || null]
  );
}

module.exports = {
  init,
  formatJobId,
  parseJobId,
  createBusiness,
  findBusinessByPhone,
  listBusinesses,
  updateBusinessStatus,
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
  findOpenJobsByCustomerName,
  findJobsByDescription,
  findLikelyOpenJobs,
  createInvoice,
  updateInvoice,
  getInvoiceByJob,
  markInvoicePaid,
  deriveStatus,
  cancelJob,
  getUnpaidInvoices,
  getEarningsSummary,
  updateBusiness,
  updateJob,
  appendJobNote,
  updateCustomer,
  markAllOverdueInvoices,
  getConversationState,
  setConversationState,
  clearConversationState,
  logMessage,
  getAll,
};
