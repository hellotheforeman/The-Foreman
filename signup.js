const express = require('express');
const path = require('path');
const db = require('./db');

const router = express.Router();

function normalisePhone(phone) {
  let p = (phone || '').replace(/\s+/g, '');
  if (p.startsWith('0')) p = '+44' + p.slice(1);
  else if (p.startsWith('44') && !p.startsWith('+')) p = '+' + p;
  return p;
}

// GET /signup
router.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

// GET /signup/thanks
router.get('/signup/thanks', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup-thanks.html'));
});

// POST /signup
router.post('/signup', async (req, res) => {
  const { business_name, contact_name, phone, email } = req.body;

  if (!business_name || !contact_name || !phone) {
    return res.status(400).send('Missing required fields.');
  }

  const normalisedPhone = normalisePhone(phone);

  try {
    await db.createBusiness({
      business_name: business_name.trim(),
      contact_name: contact_name.trim(),
      phone: normalisedPhone,
      email: (email || '').trim() || null,
    });
    console.log(`📋 New signup: ${business_name} (${normalisedPhone})`);
    return res.redirect('/signup/thanks');
  } catch (err) {
    if (err.message && err.message.includes('unique')) {
      return res.status(409).send('That phone number is already registered.');
    }
    console.error('Signup error:', err);
    return res.status(500).send('Something went wrong. Please try again.');
  }
});

module.exports = router;
