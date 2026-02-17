import { verifyToken } from '../utils/auth';

export async function handleProducts(request: Request, db: D1Database): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401 });
  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return new Response('Unauthorized', { status: 401 });

  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const id = pathParts[2];

  if (request.method === 'GET' && !id) {
    const products = await db
      .prepare('SELECT * FROM products WHERE user_id = ? ORDER BY created_at DESC')
      .bind(payload.userId)
      .all();
    return new Response(JSON.stringify(products.results), { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'POST' && !id) {
    const body = await request.json();
    const { reference, name, description, category, unit, purchasePrice, salePrice, taxRate, stockQuantity, minStock } = body;
    const result = await db
      .prepare(
        `INSERT INTO products (user_id, reference, name, description, category, unit, purchase_price, sale_price, tax_rate, stock_quantity, min_stock)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        payload.userId,
        reference,
        name,
        description ?? null,
        category ?? null,
        unit,
        purchasePrice ?? null,
        salePrice,
        taxRate ?? null,
        stockQuantity ?? null,
        minStock ?? null
      )
      .run();
    return new Response(JSON.stringify({ id: result.meta.last_row_id }), { status: 201 });
  }

  if (id) {
    if (request.method === 'GET') {
      const product = await db
        .prepare('SELECT * FROM products WHERE id = ? AND user_id = ?')
        .bind(id, payload.userId)
        .first();
      if (!product) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify(product), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'PUT') {
      const body = await request.json();
      const { reference, name, description, category, unit, purchasePrice, salePrice, taxRate, stockQuantity, minStock } = body;
      const result = await db
        .prepare(
          `UPDATE products SET
            reference = ?, name = ?, description = ?, category = ?, unit = ?,
            purchase_price = ?, sale_price = ?, tax_rate = ?, stock_quantity = ?, min_stock = ?
           WHERE id = ? AND user_id = ?`
        )
        .bind(reference, name, description, category, unit, purchasePrice, salePrice, taxRate, stockQuantity, minStock, id, payload.userId)
        .run();
      if (result.meta.changes === 0) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify({ success: true }));
    }

    if (request.method === 'DELETE') {
      const result = await db
        .prepare('DELETE FROM products WHERE id = ? AND user_id = ?')
        .bind(id, payload.userId)
        .run();
      if (result.meta.changes === 0) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify({ success: true }));
    }
  }

  return new Response('Method Not Allowed', { status: 405 });
}

