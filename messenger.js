const twilio = require('twilio');
const config = require('./config');
const { logMessage } = require('./db');

const client = twilio(config.twilio.accountSid, config.twilio.authToken);
const from = `whatsapp:${config.twilio.whatsappNumber}`;

/**
 * Send a WhatsApp message to any number.
 * Returns the Twilio message SID.
 */
async function send(to, body, { customerId, jobId } = {}) {
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  try {
    const msg = await client.messages.create({
      from,
      to: toFormatted,
      body,
    });
    const participant = to === config.foremanPhone ? 'TRADESPERSON' : 'CUSTOMER';
    logMessage('OUT', participant, body, { customerId, jobId, whatsappMessageId: msg.sid });
    return msg.sid;
  } catch (err) {
    console.error(`Failed to send message to ${to}:`, err.message);
    throw err;
  }
}

/**
 * Send a message to the tradesperson.
 */
async function sendToForeman(body, { jobId } = {}) {
  return send(config.foremanPhone, body, { jobId });
}

/**
 * Send a message to a customer.
 */
async function sendToCustomer(phone, body, { customerId, jobId } = {}) {
  return send(phone, body, { customerId, jobId });
}

/**
 * Reply to the tradesperson using Twilio's TwiML response (synchronous webhook reply).
 */
function twimlReply(res, body) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(body);
  res.type('text/xml').send(twiml.toString());
}

module.exports = {
  send,
  sendToForeman,
  sendToCustomer,
  twimlReply,
};
