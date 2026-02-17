import { verifyToken } from '../utils/auth';
import { generateNumber } from '../utils/numbers';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export async function handleQuotes(request: Request, db: D1Database): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401 });
  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return new Response('Unauthorized', { status: 401 });

  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const id = pathParts[2];
  const action = pathParts[3];

  // GET /quotes (liste)
  if (request.method === 'GET' && !id) {
    const quotes = await db
      .prepare(`
        SELECT q.*, c.company_name as customer_name
        FROM quotes q
        JOIN customers c ON q.customer_id = c.id
        WHERE q.user_id = ?
        ORDER BY q.created_at DESC
      `)
      .bind(payload.userId)
      .all();
    return new Response(JSON.stringify(quotes.results), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /quotes (création)
  if (request.method === 'POST' && !id) {
    const body = await request.json();
    const { customerId, items, issueDate, expiryDate, notes } = body;

    let total = 0;
    for (const item of items) {
      total += item.quantity * item.unitPrice * (1 + item.taxRate / 100);
    }

    const quoteNumber = await generateNumber(db, payload.userId, 'DEV', 'quotes', 'quote_number');

    const result = await db
      .prepare(
        `INSERT INTO quotes (user_id, quote_number, customer_id, issue_date, expiry_date, notes, total, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`
      )
      .bind(
        payload.userId,
        quoteNumber,
        customerId,
        issueDate,
        expiryDate ?? null,
        notes ?? null,
        total
      )
      .run();

    const quoteId = result.meta.last_row_id;

    for (const item of items) {
      await db
        .prepare(
          `INSERT INTO quote_items (quote_id, product_id, description, quantity, unit_price, tax_rate)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          quoteId,
          item.productId ?? null,
          item.description,
          item.quantity,
          item.unitPrice,
          item.taxRate
        )
        .run();
    }

    return new Response(JSON.stringify({ id: quoteId }), { status: 201 });
  }

  // Routes avec ID
  if (id) {
    // GET /quotes/:id (détail)
    if (request.method === 'GET' && !action) {
      const quote = await db
        .prepare(`
          SELECT q.*, c.company_name as customer_name
          FROM quotes q
          JOIN customers c ON q.customer_id = c.id
          WHERE q.id = ? AND q.user_id = ?
        `)
        .bind(id, payload.userId)
        .first();
      if (!quote) return new Response('Not Found', { status: 404 });

      const items = await db
        .prepare('SELECT * FROM quote_items WHERE quote_id = ?')
        .bind(id)
        .all();

      return new Response(JSON.stringify({ ...quote, items: items.results }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Dans handleQuotes, après la gestion du GET /:id
    if (request.method === 'PUT' && id) {
      const body = await request.json()
      const { status } = body
      // Vous pourriez aussi permettre la modification d'autres champs
    
      const result = await db
        .prepare('UPDATE quotes SET status = ? WHERE id = ? AND user_id = ?')
        .bind(status, id, payload.userId)
        .run()
    
      if (result.meta.changes === 0) {
        return new Response('Not Found', { status: 404 })
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }
    // POST /quotes/:id/convert (conversion en facture)
    if (request.method === 'POST' && action === 'convert') {
      // Récupérer le devis
      const quote = await db
        .prepare('SELECT * FROM quotes WHERE id = ? AND user_id = ?')
        .bind(id, payload.userId)
        .first();
      if (!quote) return new Response('Not Found', { status: 404 });

      // Récupérer les items du devis
      const items = await db
        .prepare('SELECT * FROM quote_items WHERE quote_id = ?')
        .bind(id)
        .all();

      // Calculer la date d'échéance (30 jours après aujourd'hui)
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 30);
      const dueDateStr = dueDate.toISOString().split('T')[0];

      // Générer un numéro de facture
      const invoiceNumber = await generateNumber(db, payload.userId, 'FACT', 'invoices', 'invoice_number');

      // Créer la facture
      const invoiceResult = await db
        .prepare(
          `INSERT INTO invoices (user_id, invoice_number, customer_id, issue_date, due_date, notes, total, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`
        )
        .bind(
          payload.userId,
          invoiceNumber,
          quote.customer_id,
          new Date().toISOString().split('T')[0], // issue_date = aujourd'hui
          dueDateStr,                              // due_date = J+30
          quote.notes ?? null,
          quote.total
        )
        .run();

      const invoiceId = invoiceResult.meta.last_row_id;

      // Transférer les items
      for (const item of items.results) {
        await db
          .prepare(
            `INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price, tax_rate)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(invoiceId, item.product_id, item.description, item.quantity, item.unit_price, item.tax_rate)
          .run();
      }

      // Mettre à jour le statut du devis
      await db.prepare('UPDATE quotes SET status = "accepted" WHERE id = ?').bind(id).run();

      return new Response(JSON.stringify({ invoiceId }), { status: 200 });
    }

    // GET /quotes/:id/pdf (télécharger le PDF du devis)
    if (request.method === 'GET' && action === 'pdf') {
      // Récupérer toutes les données nécessaires
      const quote = await db
        .prepare(`
          SELECT q.*, 
                 c.company_name as customer_company, c.contact_name, 
                 c.address, c.city, c.rc_number as customer_rc, 
                 c.nif as customer_nif, c.nis as customer_nis, c.ai as customer_ai,
                 u.company_name as my_company, u.rc_number, u.nif, u.nis, u.ai, u.phone, u.email
          FROM quotes q
          JOIN customers c ON q.customer_id = c.id
          JOIN users u ON q.user_id = u.id
          WHERE q.id = ? AND q.user_id = ?
        `)
        .bind(id, payload.userId)
        .first();

      if (!quote) return new Response('Not Found', { status: 404 });

      const items = await db
        .prepare('SELECT * FROM quote_items WHERE quote_id = ?')
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
      page.drawText('DEVIS', { x: margin, y, size: 24, font: fontBold });
      page.drawText(`N° ${quote.quote_number}`, { x: width - margin - 100, y, size: 14, font: fontBold });
      y -= 30;

      // Informations
      page.drawText('Émetteur :', { x: margin, y, size: 10, font: fontBold });
      y -= 15;
      page.drawText(quote.my_company || '', { x: margin, y, size: 10, font: fontRegular });
      y -= 12;
      page.drawText(`RC: ${quote.rc_number || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`NIF: ${quote.nif || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`NIS: ${quote.nis || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`AI: ${quote.ai || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`Tél: ${quote.phone || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`Email: ${quote.email || ''}`, { x: margin, y, size: 9, font: fontRegular });

      // Client (à droite)
      const colRight = width / 2 + 20;
      let yRight = height - margin - 45;
      page.drawText('Client :', { x: colRight, y: yRight, size: 10, font: fontBold });
      yRight -= 15;
      page.drawText(quote.customer_company || quote.contact_name, { x: colRight, y: yRight, size: 10, font: fontRegular });
      yRight -= 12;
      if (quote.address || quote.city) {
        page.drawText(`${quote.address || ''} ${quote.city || ''}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }
      if (quote.customer_rc) {
        page.drawText(`RC: ${quote.customer_rc}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }
      if (quote.customer_nif) {
        page.drawText(`NIF: ${quote.customer_nif}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }
      if (quote.customer_nis) {
        page.drawText(`NIS: ${quote.customer_nis}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }
      if (quote.customer_ai) {
        page.drawText(`AI: ${quote.customer_ai}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }

      y = Math.min(y, yRight) - 20;

      page.drawText(`Date d'émission : ${quote.issue_date}`, { x: margin, y, size: 10, font: fontRegular });
      page.drawText(`Date d'expiration : ${quote.expiry_date || '-'}`, { x: colRight, y, size: 10, font: fontRegular });
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
      page.drawText(`Total HT: ${subtotal.toFixed(2)} TND`, { x: colTotal - 120, y, size: 10, font: fontBold });
      y -= 15;
      page.drawText(`Total TVA: ${taxTotal.toFixed(2)} TND`, { x: colTotal - 120, y, size: 10, font: fontBold });
      y -= 15;
      page.drawText(`Total TTC: ${quote.total.toFixed(2)} TND`, { x: colTotal - 120, y, size: 12, font: fontBold });

      if (quote.notes) {
        y -= 25;
        page.drawText('Notes :', { x: margin, y, size: 10, font: fontBold });
        y -= 15;
        page.drawText(quote.notes, { x: margin, y, size: 9, font: fontRegular });
      }

      const pdfBytes = await pdfDoc.save();
      return new Response(pdfBytes, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="devis-${quote.quote_number}.pdf"`,
        },
      });
    }
  }

  return new Response('Not Found', { status: 404 });
}


