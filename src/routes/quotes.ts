// Similaire à invoices, adapter pour quotes
import { verifyToken } from '../utils/auth';
import { generateNumber } from '../utils/numbers';

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
    return new Response(JSON.stringify(quotes.results), { headers: { 'Content-Type': 'application/json' } });
  }

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
      .bind(payload.userId, quoteNumber, customerId, issueDate, expiryDate, notes, total)
      .run();

    const quoteId = result.meta.last_row_id;

    for (const item of items) {
      await db
        .prepare(
          `INSERT INTO quote_items (quote_id, product_id, description, quantity, unit_price, tax_rate)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(quoteId, item.productId || null, item.description, item.quantity, item.unitPrice, item.taxRate)
        .run();
    }

    return new Response(JSON.stringify({ id: quoteId }), { status: 201 });
  }

  if (id) {
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

    if (request.method === 'POST' && action === 'convert') {
      // Convertir le devis en facture
      const quote = await db
        .prepare('SELECT * FROM quotes WHERE id = ? AND user_id = ?')
        .bind(id, payload.userId)
        .first();
      if (!quote) return new Response('Not Found', { status: 404 });

      const items = await db
        .prepare('SELECT * FROM quote_items WHERE quote_id = ?')
        .bind(id)
        .all();

      // Créer la facture
      const invoiceNumber = await generateNumber(db, payload.userId, 'FACT', 'invoices', 'invoice_number');
      const invoiceResult = await db
        .prepare(
          `INSERT INTO invoices (user_id, invoice_number, customer_id, issue_date, due_date, notes, total, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`
        )
        .bind(payload.userId, invoiceNumber, quote.customer_id, new Date().toISOString().split('T')[0], null, quote.notes, quote.total)
        .run();

      const invoiceId = invoiceResult.meta.last_row_id;

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
  }

  return new Response('Not Found', { status: 404 });
}
