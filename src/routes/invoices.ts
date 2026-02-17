import { verifyToken } from '../utils/auth';
import { generateNumber } from '../utils/numbers';

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
    return new Response(JSON.stringify(invoices.results), { headers: { 'Content-Type': 'application/json' } });
  }

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

  if (id) {
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

    if (request.method === 'POST' && action === 'generate-pdf') {
      await db.prepare('UPDATE invoices SET has_pdf = 1 WHERE id = ? AND user_id = ?').bind(id, payload.userId).run();
      return new Response(JSON.stringify({ pdf_url: `/invoices/${id}/pdf` }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Remplacer la route GET /invoices/:id/pdf par :
    if (request.method === 'GET' && action === 'pdf') {
      const invoice = await db
        .prepare('SELECT invoice_number FROM invoices WHERE id = ? AND user_id = ?')
        .bind(id, payload.userId)
        .first();
      if (!invoice) return new Response('Not Found', { status: 404 });
    
      const content = `PDF de la facture ${invoice.invoice_number} (simulation)`;
      return new Response(content, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="facture-${invoice.invoice_number}.txt"`,
        },
      });
    }
  }

  return new Response('Not Found', { status: 404 });
}

