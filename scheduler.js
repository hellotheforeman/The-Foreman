const cron = require('node-cron');
const db = require('./db');
const messenger = require('./messenger');
const templates = require('./templates');
const config = require('./config');

function start() {
  // These reminders currently target the single configured foreman.
  // Skip quietly if there is no active business for that number yet.

  // Evening reminder: 7pm every day — remind about tomorrow's jobs
  cron.schedule('0 19 * * *', async () => {
    try {
      const businesses = await db.listBusinesses();
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split('T')[0];

      for (const business of businesses.filter((b) => b.status === 'active')) {
        const jobs = await db.getScheduleForDate(dateStr, business.id);
        if (jobs.length) {
          await messenger.sendToForeman(
            `📅 *Tomorrow's schedule:*\n\n${templates.formatScheduleDay(jobs, dateStr)}`,
            { businessId: business.id, businessPhone: business.phone }
          );
        }
      }
    } catch (err) {
      console.error('Evening reminder failed:', err.message);
    }
  });

  // Monday morning summary: 8am every Monday
  cron.schedule('0 8 * * 1', async () => {
    try {
      const businesses = await db.listBusinesses();
      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + 7);
      const startStr = now.toISOString().split('T')[0];
      const endStr = end.toISOString().split('T')[0];

      for (const business of businesses.filter((b) => b.status === 'active')) {
        const jobs = await db.getScheduleRange(startStr, endStr, business.id);
        const unpaid = await db.getUnpaidInvoices(business.id);
        const open = await db.getOpenJobs(business.id);

        const parts = [`🔨 *Weekly Summary*\n`];
        parts.push(`📅 *${jobs.length} jobs scheduled this week*`);
        if (jobs.length) {
          const byDate = {};
          for (const j of jobs) {
            if (!byDate[j.scheduled_date]) byDate[j.scheduled_date] = [];
            byDate[j.scheduled_date].push(j);
          }
          for (const [d, js] of Object.entries(byDate)) {
            parts.push(templates.formatScheduleDay(js, d));
          }
        }
        if (unpaid.length) {
          const total = unpaid.reduce((s, i) => s + Number(i.amount), 0);
          parts.push(`\n💷 *${unpaid.length} unpaid invoices (£${total.toFixed(2)})*`);
        }
        const quotedJobs = open.filter((j) => j.status === 'new' && j.quoted_amount);
        if (quotedJobs.length) {
          parts.push(`\n📋 *${quotedJobs.length} quotes awaiting response*`);
        }

        await messenger.sendToForeman(parts.join('\n'), {
          businessId: business.id,
          businessPhone: business.phone,
        });
      }
    } catch (err) {
      console.error('Weekly summary failed:', err.message);
    }
  });

  // Check for overdue invoices: 10am daily
  cron.schedule('0 10 * * *', async () => {
    try {
      // Mark any invoices unpaid for 14+ days as OVERDUE
      await db.markAllOverdueInvoices();

      // Send reminders for all active businesses
      const businesses = await db.listBusinesses();
      const active = businesses.filter((b) => b.status === 'active');

      for (const business of active) {
        const unpaid = await db.getUnpaidInvoices(business.id);
        const overdue = unpaid.filter((i) => i.status === 'OVERDUE');

        for (const inv of overdue) {
          const days = Math.floor((Date.now() - new Date(inv.sent_at).getTime()) / 86400000);
          await messenger.sendToForeman(
            `⚠️ Invoice ${db.formatJobId(inv.job_id)} (${inv.customer_name}, £${Number(inv.amount).toFixed(2)}) is ${days} days overdue.\n\nReply *chase ${inv.job_id}* to send a reminder.`,
            { businessId: business.id, businessPhone: business.phone }
          );
        }
      }
    } catch (err) {
      console.error('Overdue check failed:', err.message);
    }
  });

  console.log('⏰ Scheduler started (evening reminders, weekly summary, overdue checks)');
}

module.exports = { start };
