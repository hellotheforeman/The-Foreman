const cron = require('node-cron');
const db = require('./db');
const messenger = require('./messenger');
const templates = require('./templates');

function start() {
  // Evening reminder: 7pm every day — remind about tomorrow's jobs
  cron.schedule('0 19 * * *', async () => {
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().split('T')[0];
      const jobs = db.getScheduleForDate(dateStr);

      if (jobs.length) {
        const summary = templates.formatScheduleDay(jobs, dateStr);
        await messenger.sendToForeman(`📅 *Tomorrow's schedule:*\n\n${summary}`);
      }
    } catch (err) {
      console.error('Evening reminder failed:', err.message);
    }
  });

  // Monday morning summary: 8am every Monday
  cron.schedule('0 8 * * 1', async () => {
    try {
      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + 7);
      const startStr = now.toISOString().split('T')[0];
      const endStr = end.toISOString().split('T')[0];

      const jobs = db.getScheduleRange(startStr, endStr);
      const unpaid = db.getUnpaidInvoices();
      const open = db.getOpenJobs();

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
        const total = unpaid.reduce((s, i) => s + i.amount, 0);
        parts.push(`\n💷 *${unpaid.length} unpaid invoices (£${total.toFixed(2)})*`);
      }

      const quotedJobs = open.filter((j) => j.status === 'QUOTED');
      if (quotedJobs.length) {
        parts.push(`\n📋 *${quotedJobs.length} quotes awaiting response*`);
      }

      await messenger.sendToForeman(parts.join('\n'));
    } catch (err) {
      console.error('Weekly summary failed:', err.message);
    }
  });

  // Check for overdue invoices: 10am daily
  cron.schedule('0 10 * * *', async () => {
    try {
      const unpaid = db.getUnpaidInvoices();
      const overdue = unpaid.filter((i) => {
        const days = Math.floor((Date.now() - new Date(i.sent_at).getTime()) / 86400000);
        return days >= 7;
      });

      for (const inv of overdue) {
        const days = Math.floor((Date.now() - new Date(inv.sent_at).getTime()) / 86400000);
        await messenger.sendToForeman(
          `⚠️ Invoice ${db.formatJobId(inv.job_id)} (${inv.customer_name}, £${inv.amount.toFixed(2)}) is ${days} days old.\n\nReply *chase ${inv.job_id}* to send a reminder.`
        );
      }
    } catch (err) {
      console.error('Overdue check failed:', err.message);
    }
  });

  console.log('⏰ Scheduler started (evening reminders, weekly summary, overdue checks)');
}

module.exports = { start };
