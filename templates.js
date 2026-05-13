const config = require('./config');

function formatJobId(id) {
  return `#${String(id).padStart(4, '0')}`;
}

function businessName(business) {
  return business?.business_name || business?.name || config.businessName;
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

function capitaliseItems(str) {
  if (!str) return str;
  return str.split(',').map(s => s.trimStart().charAt(0).toUpperCase() + s.trimStart().slice(1)).join(', ');
}

function quoteMessage(job, customer, business) {
  const items = capitaliseItems(job.quote_items || job.description);
  const name = businessName(business);
  const net = Number(job.quoted_amount);
  const vatLines = business?.vat_registered
    ? [`Subtotal: £${net.toFixed(2)}`, `VAT (20%): £${(net * 0.20).toFixed(2)}`, `💰 *Total: £${(net * 1.20).toFixed(2)}*`]
    : [`💰 *Total: £${net.toFixed(2)}*`];
  const scopeSection = job.description && job.quote_items
    ? ['*Scope of work*', job.description, '']
    : [];
  return [
    `Hi ${customerGreetingName(customer)}! 👋`,
    '',
    `Thanks for your enquiry. Here's your quote from ${name}:`,
    '',
    `📋 *Quote ${formatJobId(job.id)}*`,
    '',
    ...scopeSection,
    items,
    '',
    ...vatLines,
    '',
    'This quote is valid for 30 days.',
    '',
    'Work subject to standard terms and conditions available on request.',
    '',
    `— ${name}`,
  ].join('\n');
}

function invoiceMessage(job, invoice, customer, business) {
  const items = capitaliseItems(invoice.line_items || job.description);
  const name = businessName(business);
  const payment = paymentDetails(business);
  const net = Number(invoice.amount);
  const vatLines = business?.vat_registered
    ? [`Subtotal: £${net.toFixed(2)}`, `VAT (20%): £${(net * 0.20).toFixed(2)}`, `💰 *Total: £${(net * 1.20).toFixed(2)}*`]
    : [`💰 *Total: £${net.toFixed(2)}*`];
  return [
    `Hi ${customerGreetingName(customer)},`,
    '',
    `Here's your invoice from ${name}:`,
    '',
    `🧾 *Invoice ${formatJobId(job.id)}*`,
    items,
    '',
    ...vatLines,
    '',
    `💳 *Payment details:*`,
    payment,
    '',
    `Please pay within ${business?.payment_days || 14} days. Thanks for choosing ${name}!`,
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

function reviewRequestMessage(job, customer, business) {
  const name = businessName(business);
  return [
    `Hi ${customerGreetingName(customer)}! 😊`,
    '',
    `Thank you for choosing ${name} for your ${job.description.toLowerCase()} — it was great working with you.`,
    '',
    `If you were happy with the work, we'd really appreciate a quick Google review. It only takes a minute and means a lot to a small business like ours. 🙏`,
    '',
    `Thanks again!`,
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

function toTitleCase(str) {
  return (str || '').replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

module.exports = {
  quoteMessage,
  invoiceMessage,
  paymentReminder,
  reviewRequestMessage,
  formatDate,
};
