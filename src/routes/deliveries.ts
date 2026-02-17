// Similaire à invoices, adapter pour deliveries
import { verifyToken } from '../utils/auth';
import { generateNumber } from '../utils/numbers';

export async function handleDeliveries(request: Request, db: D1Database): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401 });
  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return new Response('Unauthorized', { status: 401 });

  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const id = pathParts[2];

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

  if (request.method === 'POST' && !id) {
    const body = await request.json();
    const { customerId, items, deliveryDate, notes } = body;

    let total = 0;
    for (const item of items) {
      total += item.quantity * item.unitPrice * (1 + item.taxRate / 100);
    }

    const deliveryNumber = await generateNumber(db, payload.userId, 'BL', 'deliveries', 'delivery_number');

    // Insertion du BL
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

    // Insertion des items
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
          item.taxRate
        )
        .run();
    }

    return new Response(JSON.stringify({ id: deliveryId }), { status: 201 });
  }

  if (id) {
    if (request.method === 'GET') {
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
  }

  return new Response('Not Found', { status: 404 });
}

