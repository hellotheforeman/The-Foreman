require('dotenv').config();

const config = {
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    whatsappNumber: process.env.TWILIO_WHATSAPP_NUMBER,
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
  },
  foremanPhone: process.env.FOREMAN_PHONE,
  adminSecret: process.env.ADMIN_SECRET,
  businessName: process.env.BUSINESS_NAME || 'My Trade Business',
  paymentDetails: process.env.BUSINESS_PAYMENT_DETAILS || 'Please contact us for payment details.',
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  port: parseInt(process.env.PORT, 10) || 3000,
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
