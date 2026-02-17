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

    // POST /invoices/:id/generate-pdf (marquer comme PDF généré)
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
                 c.nif as customer_nif, c.nis as customer_nis, c.ai as customer_ai,
                 u.company_name as my_company, u.rc_number, u.nif, u.nis, u.ai, u.phone, u.email
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
      y -= 30;

      // Informations
      page.drawText('Émetteur :', { x: margin, y, size: 10, font: fontBold });
      y -= 15;
      page.drawText(invoice.my_company || '', { x: margin, y, size: 10, font: fontRegular });
      y -= 12;
      page.drawText(`RC: ${invoice.rc_number || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`NIF: ${invoice.nif || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`NIS: ${invoice.nis || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`AI: ${invoice.ai || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`Tél: ${invoice.phone || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`Email: ${invoice.email || ''}`, { x: margin, y, size: 9, font: fontRegular });

      // Client (à droite)
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
      if (invoice.customer_nif) {
        page.drawText(`NIF: ${invoice.customer_nif}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }
      if (invoice.customer_nis) {
        page.drawText(`NIS: ${invoice.customer_nis}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }
      if (invoice.customer_ai) {
        page.drawText(`AI: ${invoice.customer_ai}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }

      y = Math.min(y, yRight) - 20;

      page.drawText(`Date d'émission : ${invoice.issue_date}`, { x: margin, y, size: 10, font: fontRegular });
      page.drawText(`Date d'échéance : ${invoice.due_date}`, { x: colRight, y, size: 10, font: fontRegular });
      y -= 25;

      // Tableau
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

      // Totaux
      let subtotal = 0, taxTotal = 0;
      for (const item of items.results) {
        const net = item.quantity * item.unit_price;
        subtotal += net;
        taxTotal += net * (item.tax_rate / 100);
      }
      page.drawText(`Total HT: ${subtotal.toFixed(2)} DZD`, { x: colTotal - 120, y, size: 10, font: fontBold });
      y -= 15;
      page.drawText(`Total TVA: ${taxTotal.toFixed(2)} DZD`, { x: colTotal - 120, y, size: 10, font: fontBold });
      y -= 15;
      page.drawText(`Total TTC: ${invoice.total.toFixed(2)} DZD`, { x: colTotal - 120, y, size: 12, font: fontBold });

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
