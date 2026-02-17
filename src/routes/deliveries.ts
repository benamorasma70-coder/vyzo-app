import { verifyToken } from '../utils/auth';
import { generateNumber } from '../utils/numbers';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export async function handleDeliveries(request: Request, db: D1Database): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401 });
  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return new Response('Unauthorized', { status: 401 });

  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const id = pathParts[2];
  const action = pathParts[3]; // pour pdf

  // GET /deliveries (liste)
  if (request.method === 'GET' && !id) {
    const deliveries = await db
      .prepare(`
        SELECT d.*, c.company_name as customer_name
        FROM deliveries d
        JOIN customers c ON d.customer_id = c.id
        WHERE d.user_id = ?
        ORDER BY d.created_at DESC
      `)
      .bind(payload.userId)
      .all();
    return new Response(JSON.stringify(deliveries.results), { headers: { 'Content-Type': 'application/json' } });
  }

  // POST /deliveries (création)
  if (request.method === 'POST' && !id) {
    const body = await request.json();
    const { customerId, items, deliveryDate, notes } = body;

    let total = 0;
    for (const item of items) {
      total += item.quantity * item.unitPrice * (1 + (item.taxRate || 0) / 100);
    }

    const deliveryNumber = await generateNumber(db, payload.userId, 'BL', 'deliveries', 'delivery_number');

    const result = await db
      .prepare(
        `INSERT INTO deliveries (user_id, delivery_number, customer_id, delivery_date, notes, total, status)
         VALUES (?, ?, ?, ?, ?, ?, 'draft')`
      )
      .bind(
        payload.userId,
        deliveryNumber,
        customerId,
        deliveryDate,
        notes ?? null,
        total
      )
      .run();

    const deliveryId = result.meta.last_row_id;

    for (const item of items) {
      await db
        .prepare(
          `INSERT INTO delivery_items (delivery_id, product_id, description, quantity, unit_price, tax_rate)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          deliveryId,
          item.productId ?? null,
          item.description,
          item.quantity,
          item.unitPrice,
          item.taxRate || 0
        )
        .run();
    }

    return new Response(JSON.stringify({ id: deliveryId }), { status: 201 });
  }

  // Routes avec ID
  if (id) {
    // GET /deliveries/:id (détail)
    if (request.method === 'GET' && !action) {
      const delivery = await db
        .prepare(`
          SELECT d.*, c.company_name as customer_name
          FROM deliveries d
          JOIN customers c ON d.customer_id = c.id
          WHERE d.id = ? AND d.user_id = ?
        `)
        .bind(id, payload.userId)
        .first();
      if (!delivery) return new Response('Not Found', { status: 404 });

      const items = await db
        .prepare('SELECT * FROM delivery_items WHERE delivery_id = ?')
        .bind(id)
        .all();

      return new Response(JSON.stringify({ ...delivery, items: items.results }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Mise à jour du statut (PUT /deliveries/:id)
    if (request.method === 'PUT' && id) {
      const body = await request.json()
      const { status } = body
    
      // Vous pouvez étendre pour modifier d'autres champs si nécessaire
      const result = await db
        .prepare('UPDATE deliveries SET status = ? WHERE id = ? AND user_id = ?')
        .bind(status, id, payload.userId)
        .run()
    
      if (result.meta.changes === 0) {
        return new Response('Not Found', { status: 404 })
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }
    // GET /deliveries/:id/pdf (télécharger le PDF du BL)
    if (request.method === 'GET' && action === 'pdf') {
      // Récupérer toutes les données nécessaires
      const delivery = await db
        .prepare(`
          SELECT d.*, 
                 c.company_name as customer_company, c.contact_name, 
                 c.address, c.city, c.rc_number as customer_rc, 
                 c.ai as customer_ai,
                 u.company_name as my_company, u.rc_number, u.ai, u.phone, u.email
          FROM deliveries d
          JOIN customers c ON d.customer_id = c.id
          JOIN users u ON d.user_id = u.id
          WHERE d.id = ? AND d.user_id = ?
        `)
        .bind(id, payload.userId)
        .first();

      if (!delivery) return new Response('Not Found', { status: 404 });

      const items = await db
        .prepare('SELECT * FROM delivery_items WHERE delivery_id = ?')
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
      page.drawText('BON DE LIVRAISON', { x: margin, y, size: 24, font: fontBold });
      page.drawText(`N° ${delivery.delivery_number}`, { x: width - margin - 100, y, size: 14, font: fontBold });
      y -= 35;

      // Informations
      page.drawText('Émetteur :', { x: margin, y, size: 10, font: fontBold });
      y -= 15;
      page.drawText(delivery.my_company || '', { x: margin, y, size: 10, font: fontRegular });
      y -= 12;
      page.drawText(`RC: ${delivery.rc_number || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`MT: ${delivery.ai || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`Tél: ${delivery.phone || ''}`, { x: margin, y, size: 9, font: fontRegular });
      y -= 12;
      page.drawText(`Email: ${delivery.email || ''}`, { x: margin, y, size: 9, font: fontRegular });

      // Client (à droite)
      const colRight = width / 2 + 20;
      let yRight = height - margin - 45;
      page.drawText('Client :', { x: colRight, y: yRight, size: 10, font: fontBold });
      yRight -= 15;
      page.drawText(delivery.customer_company || delivery.contact_name, { x: colRight, y: yRight, size: 10, font: fontRegular });
      yRight -= 12;
      if (delivery.address || delivery.city) {
        page.drawText(`${delivery.address || ''} ${delivery.city || ''}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }
      if (delivery.customer_rc) {
        page.drawText(`RC: ${delivery.customer_rc}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }
      if (delivery.customer_ai) {
        page.drawText(`MT: ${delivery.customer_ai}`, { x: colRight, y: yRight, size: 9, font: fontRegular });
        yRight -= 12;
      }

      y = Math.min(y, yRight) - 20;

      // Date de livraison
      page.drawText(`Date de livraison : ${delivery.delivery_date}`, { x: margin, y, size: 10, font: fontRegular });
      y -= 35;

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
      page.drawText(`Total TTC: ${delivery.total.toFixed(2)} TND`, { x: colTotal - 120, y, size: 12, font: fontBold });

      if (delivery.notes) {
        y -= 25;
        page.drawText('Notes :', { x: margin, y, size: 10, font: fontBold });
        y -= 15;
        page.drawText(delivery.notes, { x: margin, y, size: 9, font: fontRegular });
      }

      const pdfBytes = await pdfDoc.save();
      return new Response(pdfBytes, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="BL-${delivery.delivery_number}.pdf"`,
        },
      });
    }
  }

  return new Response('Not Found', { status: 404 });
}



