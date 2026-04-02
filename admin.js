const express = require('express');
const config = require('./config');
const db = require('./db');

const router = express.Router();

function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (!config.adminSecret || secret !== config.adminSecret) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  next();
}

// GET /admin/businesses
router.get('/admin/businesses', requireAdmin, async (req, res) => {
  const businesses = await db.getAll('SELECT * FROM businesses ORDER BY created_at DESC');
  res.json(businesses);
});

// GET /admin/businesses/:id
router.get('/admin/businesses/:id', requireAdmin, async (req, res) => {
  const business = await db.getBusiness(parseInt(req.params.id, 10));
  if (!business) return res.status(404).json({ error: 'Not found' });
  res.json(business);
});

// POST /admin/businesses/:id/activate
router.post('/admin/businesses/:id/activate', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const business = await db.getBusiness(id);
  if (!business) return res.status(404).json({ error: 'Not found' });

  await db.updateBusinessStatus(id, 'active');
  console.log(`✅ Business #${id} (${business.business_name}) activated`);
  res.json({ ok: true, status: 'active' });
});

// POST /admin/businesses/:id/suspend
router.post('/admin/businesses/:id/suspend', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const business = await db.getBusiness(id);
  if (!business) return res.status(404).json({ error: 'Not found' });

  await db.updateBusinessStatus(id, 'suspended');
  console.log(`🚫 Business #${id} (${business.business_name}) suspended`);
  res.json({ ok: true, status: 'suspended' });
});

module.exports = router;
