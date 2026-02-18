import { verifyToken } from '../utils/auth';

export async function handleAdmin(request: Request, db: D1Database): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401 });
  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return new Response('Unauthorized', { status: 401 });

  // Vérifier que l'utilisateur est admin
  const user = await db.prepare('SELECT is_admin FROM users WHERE id = ?').bind(payload.userId).first();
  if (!user || !user.is_admin) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  // GET /admin/subscription-requests
  if (path === '/admin/subscription-requests' && request.method === 'GET') {
    const requests = await db
      .prepare(`
        SELECT sr.*, u.email, u.company_name
        FROM subscription_requests sr
        JOIN users u ON sr.user_id = u.id
        WHERE sr.status = 'pending'
        ORDER BY sr.requested_at DESC
      `)
      .all();
    return new Response(JSON.stringify(requests.results), { headers: { 'Content-Type': 'application/json' } });
  }

  // POST /admin/subscription-requests/:id/approve
  const match = path.match(/^\/admin\/subscription-requests\/(\d+)\/approve$/);
  if (match && request.method === 'POST') {
    const requestId = match[1];
    // Récupérer la demande
    const reqData = await db
      .prepare('SELECT * FROM subscription_requests WHERE id = ? AND status = "pending"')
      .bind(requestId)
      .first();
    if (!reqData) return new Response('Not Found', { status: 404 });

    // Calculer la date d'expiration (par exemple 30 jours pour mensuel, etc.)
    const plan = PLANS.find(p => p.name === reqData.plan_name);
    if (!plan) return new Response('Plan inconnu', { status: 400 });

    const expires = new Date();
    expires.setMonth(expires.getMonth() + plan.duration_months);

    // Insérer l'abonnement actif
    await db
      .prepare('INSERT INTO subscriptions (user_id, plan_name, display_name, expires_at) VALUES (?, ?, ?, ?)')
      .bind(reqData.user_id, reqData.plan_name, reqData.display_name, expires.toISOString().split('T')[0])
      .run();

    // Mettre à jour la demande
    await db
      .prepare('UPDATE subscription_requests SET status = "approved", processed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(requestId)
      .run();

    // Optionnel : notifier l'utilisateur par email

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }

  // POST /admin/subscription-requests/:id/reject (similaire)
  const matchReject = path.match(/^\/admin\/subscription-requests\/(\d+)\/reject$/);
  if (matchReject && request.method === 'POST') {
    const requestId = matchReject[1];
    await db
      .prepare('UPDATE subscription_requests SET status = "rejected", processed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(requestId)
      .run();
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }

  return new Response('Not Found', { status: 404 });
}
