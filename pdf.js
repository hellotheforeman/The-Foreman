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

function generatePdf({ type, docNumber, date, business, customer, description, amount, paymentDetails }) {
  ensurePdfDir();
  const filename = `${type}-${docNumber}.pdf`;
  const filepath = path.join(PDF_DIR, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    const W = doc.page.width;
    const L = 50;   // left margin
    const R = W - 50; // right edge
    const mid = W / 2;

    // ── HEADER ────────────────────────────────────────────────
    const headerTopY = 50;

    // Left: business name
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

    // Move below whichever column is taller
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

    // Description (left, leaving room for amount column)
    const descWidth = R - L - 100;
    doc.font('Helvetica').fontSize(10).fillColor('#111111')
      .text(description, L, tableBodyY + 10, { width: descWidth });

    const descBottom = doc.y;

    // Amount (right-aligned, same row)
    doc.font('Helvetica').fontSize(10).fillColor('#111111')
      .text(`£${Number(amount).toFixed(2)}`, L, tableBodyY + 10, { width: R - L, align: 'right' });

    // ── TOTAL ──────────────────────────────────────────────────
    const totalTopY = Math.max(descBottom, doc.y) + 12;
    drawRule(doc, totalTopY);

    const totalY = totalTopY + 10;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111')
      .text('TOTAL', L, totalY)
      .text(`£${Number(amount).toFixed(2)}`, L, totalY, { width: R - L, align: 'right' });

    // ── PAYMENT / NOTE ─────────────────────────────────────────
    const noteY = doc.y + 24;
    if (paymentDetails) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#888888')
        .text('PAYMENT DETAILS', L, noteY);
      doc.font('Helvetica').fontSize(10).fillColor('#111111')
        .text(paymentDetails, L, doc.y + 3);
      doc.font('Helvetica').fontSize(9).fillColor('#888888')
        .text('Please pay within 14 days. Thank you for your business.', L, doc.y + 10);
    } else {
      doc.font('Helvetica').fontSize(9).fillColor('#888888')
        .text('This quote is valid for 30 days. Reply YES to accept or let us know if you have any questions.', L, noteY);
    }

    // ── FOOTER ─────────────────────────────────────────────────
    doc.moveDown(3);
    doc.font('Helvetica').fontSize(8).fillColor('#cccccc')
      .text('Generated by The Foreman', { align: 'center' });

    doc.end();
    stream.on('finish', () => resolve(filename));
    stream.on('error', reject);
  });
}

async function generateQuotePdf(job, customer, business) {
  return generatePdf({
    type: 'quote',
    docNumber: job.id,
    date: formatDate(new Date()),
    business,
    customer,
    description: job.quote_items || job.description,
    amount: job.quoted_amount,
    paymentDetails: null,
  });
}

async function generateInvoicePdf(job, invoice, customer, business) {
  const paymentDetails = business?.payment_details || config.paymentDetails;
  return generatePdf({
    type: 'invoice',
    docNumber: invoice.id,
    date: formatDate(new Date(invoice.created_at || Date.now())),
    business,
    customer,
    description: invoice.line_items || job.description,
    amount: invoice.amount,
    paymentDetails,
  });
}

module.exports = { generateQuotePdf, generateInvoicePdf, pdfUrl };
