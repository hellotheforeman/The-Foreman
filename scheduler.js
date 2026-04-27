const cron = require('node-cron');
const db = require('./db');
const messenger = require('./messenger');

const TZ = { timezone: 'Europe/London' };

function start() {
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

  console.log('⏰ Scheduler started (overdue invoice checks)');
}

module.exports = { start };
