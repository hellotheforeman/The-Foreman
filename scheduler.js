const cron = require('node-cron');
const db = require('./db');
const messenger = require('./messenger');
const templates = require('./templates');

function start() {
  // Evening reminder: 7pm every day — remind about tomorrow's jobs
  cron.schedule('0 19 * * *', async () => {
    const businesses = await db.getAllActiveBusinesses();
    for (const business of businesses) {
      try {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dateStr = tomorrow.toISOString().split('T')[0];
        const jobs = await db.getScheduleForDate(business.id, dateStr);

        if (jobs.length) {
          const summary = templates.formatScheduleDay(jobs, dateStr);
          await messenger.sendToForeman(
            `📅 *Tomorrow's schedule:*\n\n${summary}`,
            { businessId: business.id, businessPhone: business.phone }
          );
        }
      } catch (err) {
        console.error(`Evening reminder failed for ${business.business_name}:`, err.message);
      }
    }
  });

  // Monday morning summary: 8am every Monday
  cron.schedule('0 8 * * 1', async () => {
    const businesses = await db.getAllActiveBusinesses();
    for (const business of businesses) {
      try {
        const now = new Date();
        const end = new Date(now);
        end.setDate(end.getDate() + 7);
        const startStr = now.toISOString().split('T')[0];
        const endStr = end.toISOString().split('T')[0];

        const jobs = await db.getScheduleRange(business.id, startStr, endStr);
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
          const total = unpaid.reduce((s, i) => s + i.amount, 0);
          parts.push(`\n💷 *${unpaid.length} unpaid invoices (£${total.toFixed(2)})*`);
        }

        const quotedJobs = open.filter((j) => j.status === 'QUOTED');
        if (quotedJobs.length) {
          parts.push(`\n📋 *${quotedJobs.length} quotes awaiting response*`);
        }

        await messenger.sendToForeman(
          parts.join('\n'),
          { businessId: business.id, businessPhone: business.phone }
        );
      } catch (err) {
        console.error(`Weekly summary failed for ${business.business_name}:`, err.message);
      }
    }
  });

  // Check for overdue invoices: 10am daily
  cron.schedule('0 10 * * *', async () => {
    const businesses = await db.getAllActiveBusinesses();
    for (const business of businesses) {
      try {
        const unpaid = await db.getUnpaidInvoices(business.id);
        const overdue = unpaid.filter((i) => {
          const days = Math.floor((Date.now() - new Date(i.sent_at).getTime()) / 86400000);
          return days >= 7;
        });

        for (const inv of overdue) {
          const days = Math.floor((Date.now() - new Date(inv.sent_at).getTime()) / 86400000);
          await messenger.sendToForeman(
            `⚠️ Invoice ${db.formatJobId(inv.job_id)} (${inv.customer_name}, £${inv.amount.toFixed(2)}) is ${days} days old.\n\nReply *chase ${inv.job_id}* to send a reminder.`,
            { businessId: business.id, businessPhone: business.phone }
          );
        }
      } catch (err) {
        console.error(`Overdue check failed for ${business.business_name}:`, err.message);
      }
    }
  });

  console.log('⏰ Scheduler started (evening reminders, weekly summary, overdue checks)');
}

module.exports = { start };
