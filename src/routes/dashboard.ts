import { verifyToken } from '../utils/auth';

export async function handleDashboard(request: Request, db: D1Database): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401 });
  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return new Response('Unauthorized', { status: 401 });

  const userId = payload.userId;

  // Totaux généraux
  const totalCustomers = await db
    .prepare('SELECT COUNT(*) as count FROM customers WHERE user_id = ?')
    .bind(userId)
    .first<{ count: number }>();
  const totalProducts = await db
    .prepare('SELECT COUNT(*) as count FROM products WHERE user_id = ?')
    .bind(userId)
    .first<{ count: number }>();

  // Périodes
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12

  // Mois en cours
  const firstDayCurrent = new Date(year, month - 1, 1).toISOString().split('T')[0];
  const lastDayCurrent = new Date(year, month, 0).toISOString().split('T')[0];

  // Mois précédent
  const firstDayPrev = new Date(year, month - 2, 1).toISOString().split('T')[0];
  const lastDayPrev = new Date(year, month - 1, 0).toISOString().split('T')[0];

  // Factures du mois en cours
  const currentInvoices = await db
    .prepare('SELECT COUNT(*) as count FROM invoices WHERE user_id = ? AND issue_date BETWEEN ? AND ?')
    .bind(userId, firstDayCurrent, lastDayCurrent)
    .first<{ count: number }>();
  const currentRevenue = await db
    .prepare('SELECT SUM(total) as total FROM invoices WHERE user_id = ? AND issue_date BETWEEN ? AND ? AND status = "paid"')
    .bind(userId, firstDayCurrent, lastDayCurrent)
    .first<{ total: number }>();

  // Factures du mois précédent
  const prevInvoices = await db
    .prepare('SELECT COUNT(*) as count FROM invoices WHERE user_id = ? AND issue_date BETWEEN ? AND ?')
    .bind(userId, firstDayPrev, lastDayPrev)
    .first<{ count: number }>();
  const prevRevenue = await db
    .prepare('SELECT SUM(total) as total FROM invoices WHERE user_id = ? AND issue_date BETWEEN ? AND ? AND status = "paid"')
    .bind(userId, firstDayPrev, lastDayPrev)
    .first<{ total: number }>();

  // Évolution clients et produits (basée sur la date de création)
  const currentCustomers = await db
    .prepare('SELECT COUNT(*) as count FROM customers WHERE user_id = ? AND created_at >= ?')
    .bind(userId, firstDayCurrent)
    .first<{ count: number }>();
  const prevCustomers = await db
    .prepare('SELECT COUNT(*) as count FROM customers WHERE user_id = ? AND created_at BETWEEN ? AND ?')
    .bind(userId, firstDayPrev, lastDayPrev)
    .first<{ count: number }>();

  const currentProducts = await db
    .prepare('SELECT COUNT(*) as count FROM products WHERE user_id = ? AND created_at >= ?')
    .bind(userId, firstDayCurrent)
    .first<{ count: number }>();
  const prevProducts = await db
    .prepare('SELECT COUNT(*) as count FROM products WHERE user_id = ? AND created_at BETWEEN ? AND ?')
    .bind(userId, firstDayPrev, lastDayPrev)
    .first<{ count: number }>();

  // Fonction pour calculer le pourcentage de variation (nombre)
  const calculateTrend = (current: number, previous: number): number => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Number((((current - previous) / previous) * 100).toFixed(1));
  };

  const trends = {
    customers: calculateTrend(currentCustomers?.count || 0, prevCustomers?.count || 0),
    products: calculateTrend(currentProducts?.count || 0, prevProducts?.count || 0),
    invoices: calculateTrend(currentInvoices?.count || 0, prevInvoices?.count || 0),
    revenue: calculateTrend(currentRevenue?.total || 0, prevRevenue?.total || 0),
  };

  // Alertes stock bas
  const lowStock = await db
    .prepare('SELECT id, name, stock_quantity FROM products WHERE user_id = ? AND stock_quantity <= min_stock AND min_stock > 0')
    .bind(userId)
    .all();

  // Dernières factures (5)
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
    monthlyInvoices: currentInvoices?.count || 0,
    monthlyRevenue: currentRevenue?.total || 0,
    trends,
    lowStock: lowStock.results,
    recentInvoices: recentInvoices.results,
  };

  return new Response(JSON.stringify(stats), {
    headers: { 'Content-Type': 'application/json' },
  });
}
