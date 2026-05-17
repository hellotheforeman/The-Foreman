const cron = require('node-cron');
const db = require('./db');
const messenger = require('./messenger');
const { setConversationState } = require('./conversation-state');

const TZ = { timezone: 'Europe/London' };

function toTitleCase(str) {
  return (str || '').replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function start() {
  // Single 8am morning briefing — due today, overdue invoices, stale quotes
  cron.schedule('0 8 * * *', async () => {
    try {
      await db.markAllOverdueInvoices();

      const businesses = await db.listBusinesses();
      const active = businesses.filter(b => b.status === 'active' && b.onboarded);

      for (const business of active) {
        try {
          const [dueToday, overdue, staleQuotes] = await Promise.all([
            db.getInvoicesDueToday(business.id),
            db.getOverdueInvoices(business.id),
            db.getStaleQuotes(7, business.id),
          ]);

          if (!dueToday.length && !overdue.length && !staleQuotes.length) continue;

          const items = [];
          const lines = ['🌅 *Morning update*'];
          let n = 1;

          if (dueToday.length) {
            lines.push('', '📅 *Due today*');
            for (const inv of dueToday) {
              const net = Number(inv.amount);
              const display = business.vat_registered ? `£${(net * 1.20).toFixed(2)} inc. VAT` : `£${net.toFixed(2)}`;
              lines.push(`${n}. ${inv.customer_name} — ${display}`);
              items.push({ n, type: 'invoice_due', invoiceId: inv.id, jobId: inv.job_id, customerName: inv.customer_name });
              n++;
            }
          }

          if (overdue.length) {
            lines.push('', '⚠️ *Overdue*');
            for (const inv of overdue) {
              const days = inv.sent_at
                ? Math.floor((Date.now() - new Date(inv.sent_at).getTime()) / 86400000)
                : null;
              const daysStr = days !== null ? ` (${days} days)` : '';
              const net = Number(inv.amount);
              const display = business.vat_registered ? `£${(net * 1.20).toFixed(2)} inc. VAT` : `£${net.toFixed(2)}`;
              lines.push(`${n}. ${inv.customer_name} — ${display}${daysStr}`);
              items.push({ n, type: 'invoice_overdue', invoiceId: inv.id, jobId: inv.job_id, customerName: inv.customer_name });
              n++;
            }
          }

          if (staleQuotes.length) {
            lines.push('', '📋 *Quotes with no response*');
            for (const job of staleQuotes) {
              const days = Math.floor((Date.now() - new Date(job.created_at).getTime()) / 86400000);
              const desc = toTitleCase(job.description);
              const amount = job.quoted_amount ? ` — £${Number(job.quoted_amount).toFixed(2)}` : '';
              lines.push(`${n}. ${job.customer_name} — ${desc}${amount} (${days} days)`);
              items.push({ n, type: 'stale_quote', jobId: job.id, customerName: job.customer_name });
              n++;
            }
          }

          lines.push('', 'Let me know if any of these have paid or if you need me to draft a chaser.');

          await messenger.sendToForeman(lines.join('\n'), { businessId: business.id, businessPhone: business.phone });

          await setConversationState(business.id, {
            workflow: 'morning_briefing',
            focus: {},
            collected: { items },
            pending: { type: 'selection', field: 'action' },
            options: [],
          });
        } catch (err) {
          console.error(`Morning briefing failed for business ${business.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Morning briefing failed:', err.message);
    }
  }, TZ);

  console.log('⏰ Scheduler started (8am morning briefing)');
}

module.exports = { start };
