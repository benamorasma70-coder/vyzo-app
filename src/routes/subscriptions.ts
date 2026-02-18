import { verifyToken } from '../utils/auth';

const PLANS = [
  { id: 'free', name: 'free', display_name: 'Gratuit', price_monthly: 0, duration_months: 1, features: '[]' },
  { id: 'monthly', name: 'monthly', display_name: 'Mensuel', price_monthly: 10, duration_months: 1, features: '[]' },
  { id: 'semester', name: 'semester', display_name: 'Semestriel', price_monthly: 8, duration_months: 6, features: '[]' },
  { id: 'yearly', name: 'yearly', display_name: 'Annuel', price_monthly: 6, duration_months: 12, features: '[]' },
];

export async function handleSubscriptions(request: Request, db: D1Database): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/subscriptions/plans' && request.method === 'GET') {
    return new Response(JSON.stringify(PLANS), { headers: { 'Content-Type': 'application/json' } });
  }

  // Routes protégées
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401 });
  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return new Response('Unauthorized', { status: 401 });

  if (path === '/subscriptions/current' && request.method === 'GET') {
    const sub = await db
      .prepare('SELECT plan_name, display_name, expires_at FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
      .bind(payload.userId)
      .first();
    if (!sub) return new Response(JSON.stringify(null), { status: 200 });
    const expires = new Date(sub.expires_at);
    const now = new Date();
    const daysRemaining = Math.ceil((expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    return new Response(
      JSON.stringify({
        ...sub,
        expires_soon: daysRemaining <= 7,
        days_remaining: daysRemaining,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (path === '/subscriptions/subscribe' && request.method === 'POST') {
    const { planId } = await request.json();
    const plan = PLANS.find(p => p.id === planId);
    if (!plan) return new Response(JSON.stringify({ error: 'Invalid plan' }), { status: 400 });

    const expires = new Date();
    expires.setMonth(expires.getMonth() + plan.duration_months);

    await db
      .prepare(
        `INSERT INTO subscriptions (user_id, plan_name, display_name, expires_at)
         VALUES (?, ?, ?, ?)`
      )
      .bind(payload.userId, plan.name, plan.display_name, expires.toISOString().split('T')[0])
      .run();

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }

  return new Response('Not Found', { status: 404 });
}

