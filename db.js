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
      business_name TEXT,
      trade TEXT,
      contact_name TEXT,
      email TEXT,
      phone TEXT NOT NULL UNIQUE,
      address TEXT,
      payment_details TEXT,
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
    CREATE TABLE IF NOT EXISTS booking_blocks (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id),
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      start_date TEXT NOT NULL,
      end_date TEXT,
      start_time TEXT,
      duration INTEGER,
      duration_unit TEXT DEFAULT 'hours',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query('ALTER TABLE booking_blocks ADD COLUMN IF NOT EXISTS end_date TEXT');

  await pool.query(`
    CREATE INDEX IF NOT EXISTS booking_blocks_job_id_idx ON booking_blocks (job_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS booking_blocks_business_date_idx ON booking_blocks (business_id, start_date)
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
  await pool.query('ALTER TABLE businesses DROP COLUMN IF EXISTS postcode');
  await pool.query('ALTER TABLE businesses DROP COLUMN IF EXISTS notes');
  await pool.query("ALTER TABLE businesses ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'");
  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()');
  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address TEXT');
  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS payment_details TEXT');
  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_name TEXT');
  await pool.query(`
    DO $$ BEGIN
      UPDATE businesses SET business_name = name WHERE business_name IS NULL;
    EXCEPTION WHEN undefined_column THEN NULL;
    END $$
  `);
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

  // Migrate job status to the full set of meaningful values.
  // Only touches rows that are still on the old 'active' value.
  await pool.query(`
    UPDATE jobs SET status = CASE
      WHEN EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = jobs.id AND i.status = 'PAID') THEN 'complete'
      WHEN EXISTS (SELECT 1 FROM invoices i WHERE i.job_id = jobs.id) THEN 'outstanding'
      WHEN scheduled_date IS NOT NULL THEN 'in progress'
      ELSE 'new'
    END
    WHERE status = 'active'
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

  // Migrate existing scheduled jobs into booking_blocks (idempotent)
  await pool.query(`
    INSERT INTO booking_blocks (job_id, business_id, start_date, start_time)
    SELECT id, business_id, scheduled_date, scheduled_time
    FROM jobs
    WHERE scheduled_date IS NOT NULL
      AND business_id IS NOT NULL
      AND status NOT IN ('cancelled', 'complete')
      AND NOT EXISTS (
        SELECT 1 FROM booking_blocks WHERE job_id = jobs.id
      )
  `);

  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS vat_registered BOOLEAN NOT NULL DEFAULT false');
  await pool.query('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS vat_number TEXT');
  await pool.query('ALTER TABLE customers DROP COLUMN IF EXISTS notes');

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

// --- Customer queries ---

async function createBusiness({ name, trade, contact_name, email, phone }) {
  const existing = await getOne('SELECT * FROM businesses WHERE phone = $1', [phone]);
  if (existing) {
    return existing;
  }

  const { rows } = await pool.query(
    `INSERT INTO businesses (name, business_name, trade, contact_name, email, phone, status)
     VALUES ($1, $1, $2, $3, $4, $5, 'pending')
     RETURNING *`,
    [name, trade || null, contact_name || null, email || null, phone]
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

function deriveStatus(job) {
  return job.status;
}

async function createJob(businessId, customerId, description, postcode) {
  const { rows } = await pool.query(
    'INSERT INTO jobs (business_id, customer_id, description, postcode, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [businessId, customerId, description, postcode || null, 'new']
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

// Returns the date that is numDays working days after startDateStr (inclusive).
// e.g. addWorkingDays('2026-04-17', 3) → '2026-04-21' (Fri → Mon → Tue)
function addWorkingDays(startDateStr, numDays) {
  // Use noon UTC to avoid DST edge-cases when formatting back to ISO date
  const d = new Date(startDateStr + 'T12:00:00Z');
  let remaining = numDays - 1; // the start date counts as day 1
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining--; // skip Sun(0) and Sat(6)
  }
  return d.toISOString().split('T')[0];
}

async function addBookingBlock(jobId, businessId, startDate, startTime, duration, durationUnit) {
  // For multi-day blocks, compute the last working day so queries can do a simple range check
  const endDate = (durationUnit === 'days' && duration > 1)
    ? addWorkingDays(startDate, duration)
    : startDate;

  const { rows } = await pool.query(
    `INSERT INTO booking_blocks (job_id, business_id, start_date, end_date, start_time, duration, duration_unit)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [jobId, businessId, startDate, endDate, startTime || null, duration || null, durationUnit || 'hours']
  );
  // Keep jobs.scheduled_date in sync for status transitions and sorting
  await run(
    `UPDATE jobs SET scheduled_date = $1, scheduled_time = $2,
      status = CASE WHEN status IN ('new', 'in progress') THEN 'in progress' ELSE status END
     WHERE id = $3`,
    [startDate, startTime || null, jobId]
  );
  return rows[0];
}

async function getBookingOverlaps(businessId, startDate, endDate, excludeJobId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (bb.job_id)
       bb.start_date, bb.end_date,
       j.id AS job_id, j.description,
       c.name AS customer_name
     FROM booking_blocks bb
     JOIN jobs j ON bb.job_id = j.id
     JOIN customers c ON j.customer_id = c.id
     WHERE bb.business_id = $1
       AND bb.job_id != $2
       AND bb.start_date <= $4
       AND bb.end_date >= $3
       AND j.status NOT IN ('cancelled', 'complete')
     ORDER BY bb.job_id, bb.start_date`,
    [businessId, excludeJobId || 0, startDate, endDate]
  );
  return rows;
}

async function clearBookingBlocks(jobId, businessId) {
  await run('DELETE FROM booking_blocks WHERE job_id = $1 AND business_id = $2', [jobId, businessId]);
}

async function getBookingBlocksForJob(jobId, businessId) {
  return getAll(
    'SELECT * FROM booking_blocks WHERE job_id = $1 AND business_id = $2 ORDER BY start_date, start_time NULLS LAST',
    [jobId, businessId]
  );
}

async function cancelJob(jobId, businessId) {
  await run("UPDATE jobs SET status = 'cancelled' WHERE id = $1 AND business_id = $2", [jobId, businessId]);
  return getJob(jobId, businessId);
}

async function getScheduleForDate(dateStr, businessId) {
  // Weekends are never working days — return nothing for Sat/Sun
  const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
  if (dow === 0 || dow === 6) return [];

  return getAll(
    `SELECT
       j.id, j.description, j.postcode, j.status,
       bb.id AS block_id,
       bb.start_date AS scheduled_date,
       bb.start_time AS scheduled_time,
       bb.duration,
       bb.duration_unit,
       c.name AS customer_name,
       c.phone AS customer_phone
     FROM booking_blocks bb
     JOIN jobs j ON bb.job_id = j.id
     JOIN customers c ON j.customer_id = c.id
     WHERE bb.business_id = $1
       AND j.status != 'cancelled'
       AND $2::date BETWEEN bb.start_date::date AND COALESCE(bb.end_date::date, bb.start_date::date)
     ORDER BY bb.start_time NULLS LAST`,
    [businessId, dateStr]
  );
}

async function getScheduleRange(startDate, endDate, businessId) {
  // Fetch all blocks that overlap the requested range, then expand multi-day
  // blocks so each working day within the range gets its own row.
  const blocks = await getAll(
    `SELECT
       j.id, j.description, j.postcode, j.status,
       bb.id AS block_id,
       bb.start_date,
       bb.end_date,
       bb.start_time AS scheduled_time,
       bb.duration,
       bb.duration_unit,
       c.name AS customer_name,
       c.phone AS customer_phone
     FROM booking_blocks bb
     JOIN jobs j ON bb.job_id = j.id
     JOIN customers c ON j.customer_id = c.id
     WHERE bb.business_id = $1
       AND j.status != 'cancelled'
       AND bb.start_date::date <= $3::date
       AND COALESCE(bb.end_date::date, bb.start_date::date) >= $2::date
     ORDER BY bb.start_date, bb.start_time NULLS LAST`,
    [businessId, startDate, endDate]
  );

  // Expand multi-day blocks into one row per working day within the range
  const rows = [];
  const rangeStart = new Date(startDate + 'T12:00:00Z');
  const rangeEnd = new Date(endDate + 'T12:00:00Z');

  for (const block of blocks) {
    const blockEnd = block.end_date || block.start_date;
    if (block.start_date === blockEnd) {
      // Single-day block — include as-is if it's a weekday
      const d = new Date(block.start_date + 'T12:00:00Z');
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        rows.push({ ...block, scheduled_date: block.start_date });
      }
    } else {
      // Multi-day: emit one row per working day within [rangeStart, rangeEnd]
      const blockStart = new Date(block.start_date + 'T12:00:00Z');
      const blockEndDate = new Date(blockEnd + 'T12:00:00Z');
      const cursor = new Date(Math.max(blockStart, rangeStart));
      const limit = new Date(Math.min(blockEndDate, rangeEnd));
      while (cursor <= limit) {
        const dow = cursor.getUTCDay();
        if (dow !== 0 && dow !== 6) {
          rows.push({ ...block, scheduled_date: cursor.toISOString().split('T')[0] });
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }
  }

  rows.sort((a, b) => {
    if (a.scheduled_date < b.scheduled_date) return -1;
    if (a.scheduled_date > b.scheduled_date) return 1;
    return (a.scheduled_time || '') < (b.scheduled_time || '') ? -1 : 1;
  });

  return rows;
}

async function getOpenJobs(businessId) {
  return getAll(
    `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone
     FROM jobs j
     JOIN customers c ON j.customer_id = c.id
     WHERE j.business_id = $1
       AND j.status NOT IN ('cancelled', 'complete')
     ORDER BY j.created_at DESC`,
    [businessId]
  );
}

async function getJobsByStatus(businessId, status) {
  return getAll(
    `SELECT j.*, c.name AS customer_name
     FROM jobs j
     JOIN customers c ON j.customer_id = c.id
     WHERE j.business_id = $1 AND j.status = $2
     ORDER BY j.created_at DESC`,
    [businessId, status]
  );
}

async function findOpenJobsByCustomerName(businessId, query) {
  return getAll(
    `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone
     FROM jobs j JOIN customers c ON j.customer_id = c.id
     WHERE j.business_id = $1 AND j.status NOT IN ('cancelled', 'complete')
       AND LOWER(c.name) LIKE '%' || LOWER($2) || '%'
     ORDER BY j.created_at DESC LIMIT 10`,
    [businessId, query]
  );
}

async function findJobsByDescription(businessId, query) {
  return getAll(
    `SELECT j.*, c.name AS customer_name, c.phone AS customer_phone
     FROM jobs j JOIN customers c ON j.customer_id = c.id
     WHERE j.business_id = $1 AND j.status NOT IN ('cancelled', 'complete')
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
  await run("UPDATE jobs SET status = 'outstanding' WHERE id = $1 AND status != 'cancelled'", [jobId]);
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
  await run("UPDATE jobs SET status = 'complete' WHERE id = (SELECT job_id FROM invoices WHERE id = $1)", [invoiceId]);
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
  const allowed = ['name', 'phone', 'email', 'address', 'postcode'];
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
  addBookingBlock,
  getBookingOverlaps,
  clearBookingBlocks,
  addWorkingDays,
  getBookingBlocksForJob,
  getScheduleForDate,
  getScheduleRange,
  getOpenJobs,
  getJobsByStatus,
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
