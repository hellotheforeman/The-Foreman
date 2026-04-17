const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const PDF_DIR = path.join(__dirname, 'public', 'pdfs');

function ensurePdfDir() {
  fs.mkdirSync(PDF_DIR, { recursive: true });
}

function pdfUrl(filename) {
  return `${config.publicUrl}/pdfs/${filename}`;
}

function formatDate(d) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

function drawRule(doc, y, color = '#dddddd') {
  doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(color).lineWidth(0.5).stroke();
}

// Normalise line_items_json: accepts array, JSON string, or null.
// Falls back to a single-item array using description + amount.
function normaliseLineItems(lineItemsJson, fallbackDescription, fallbackAmount) {
  if (lineItemsJson) {
    const parsed = typeof lineItemsJson === 'string' ? JSON.parse(lineItemsJson) : lineItemsJson;
    if (Array.isArray(parsed) && parsed.length) return parsed;
  }
  if (fallbackDescription && fallbackAmount != null) {
    return [{ description: fallbackDescription, amount: Number(fallbackAmount) }];
  }
  return [];
}

function generatePdf({ type, docNumber, date, business, customer, lineItems, paymentDetails, vat }) {
  ensurePdfDir();
  const safeName = (customer?.name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dateStr = new Date().toISOString().split('T')[0];
  const filename = `${type}-${safeName}-${dateStr}.pdf`;
  const filepath = path.join(PDF_DIR, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    const W = doc.page.width;
    const L = 50;
    const R = W - 50;
    const mid = W / 2;

    // ── HEADER ────────────────────────────────────────────────
    let headerTopY = 50;

    // Logo — rendered above business name if present
    const logoPath = business?.logo_path;
    if (logoPath && fs.existsSync(logoPath)) {
      try {
        const MAX_LOGO_HEIGHT = 50;
        const MAX_LOGO_WIDTH = mid - L - 20;
        doc.image(logoPath, L, headerTopY, { fit: [MAX_LOGO_WIDTH, MAX_LOGO_HEIGHT], align: 'left' });
        headerTopY += MAX_LOGO_HEIGHT + 8;
      } catch (e) {
        // Logo render failed — continue without it
      }
    }

    const bizName = business?.name || 'My Trade Business';
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#111111')
      .text(bizName, L, headerTopY, { width: mid - L - 10 });

    let leftY = doc.y;

    if (business?.trade) {
      doc.font('Helvetica').fontSize(10).fillColor('#666666')
        .text(business.trade, L, leftY, { width: mid - L - 10 });
      leftY = doc.y;
    }

    const contactLine = [business?.email, business?.phone].filter(Boolean).join('  ·  ');
    if (contactLine) {
      doc.font('Helvetica').fontSize(9).fillColor('#888888')
        .text(contactLine, L, leftY, { width: mid - L - 10 });
      leftY = doc.y;
    }

    if (business?.address) {
      doc.font('Helvetica').fontSize(9).fillColor('#888888')
        .text(business.address, L, leftY, { width: mid - L - 10 });
      leftY = doc.y;
    }

    if (vat?.number) {
      doc.font('Helvetica').fontSize(9).fillColor('#888888')
        .text(`VAT No: ${vat.number}`, L, leftY, { width: mid - L - 10 });
      leftY = doc.y;
    }

    // Right: document type + number + date
    const docTitle = type === 'quote' ? 'QUOTE' : 'INVOICE';
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#111111')
      .text(docTitle, mid, headerTopY, { width: R - mid, align: 'right' });

    let rightY = doc.y;

    doc.font('Helvetica').fontSize(10).fillColor('#555555')
      .text(`#${String(docNumber).padStart(4, '0')}`, mid, rightY, { width: R - mid, align: 'right' });
    rightY = doc.y;

    doc.font('Helvetica').fontSize(10).fillColor('#555555')
      .text(date, mid, rightY, { width: R - mid, align: 'right' });
    rightY = doc.y;

    const afterHeader = Math.max(leftY, rightY) + 16;
    drawRule(doc, afterHeader);

    // ── BILL TO ────────────────────────────────────────────────
    const billY = afterHeader + 14;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#888888')
      .text('BILL TO', L, billY);

    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111')
      .text(customer.name, L, doc.y + 3);

    const custDetails = [customer.phone, customer.email, customer.address].filter(Boolean);
    for (const detail of custDetails) {
      doc.font('Helvetica').fontSize(9).fillColor('#666666').text(detail);
    }

    // ── TABLE ──────────────────────────────────────────────────
    const tableTopY = doc.y + 20;
    drawRule(doc, tableTopY);

    const tableHeaderY = tableTopY + 10;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#888888')
      .text('DESCRIPTION', L, tableHeaderY)
      .text('AMOUNT', L, tableHeaderY, { width: R - L, align: 'right' });

    const tableBodyY = tableHeaderY + 18;
    drawRule(doc, tableBodyY, '#eeeeee');

    const descWidth = R - L - 120;
    let currentY = tableBodyY + 10;

    for (let idx = 0; idx < lineItems.length; idx++) {
      const item = lineItems[idx];
      const rowStartY = currentY;

      doc.font('Helvetica').fontSize(10).fillColor('#111111')
        .text(String(item.description), L, rowStartY, { width: descWidth });
      const afterDesc = doc.y;

      doc.font('Helvetica').fontSize(10).fillColor('#111111')
        .text(`£${Number(item.amount).toFixed(2)}`, L, rowStartY, { width: R - L, align: 'right' });

      currentY = Math.max(afterDesc, doc.y) + 10;

      if (idx < lineItems.length - 1) {
        drawRule(doc, currentY, '#eeeeee');
        currentY += 8;
      }
    }

    // ── TOTAL ──────────────────────────────────────────────────
    const subtotal = lineItems.reduce((sum, i) => sum + Number(i.amount), 0);
    const totalTopY = currentY + 6;
    drawRule(doc, totalTopY);

    if (vat) {
      const vatAmount = subtotal * vat.rate;
      const grandTotal = subtotal + vatAmount;
      let ty = totalTopY + 10;

      doc.font('Helvetica').fontSize(10).fillColor('#555555')
        .text('SUBTOTAL', L, ty)
        .text(`£${subtotal.toFixed(2)}`, L, ty, { width: R - L, align: 'right' });
      ty += 20;

      doc.font('Helvetica').fontSize(10).fillColor('#555555')
        .text(`VAT (${Math.round(vat.rate * 100)}%)`, L, ty)
        .text(`£${vatAmount.toFixed(2)}`, L, ty, { width: R - L, align: 'right' });
      ty += 8;

      drawRule(doc, ty);
      ty += 10;

      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111')
        .text('TOTAL', L, ty)
        .text(`£${grandTotal.toFixed(2)}`, L, ty, { width: R - L, align: 'right' });
    } else {
      const totalY = totalTopY + 10;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111')
        .text('TOTAL', L, totalY)
        .text(`£${subtotal.toFixed(2)}`, L, totalY, { width: R - L, align: 'right' });
    }

    // ── PAYMENT / NOTE ─────────────────────────────────────────
    doc.moveDown(3);
    if (paymentDetails) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#888888')
        .text('PAYMENT DETAILS');
      doc.font('Helvetica').fontSize(10).fillColor('#111111')
        .text(paymentDetails, { paragraphGap: 0 });
      doc.font('Helvetica').fontSize(9).fillColor('#888888')
        .text('Please pay within 14 days. Thank you for your business.', { paragraphGap: 6 });
    } else {
      doc.font('Helvetica').fontSize(9).fillColor('#888888')
        .text('This quote is valid for 30 days. Reply YES to accept or let us know if you have any questions.');
    }

    // ── FOOTER ─────────────────────────────────────────────────
    doc.moveDown(2);
    doc.font('Helvetica').fontSize(8).fillColor('#cccccc')
      .text('Generated by The Foreman', { align: 'center' });

    doc.end();
    stream.on('finish', () => resolve(filename));
    stream.on('error', reject);
  });
}

async function generateQuotePdf(job, customer, business) {
  const lineItems = normaliseLineItems(
    job.quote_line_items_json,
    job.quote_items || job.description,
    job.quoted_amount
  );
  const vat = business?.vat_registered ? { rate: 0.20, number: business.vat_number || null } : null;
  return generatePdf({
    type: 'quote',
    docNumber: job.id,
    date: formatDate(new Date()),
    business,
    customer,
    lineItems,
    paymentDetails: null,
    vat,
  });
}

async function generateInvoicePdf(job, invoice, customer, business) {
  const paymentDetails = business?.payment_details || config.paymentDetails;
  const lineItems = normaliseLineItems(
    invoice.line_items_json,
    invoice.line_items || job.description,
    invoice.amount
  );
  const vat = business?.vat_registered ? { rate: 0.20, number: business.vat_number || null } : null;
  return generatePdf({
    type: 'invoice',
    docNumber: invoice.id,
    date: formatDate(new Date(invoice.created_at || Date.now())),
    business,
    customer,
    lineItems,
    paymentDetails,
    vat,
  });
}

module.exports = { generateQuotePdf, generateInvoicePdf, pdfUrl };
