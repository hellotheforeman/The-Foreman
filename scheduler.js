const cron = require('node-cron');
const db = require('./db');
const messenger = require('./messenger');

const TZ = { timezone: 'Europe/London' };

function toTitleCase(str) {
  return (str || '').replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function start() {
  // Alert tradesperson when an invoice is due today — 8am daily
  cron.schedule('0 8 * * *', async () => {
    try {
      const due = await db.getInvoicesDueToday();
      for (const inv of due) {
        try {
          await messenger.sendToForeman(
            `📅 ${inv.customer_name}'s invoice for £${Number(inv.amount).toFixed(2)} is due today — worth a nudge if you haven't heard from them. Let me know when they pay up.`,
            { businessId: inv.business_id, businessPhone: inv.business_phone }
          );
        } catch (err) {
          console.error(`Due-today alert failed for invoice ${inv.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Due-today check failed:', err.message);
    }
  }, TZ);

  // Nudge tradesperson when a quote has been out for 7 days with no response — 9am daily
  cron.schedule('0 9 * * *', async () => {
    try {
      const staleQuotes = await db.getStaleQuotes(7);
      for (const job of staleQuotes) {
        try {
          const amount = job.quoted_amount ? ` — £${Number(job.quoted_amount).toFixed(2)}` : '';
          await messenger.sendToForeman(
            `📋 Your quote for ${job.customer_name} (${toTitleCase(job.description)}${amount}) has been out for 7 days with no response — worth a follow-up?`,
            { businessId: job.business_id, businessPhone: job.business_phone }
          );
        } catch (err) {
          console.error(`Quote follow-up failed for job ${job.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Quote follow-up check failed:', err.message);
    }
  }, TZ);

  // Mark invoices unpaid for 14+ days as OVERDUE and alert the tradesperson — 10am daily
  cron.schedule('0 10 * * *', async () => {
    try {
      await db.markAllOverdueInvoices();

      const businesses = await db.listBusinesses();
      const active = businesses.filter((b) => b.status === 'active');

      for (const business of active) {
        const unpaid = await db.getUnpaidInvoices(business.id);
        const overdue = unpaid.filter((i) => i.status === 'OVERDUE');

        for (const inv of overdue) {
          try {
            const days = inv.sent_at
              ? Math.floor((Date.now() - new Date(inv.sent_at).getTime()) / 86400000)
              : null;
            const daysStr = days !== null ? `${days} days overdue` : 'overdue';
            await messenger.sendToForeman(
              `⚠️ ${db.formatJobId(inv.job_id)} (${inv.customer_name}, £${Number(inv.amount).toFixed(2)}) is ${daysStr}.\n\nReply *chase ${inv.job_id}* to send a reminder.`,
              { businessId: business.id, businessPhone: business.phone }
            );
          } catch (err) {
            console.error(`Overdue reminder failed for invoice ${inv.id}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error('Overdue check failed:', err.message);
    }
  }, TZ);

  console.log('⏰ Scheduler started (due-today alerts, overdue invoice checks, quote follow-ups)');
}

module.exports = { start };
