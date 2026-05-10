const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const config = require('./config');

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);

async function uploadLogo(businessId, buffer, ext) {
  const filePath = `${businessId}/logo.${ext}`;
  const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
  const { error } = await supabase.storage
    .from('logos')
    .upload(filePath, buffer, { contentType, upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from('logos').getPublicUrl(filePath);
  return data.publicUrl;
}

async function uploadPdf(businessId, type, filename, buffer) {
  const filePath = `${businessId}/${type}s/${filename}`;
  const { error } = await supabase.storage
    .from('pdfs')
    .upload(filePath, buffer, { contentType: 'application/pdf', upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from('pdfs').getPublicUrl(filePath);
  return data.publicUrl;
}

// Fetches a logo from its public URL and returns a Buffer for pdfkit to render.
function downloadLogoBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadLogoBuffer(response.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = { uploadLogo, uploadPdf, downloadLogoBuffer };
