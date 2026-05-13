function normalisePhone(phone) {
  if (!phone) return null;
  let p = String(phone).trim()
    .replace(/^whatsapp:/i, '')
    .replace(/[\s().\-]/g, '');
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  else if (p.startsWith('0')) p = `+44${p.slice(1)}`;
  else if (p.startsWith('44') && !p.startsWith('+')) p = `+${p}`;
  return p || null;
}

module.exports = { normalisePhone };
