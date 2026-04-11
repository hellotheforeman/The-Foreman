const twilio = require('twilio');
const config = require('./config');
const { logMessage } = require('./db');

const client = twilio(config.twilio.accountSid, config.twilio.authToken);
const from = `whatsapp:${config.twilio.whatsappNumber}`;

/**
 * Send a WhatsApp message to a tradesperson.
 * Used for proactive messages (reminders, alerts) from the scheduler.
 */
async function sendToForeman(body, { jobId, businessId, businessPhone } = {}) {
  const phone = businessPhone || config.foremanPhone;
  const to = `whatsapp:${phone}`;
  try {
    const msg = await client.messages.create({ from, to, body });
    await logMessage('OUT', 'TRADESPERSON', body, {
      businessId: businessId || null,
      jobId,
      whatsappMessageId: msg.sid,
    });
    return msg.sid;
  } catch (err) {
    console.error(`Failed to send message to foreman (${phone}):`, err.message);
    throw err;
  }
}

/**
 * Reply to the tradesperson synchronously via TwiML (webhook response).
 * This is the primary way the bot responds to commands.
 */
function twimlReply(res, body) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(body);
  res.type('text/xml').send(twiml.toString());
}

function twimlReplyWithMedia(res, body, mediaUrl) {
  const twiml = new twilio.twiml.MessagingResponse();
  const msg = twiml.message();
  msg.body(body);
  msg.media(mediaUrl);
  res.type('text/xml').send(twiml.toString());
}

module.exports = {
  sendToForeman,
  twimlReply,
  twimlReplyWithMedia,
};
