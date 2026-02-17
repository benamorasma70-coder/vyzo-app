import { verifyToken } from '../utils/auth';

export async function handleDashboard(request: Request, db: D1Database): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401 });
  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return new Response('Unauthorized', { status: 401 });

  const userId = payload.userId;

  const totalCustomers = await db.prepare('SELECT COUNT(*) as count FROM customers WHERE user_id = ?').bind(userId).first<{ count: number }>();
  const totalProducts = await db.prepare('SELECT COUNT(*) as count FROM products WHERE user_id = ?').bind(userId).first<{ count: number }>();

  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

  const monthlyInvoices = await db
    .prepare('SELECT COUNT(*) as count FROM invoices WHERE user_id = ? AND issue_date BETWEEN ? AND ?')
    .bind(userId, firstDay, lastDay)
    .first<{ count: number }>();

  const monthlyRevenue = await db
    .prepare('SELECT SUM(total) as total FROM invoices WHERE user_id = ? AND issue_date BETWEEN ? AND ? AND status = "paid"')
    .bind(userId, firstDay, lastDay)
    .first<{ total: number }>();

  const lowStock = await db
    .prepare('SELECT id, name, stock_quantity FROM products WHERE user_id = ? AND stock_quantity <= min_stock AND min_stock > 0')
    .bind(userId)
    .all();

  const recentInvoices = await db
    .prepare(`
      SELECT i.id, i.invoice_number, i.total, i.status, c.company_name as customer_name
      FROM invoices i
      JOIN customers c ON i.customer_id = c.id
      WHERE i.user_id = ?
      ORDER BY i.created_at DESC
      LIMIT 5
    `)
    .bind(userId)
    .all();

  const stats = {
    totalCustomers: totalCustomers?.count || 0,
    totalProducts: totalProducts?.count || 0,
    monthlyInvoices: monthlyInvoices?.count || 0,
    monthlyRevenue: monthlyRevenue?.total || 0,
    lowStock: lowStock.results,
    recentInvoices: recentInvoices.results,
  };

  return new Response(JSON.stringify(stats), { headers: { 'Content-Type': 'application/json' } });
}
