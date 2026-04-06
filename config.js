require('dotenv').config();

const config = {
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    whatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER,
  },
  businessName: process.env.BUSINESS_NAME || 'My Trade Business',
  paymentDetails: process.env.BUSINESS_PAYMENT_DETAILS || 'Please contact us for payment details.',
  port: parseInt(process.env.PORT, 10) || 3000,
  signupUrl: process.env.SIGNUP_URL || '',
  adminSecret: process.env.ADMIN_SECRET || '',
};

// Validate required config
const required = ['twilio.accountSid', 'twilio.authToken', 'twilio.whatsappNumber'];
for (const key of required) {
  const val = key.split('.').reduce((o, k) => o?.[k], config);
  if (!val || val.includes('XXXX')) {
    console.warn(`⚠️  Missing or placeholder config: ${key} — check your .env file`);
  }
}

module.exports = config;
