const cron = require('node-cron');
const db = require('./db');
const messenger = require('./messenger');
const { setConversationState, getConversationState } = require('./conversation-state');

const TZ = { timezone: 'Europe/London' };
const REPEAT_DAYS = 3;
const TIP_DAYS = 7;

function buildBriefingHash(dueToday, overdue, staleQuotes) {
  const parts = [
    ...dueToday.map(i => `dt:${i.id}`),
    ...overdue.map(i => `ov:${i.id}`),
    ...staleQuotes.map(j => `sq:${j.id}`),
  ].sort();
  return parts.join('|');
}

function getProfileTip(business) {
  if (!business.logo_path) return `Tip: upload a logo to make your quotes and invoices look more professional — say *settings*.`;
  if (!business.payment_details) return `Tip: add your payment details so customers know how to pay you — say *settings*.`;
  if (!business.payment_days) return `Tip: set your payment terms (e.g. 14 days) so invoices show when payment is due — say *settings*.`;
  if (!business.trade) return `Tip: add your trade (e.g. Plumber, Electrician) so it appears on your quotes and invoices — say *settings*.`;
  if (!business.address) return `Tip: add your business address so it appears on your quotes and invoices — say *settings*.`;
  if (!business.email) return `Tip: add your email address so it appears on your documents — say *settings*.`;
  return null;
}

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

          // Suppress if content hasn't changed and last send was within REPEAT_DAYS
          const hash = buildBriefingHash(dueToday, overdue, staleQuotes);
          const meta = await db.getBriefingMeta(business.id);
          const lastSentAt = meta?.last_briefing_at ? new Date(meta.last_briefing_at) : null;
          const daysSinceLastSend = lastSentAt ? (Date.now() - lastSentAt.getTime()) / 86400000 : Infinity;
          if (meta?.last_briefing_hash === hash && daysSinceLastSend < REPEAT_DAYS) continue;

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
              let ageStr;
              if (days >= 21) ageStr = `${days} days — going cold`;
              else if (days >= 14) ageStr = `2 weeks — worth a nudge?`;
              else if (days >= 7) ageStr = `1 week, no reply`;
              else ageStr = `${days} days`;
              lines.push(`${n}. ${job.customer_name} — ${desc}${amount} (${ageStr})`);
              items.push({ n, type: 'stale_quote', jobId: job.id, customerName: job.customer_name });
              n++;
            }
          }

          lines.push('', 'Let me know if any of these have paid or if you need me to draft a chaser.');

          const lastTipAt = meta?.last_tip_at ? new Date(meta.last_tip_at) : null;
          const daysSinceLastTip = lastTipAt ? (Date.now() - lastTipAt.getTime()) / 86400000 : Infinity;
          const profileTip = daysSinceLastTip >= TIP_DAYS ? getProfileTip(business) : null;
          if (profileTip) lines.push('', `💡 ${profileTip}`);

          await messenger.sendToForeman(lines.join('\n'), { businessId: business.id, businessPhone: business.phone });
          await db.setBriefingMeta(business.id, hash, !!profileTip);

          const activeState = await getConversationState(business.id);
          const activeFlows = ['quote_flow', 'invoice_flow', 'vat_gate', 'bank_gate', 'settings'];
          if (!activeState || !activeFlows.includes(activeState.workflow)) {
            await setConversationState(business.id, {
              workflow: 'morning_briefing',
              focus: {},
              collected: { items },
              pending: { type: 'selection', field: 'action' },
              options: [],
            });
          }
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
