const config = require('./config');
const { formatJobId } = require('./db');

function businessName(business) {
  return business?.business_name || config.businessName;
}

function paymentDetails(business) {
  return business?.payment_details || config.paymentDetails;
}

function quoteMessage(job, customer, business) {
  const items = job.quote_items || job.description;
  const name = businessName(business);
  return [
    `Hi ${customer.name.split(' ')[0]}! 👋`,
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
  const name = businessName(business);
  return [
    `Hi ${customer.name.split(' ')[0]}! ✅`,
    '',
    `Your job is confirmed:`,
    '',
    `📅 *${date} at ${time}*`,
    `🔧 ${job.description}${postcode}`,
    '',
    `We'll see you then! If you need to reschedule, just reply to this message.`,
    '',
    `— ${name}`,
  ].join('\n');
}

function invoiceMessage(job, invoice, customer, business) {
  const items = invoice.line_items || job.description;
  const name = businessName(business);
  const payment = paymentDetails(business);
  return [
    `Hi ${customer.name.split(' ')[0]},`,
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
    `Hi ${customer.name.split(' ')[0]},`,
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
    `Hi ${customer.name.split(' ')[0]}! 👋`,
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
    return `• ${time} — ${j.customer_name}, ${j.description}${postcode}`;
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
