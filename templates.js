const config = require('./config');
const { formatJobId } = require('./db');

function businessName(business) {
  return business?.business_name || config.businessName;
}

function paymentDetails(business) {
  return business?.payment_details || config.paymentDetails;
}

function customerGreetingName(customer) {
  const full = (customer?.name || '').trim();
  if (!full) return 'there';
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  if (['mr', 'mrs', 'ms', 'miss', 'dr'].includes(parts[0].toLowerCase().replace('.', ''))) {
    return parts.slice(0, 2).join(' ');
  }
  return parts[0];
}

function quoteMessage(job, customer, business) {
  const items = job.quote_items || job.description;
  const name = businessName(business);
  return [
    `Hi ${customerGreetingName(customer)}! 👋`,
    '',
    `Thanks for your enquiry. Here's your quote from ${name}:`,
    '',
    `📋 *Quote ${formatJobId(job.id)}*`,
    items,
    '',
    `💰 *Total: £${Number(job.quoted_amount).toFixed(2)}*`,
    '',
    'This quote is valid for 30 days.',
    '',
    'Reply *YES* to accept, or let us know if you have any questions.',
    '',
    `— ${name}`,
  ].join('\n');
}

function scheduleConfirmation(job, customer, business) {
  const date = formatDate(job.scheduled_date);
  const time = job.scheduled_time || 'TBC';
  const postcode = job.postcode ? ` (${job.postcode})` : '';
  const address = job.address ? `📍 ${job.address}${postcode}` : null;
  const name = businessName(business);
  return [
    `Hi ${customerGreetingName(customer)}! ✅`,
    '',
    `Your job is confirmed:`,
    '',
    `📅 *${date} at ${time}*`,
    `🔧 ${job.description}`,
    address,
    '',
    `We'll see you then! If you need to reschedule, just reply to this message.`,
    '',
    `— ${name}`,
  ].filter(Boolean).join('\n');
}

function invoiceMessage(job, invoice, customer, business) {
  const items = invoice.line_items || job.description;
  const name = businessName(business);
  const payment = paymentDetails(business);
  return [
    `Hi ${customerGreetingName(customer)},`,
    '',
    `Here's your invoice from ${name}:`,
    '',
    `🧾 *Invoice ${formatJobId(job.id)}*`,
    items,
    '',
    `💰 *Total: £${Number(invoice.amount).toFixed(2)}*`,
    '',
    `💳 *Payment details:*`,
    payment,
    '',
    `Please pay within 14 days. Thanks for choosing ${name}!`,
    '',
    `— ${name}`,
  ].join('\n');
}

function paymentReminder(job, invoice, customer, business) {
  const daysSent = Math.floor((Date.now() - new Date(invoice.sent_at).getTime()) / 86400000);
  const name = businessName(business);
  const payment = paymentDetails(business);
  return [
    `Hi ${customerGreetingName(customer)},`,
    '',
    `Friendly reminder — invoice ${formatJobId(job.id)} for £${Number(invoice.amount).toFixed(2)} was sent ${daysSent} days ago and is still outstanding.`,
    '',
    `💳 *Payment details:*`,
    payment,
    '',
    `If you've already paid, please ignore this. Any questions, just reply!`,
    '',
    `— ${name}`,
  ].join('\n');
}

function followUpMessage(job, customer, business) {
  const name = businessName(business);
  return [
    `Hi ${customerGreetingName(customer)}! 👋`,
    '',
    `Hope everything's going well since we did your ${job.description.toLowerCase()}.`,
    '',
    `If you were happy with the work, a quick Google review would really help us out. 🙏`,
    '',
    `Thanks again for choosing ${name}!`,
    '',
    `— ${name}`,
  ].join('\n');
}

function formatDate(dateStr) {
  if (!dateStr) return 'TBC';
  const d = new Date(dateStr + 'T00:00:00');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}`;
}

function formatScheduleDay(jobs, dateStr) {
  if (!jobs.length) return 'Nothing scheduled.';
  const lines = jobs.map((j) => {
    const time = j.scheduled_time || 'TBC';
    const postcode = j.postcode ? `, ${j.postcode}` : '';
    const address = j.address ? `, ${j.address}` : '';
    return `• ${time} — ${j.customer_name}, ${j.description}${address}${postcode}`;
  });
  return `📅 *${formatDate(dateStr)}*\n${lines.join('\n')}`;
}

module.exports = {
  quoteMessage,
  scheduleConfirmation,
  invoiceMessage,
  paymentReminder,
  followUpMessage,
  formatDate,
  formatScheduleDay,
};
