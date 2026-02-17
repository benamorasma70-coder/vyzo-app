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
      let page = pdfDoc.addPage([595, 842]); // A4
      const { width, height } = page.getSize();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      let y = height - 50;

      // En-tête
      page.drawText('FACTURE', { x: 50, y, size: 20, font: boldFont });
      y -= 30;

      // Informations de l'entreprise
      page.drawText(`${invoice.my_company || ''}`, { x: 50, y, size: 12, font: boldFont });
      y -= 15;
      page.drawText(`RC: ${invoice.rc_number || ''}`, { x: 50, y, size: 10, font });
      y -= 12;
      page.drawText(`NIF: ${invoice.nif || ''}`, { x: 50, y, size: 10, font });
      y -= 12;
      page.drawText(`NIS: ${invoice.nis || ''}`, { x: 50, y, size: 10, font });
      y -= 12;
      page.drawText(`AI: ${invoice.ai || ''}`, { x: 50, y, size: 10, font });
      y -= 12;
      page.drawText(`Tél: ${invoice.phone || ''}`, { x: 50, y, size: 10, font });
      y -= 12;
      page.drawText(`Email: ${invoice.email || ''}`, { x: 50, y, size: 10, font });

      // Informations du client (à droite)
      let xRight = width - 300;
      page.drawText('Client:', { x: xRight, y: height - 50, size: 12, font: boldFont });
      page.drawText(`${invoice.customer_company || invoice.contact_name}`, { x: xRight, y: height - 65, size: 10, font });
      if (invoice.address || invoice.city) {
        page.drawText(`${invoice.address || ''} ${invoice.city || ''}`, { x: xRight, y: height - 80, size: 10, font });
      }
      if (invoice.customer_rc) page.drawText(`RC: ${invoice.customer_rc}`, { x: xRight, y: height - 95, size: 10, font });
      if (invoice.customer_nif) page.drawText(`NIF: ${invoice.customer_nif}`, { x: xRight, y: height - 110, size: 10, font });
      if (invoice.customer_nis) page.drawText(`NIS: ${invoice.customer_nis}`, { x: xRight, y: height - 125, size: 10, font });
      if (invoice.customer_ai) page.drawText(`AI: ${invoice.customer_ai}`, { x: xRight, y: height - 140, size: 10, font });

      y = height - 200;

      // Numéro et dates
      page.drawText(`N° Facture: ${invoice.invoice_number}`, { x: 50, y, size: 12, font: boldFont });
      y -= 15;
      page.drawText(`Date d'émission: ${invoice.issue_date}`, { x: 50, y, size: 10, font });
      y -= 15;
      page.drawText(`Date d'échéance: ${invoice.due_date}`, { x: 50, y, size: 10, font });

      y -= 30;

      // Tableau des articles
      const tableTop = y;
      const col1 = 50, col2 = 250, col3 = 350, col4 = 450, col5 = 520;

      page.drawText('Description', { x: col1, y: tableTop, size: 10, font: boldFont });
      page.drawText('Qté', { x: col2, y: tableTop, size: 10, font: boldFont });
      page.drawText('P.U HT', { x: col3, y: tableTop, size: 10, font: boldFont });
      page.drawText('TVA %', { x: col4, y: tableTop, size: 10, font: boldFont });
      page.drawText('Total', { x: col5, y: tableTop, size: 10, font: boldFont });

      y = tableTop - 15;

      for (const item of items.results) {
        if (y < 50) {
          page = pdfDoc.addPage([595, 842]);
          y = height - 50;
          page.drawText('Description', { x: col1, y, size: 10, font: boldFont });
          page.drawText('Qté', { x: col2, y, size: 10, font: boldFont });
          page.drawText('P.U HT', { x: col3, y, size: 10, font: boldFont });
          page.drawText('TVA %', { x: col4, y, size: 10, font: boldFont });
          page.drawText('Total', { x: col5, y, size: 10, font: boldFont });
          y -= 15;
        }
        page.drawText(item.description.substring(0, 30), { x: col1, y, size: 9, font });
        page.drawText(item.quantity.toString(), { x: col2, y, size: 9, font });
        page.drawText(item.unit_price.toFixed(2), { x: col3, y, size: 9, font });
        page.drawText(item.tax_rate.toString(), { x: col4, y, size: 9, font });
        const totalLine = item.quantity * item.unit_price * (1 + item.tax_rate / 100);
        page.drawText(totalLine.toFixed(2), { x: col5, y, size: 9, font });
        y -= 15;
      }

      y -= 20;

      // Calcul du total TVA
      let taxTotal = 0;
      for (const item of items.results) {
        taxTotal += item.quantity * item.unit_price * (item.tax_rate / 100);
      }

      page.drawText(`Total HT: ${(invoice.total - taxTotal).toFixed(2)} DZD`, { x: col3, y, size: 10, font: boldFont });
      y -= 15;
      page.drawText(`Total TVA: ${taxTotal.toFixed(2)} DZD`, { x: col3, y, size: 10, font: boldFont });
      y -= 15;
      page.drawText(`Total TTC: ${invoice.total.toFixed(2)} DZD`, { x: col3, y, size: 12, font: boldFont });

      // Notes
      if (invoice.notes) {
        y -= 30;
        page.drawText('Notes:', { x: 50, y, size: 10, font: boldFont });
        y -= 15;
        page.drawText(invoice.notes, { x: 50, y, size: 9, font });
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
