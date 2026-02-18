import { verifyToken } from '../utils/auth';
import { generateNumber } from '../utils/numbers';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export async function handleInvoices(request: Request, db: D1Database): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401 });
  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return new Response('Unauthorized', { status: 401 });

  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const id = pathParts[2];
  const action = pathParts[3];

// GET /invoices/export (export CSV)
if (request.method === 'GET' && pathParts[2] === 'export') {
  const invoices = await db
    .prepare(`
      SELECT i.invoice_number, i.issue_date, i.due_date, i.total, i.paid_amount,
             CASE WHEN i.status = 'paid' THEN i.total ELSE i.paid_amount END as paid_display,
             i.status,
             c.company_name as customer_name
      FROM invoices i
      JOIN customers c ON i.customer_id = c.id
      WHERE i.user_id = ?
      ORDER BY i.created_at DESC
    `)
    .bind(payload.userId)
    .all();

  let csv = 'Numéro;Client;Date émission;Date échéance;Total TTC;Payé;Statut\n';
  for (const inv of invoices.results) {
    csv += `"${inv.invoice_number}";"${inv.customer_name}";"${inv.issue_date}";"${inv.due_date}";${inv.total};${inv.paid_display};"${inv.status}"\n`;
  }

  const bom = "\uFEFF";
  return new Response(bom + csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="factures.csv"',
    },
  });
}

  // GET /invoices (liste)
  if (request.method === 'GET' && !id) {
    const invoices = await db
      .prepare(`
        SELECT i.*, c.company_name as customer_name
        FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        WHERE i.user_id = ?
        ORDER BY i.created_at DESC
      `)
      .bind(payload.userId)
      .all();
    return new Response(JSON.stringify(invoices.results), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /invoices (création)
  if (request.method === 'POST' && !id) {
    const body = await request.json();
    const { customerId, items, issueDate, dueDate, notes } = body;

    let total = 0;
    for (const item of items) {
      total += item.quantity * item.unitPrice * (1 + item.taxRate / 100);
    }

    const invoiceNumber = await generateNumber(db, payload.userId, 'FACT', 'invoices', 'invoice_number');
    const result = await db
      .prepare(
        `INSERT INTO invoices (user_id, invoice_number, customer_id, issue_date, due_date, notes, total, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`
      )
      .bind(payload.userId, invoiceNumber, customerId, issueDate, dueDate, notes, total)
      .run();

    const invoiceId = result.meta.last_row_id;

    for (const item of items) {
      await db
        .prepare(
          `INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price, tax_rate)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(invoiceId, item.productId || null, item.description, item.quantity, item.unitPrice, item.taxRate)
        .run();
    }

    return new Response(JSON.stringify({ id: invoiceId }), { status: 201 });
  }

  // Routes avec ID
  if (id) {
    // GET /invoices/:id (détail)
    if (request.method === 'GET' && !action) {
      const invoice = await db
        .prepare(`
          SELECT i.*, c.company_name as customer_name
          FROM invoices i
          JOIN customers c ON i.customer_id = c.id
          WHERE i.id = ? AND i.user_id = ?
        `)
        .bind(id, payload.userId)
        .first();
      if (!invoice) return new Response('Not Found', { status: 404 });

      const items = await db
        .prepare('SELECT * FROM invoice_items WHERE invoice_id = ?')
        .bind(id)
        .all();

      return new Response(JSON.stringify({ ...invoice, items: items.results }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // PATCH /invoices/:id/status
    if (request.method === 'PATCH' && action === 'status') {
      const body = await request.json();
      const { status } = body;
      await db
        .prepare('UPDATE invoices SET status = ? WHERE id = ? AND user_id = ?')
        .bind(status, id, payload.userId)
        .run();
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }

    // POST /invoices/:id/generate-pdf
    if (request.method === 'POST' && action === 'generate-pdf') {
      await db.prepare('UPDATE invoices SET has_pdf = 1 WHERE id = ? AND user_id = ?').bind(id, payload.userId).run();
      return new Response(JSON.stringify({ pdf_url: `/invoices/${id}/pdf` }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /invoices/:id/pdf (télécharger le PDF réel)
    if (request.method === 'GET' && action === 'pdf') {
      // Récupérer toutes les données nécessaires
      const invoice = await db
        .prepare(`
          SELECT i.*, 
                 c.company_name as customer_company, c.contact_name, 
                 c.address, c.city, c.rc_number as customer_rc, 
                 c.ai as customer_ai,
                 u.company_name as my_company, u.rc_number, u.ai, u.phone, u.email
          FROM invoices i
          JOIN customers c ON i.customer_id = c.id
          JOIN users u ON i.user_id = u.id
          WHERE i.id = ? AND i.user_id = ?
        `)
        .bind(id, payload.userId)
        .first();

      if (!invoice) return new Response('Not Found', { status: 404 });

      const items = await db
        .prepare('SELECT * FROM invoice_items WHERE invoice_id = ?')
        .bind(id)
        .all();

      // Création du PDF
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595.28, 841.89]); // A4
      const { width, height } = page.getSize();
      const margin = 50;
      let y = height - margin;

      const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      // En-tête
      page.drawText('FACTURE', { x: margin, y, size: 24, font: fontBold });
      page.drawText(`N° ${invoice.invoice_number}`, { x: width - margin - 100, y, size: 14, font: fontBold });
      y -= 35;

      // Informations de l'émetteur
      page.drawText('Émetteur :', { x: margin, y, size: 10, font: fontBold });
      y -= 15;
      page.drawText(invoice.my_company || '', { x: margin, y, size: 10, font: fontRegular });
      y -= 12;
      page.drawText(`RC: ${invoice.rc_number || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`MT: ${invoice.ai || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`Tél: ${invoice.phone || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`Email: ${invoice.email || ''}`, { x: margin, y, size: 9, font: fontRegular });

      // Informations du client (à droite)
      const colRight = width / 2 + 20;
      let yRight = height - margin - 45;
      page.drawText('Client :', { x: colRight, y: yRight, size: 10, font: fontBold });
      yRight -= 15;
      page.drawText(invoice.customer_company || invoice.contact_name, { x: colRight, y: yRight, size: 10, font: fontRegular });
      yRight -= 12;
      if (invoice.address || invoice.city) {
        page.drawText(`${invoice.address || ''} ${invoice.city || ''}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }
      if (invoice.customer_rc) {
        page.drawText(`RC: ${invoice.customer_rc}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }
      if (invoice.customer_ai) {
        page.drawText(`MT: ${invoice.customer_ai}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }

      y = Math.min(y, yRight) - 20;

      // Dates
      page.drawText(`Date d'émission : ${invoice.issue_date}`, { x: margin, y, size: 10, font: fontRegular });
      page.drawText(`Date d'échéance : ${invoice.due_date}`, { x: colRight, y, size: 10, font: fontRegular });
      y -= 35;

      // Tableau des articles
      const colDesc = margin;
      const colQty = 300;
      const colPrice = 370;
      const colTax = 430;
      const colTotal = 490;
      const rowHeight = 15;

      page.drawText('Description', { x: colDesc, y, size: 10, font: fontBold });
      page.drawText('Qté', { x: colQty, y, size: 10, font: fontBold });
      page.drawText('P.U HT', { x: colPrice, y, size: 10, font: fontBold });
      page.drawText('TVA %', { x: colTax, y, size: 10, font: fontBold });
      page.drawText('Total', { x: colTotal, y, size: 10, font: fontBold });
      y -= rowHeight;

      for (const item of items.results) {
        page.drawText(item.description.substring(0, 30), { x: colDesc, y, size: 9, font: fontRegular });
        page.drawText(item.quantity.toString(), { x: colQty, y, size: 9, font: fontRegular });
        page.drawText(item.unit_price.toFixed(2), { x: colPrice, y, size: 9, font: fontRegular });
        page.drawText(item.tax_rate.toString(), { x: colTax, y, size: 9, font: fontRegular });
        const totalLine = item.quantity * item.unit_price * (1 + item.tax_rate / 100);
        page.drawText(totalLine.toFixed(2), { x: colTotal, y, size: 9, font: fontRegular });
        y -= rowHeight;
      }

      y -= 10;

      // Calcul des totaux
      let subtotal = 0, taxTotal = 0;
      for (const item of items.results) {
        const net = item.quantity * item.unit_price;
        subtotal += net;
        taxTotal += net * (item.tax_rate / 100);
      }

      page.drawText(`Total HT: ${subtotal.toFixed(2)} TND`, { x: colTotal - 120, y, size: 10, font: fontBold });
      y -= 15;
      page.drawText(`Total TVA: ${taxTotal.toFixed(2)} TND`, { x: colTotal - 120, y, size: 10, font: fontBold });
      y -= 15;
      page.drawText(`Total TTC: ${invoice.total.toFixed(2)} TND`, { x: colTotal - 120, y, size: 12, font: fontBold });

      // 🔹 Ajout du timbre fiscal (1 TND si total TTC >= 10)
      const timbre = invoice.total >= 10 ? 1 : 0;
      if (timbre > 0) {
        y -= 20;
        page.drawText(`Timbre fiscal: ${timbre.toFixed(2)} TND`, { x: colTotal - 120, y, size: 10, font: fontBold });
        y -= 15;
        page.drawText(`Total à payer: ${(invoice.total + timbre).toFixed(2)} TND`, { x: colTotal - 120, y, size: 12, font: fontBold });
      }

      // Notes
      if (invoice.notes) {
        y -= 25;
        page.drawText('Notes :', { x: margin, y, size: 10, font: fontBold });
        y -= 15;
        page.drawText(invoice.notes, { x: margin, y, size: 9, font: fontRegular });
      }

      const pdfBytes = await pdfDoc.save();
      return new Response(pdfBytes, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="facture-${invoice.invoice_number}.pdf"`,
        },
      });
    }
  }

  return new Response('Not Found', { status: 404 });
}



