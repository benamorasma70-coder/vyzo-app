import { verifyToken } from '../utils/auth';

export async function handleCustomers(request: Request, db: D1Database): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401 });
  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return new Response('Unauthorized', { status: 401 });

  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const id = pathParts[2];

  if (request.method === 'GET' && !id) {
    const customers = await db
      .prepare('SELECT * FROM customers WHERE user_id = ? ORDER BY created_at DESC')
      .bind(payload.userId)
      .all();
    return new Response(JSON.stringify(customers.results), { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'POST' && !id) {
    const body = await request.json();
    const { contactName, companyName, email, phone, address, city, rcNumber, nif, nis, ai } = body;
  const result = await db
    .prepare(
      `INSERT INTO customers (user_id, contact_name, company_name, email, phone, address, city, rc_number, nif, nis, ai)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(payload.userId, contactName, companyName, email, phone, address, city, rcNumber, nif, nis, ai)
    .run();
    return new Response(JSON.stringify({ id: result.meta.last_row_id }), { status: 201 });
  }

  if (id) {
    if (request.method === 'GET') {
      const customer = await db
        .prepare('SELECT * FROM customers WHERE id = ? AND user_id = ?')
        .bind(id, payload.userId)
        .first();
      if (!customer) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify(customer), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'PUT') {
      const body = await request.json();
      const { contactName, companyName, email, phone, address, city, rcNumber, nif, nis, ai } = body;
      const result = await db
        .prepare(
          `UPDATE customers SET
            contact_name = ?, company_name = ?, email = ?, phone = ?, address = ?, city = ?,
            rc_number = ?, nif = ?, nis = ?, ai = ?
           WHERE id = ? AND user_id = ?`
        )
        .bind(contactName, companyName, email, phone, address, city, rcNumber, nif, nis, ai, id, payload.userId)
        .run();
      if (result.meta.changes === 0) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify({ success: true }));
    }

    if (request.method === 'DELETE') {
      const result = await db
        .prepare('DELETE FROM customers WHERE id = ? AND user_id = ?')
        .bind(id, payload.userId)
        .run();
      if (result.meta.changes === 0) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify({ success: true }));
    }
  }

  return new Response('Method Not Allowed', { status: 405 });
}

