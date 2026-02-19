import { verifyToken } from '../utils/auth';

const PLANS = [
  { id: 'free', name: 'free', display_name: 'Gratuit', price_monthly: 0, duration_months: 1, features: '[]' },
  { id: 'monthly', name: 'monthly', display_name: 'Mensuel', price_monthly: 10, duration_months: 1, features: '[]' },
  { id: 'semester', name: 'semester', display_name: 'Semestriel', price_monthly: 8, duration_months: 6, features: '[]' },
  { id: 'yearly', name: 'yearly', display_name: 'Annuel', price_monthly: 6, duration_months: 12, features: '[]' },
];

export async function handleSubscriptions(request: Request, db: D1Database, env: any): Promise<Response> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401 });
  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) return new Response('Unauthorized', { status: 401 });

  const url = new URL(request.url);
  const path = url.pathname;

  // GET /subscriptions/plans
  if (path === '/subscriptions/plans' && request.method === 'GET') {
    return new Response(JSON.stringify(PLANS), { headers: { 'Content-Type': 'application/json' } });
  }

  // POST /subscriptions/request (création d'une demande)
  if (path === '/subscriptions/request' && request.method === 'POST') {
    const body = await request.json();
    const { planId } = body;
    const plan = PLANS.find(p => p.id === planId);
    if (!plan) {
      return new Response(JSON.stringify({ error: 'Plan invalide' }), { status: 400 });
    }

    // Vérifier si une demande en attente existe déjà
    const existing = await db
      .prepare('SELECT id FROM subscription_requests WHERE user_id = ? AND status = "pending"')
      .bind(payload.userId)
      .first();
    if (existing) {
      return new Response(JSON.stringify({ error: 'Vous avez déjà une demande en attente' }), { status: 400 });
    }

    // Insérer la demande
    await db
      .prepare('INSERT INTO subscription_requests (user_id, plan_name, display_name) VALUES (?, ?, ?)')
      .bind(payload.userId, plan.name, plan.display_name)
      .run();

    // Notifier l'admin par email (si configuré)
    if (env.ADMIN_EMAIL && env.RESEND_API_KEY) {
      try {
        const user = await db.prepare('SELECT email FROM users WHERE id = ?').bind(payload.userId).first();
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'noreply@vyzo.app',
            to: env.ADMIN_EMAIL,
            subject: 'Nouvelle demande d\'abonnement',
            text: `L'utilisateur ${user?.email || payload.userId} a demandé le plan "${plan.display_name}".`,
          }),
        });
      } catch (e) {
        console.error('Erreur envoi email admin:', e);
      }
    }

    return new Response(JSON.stringify({ success: true }), { status: 201 });
  }

  // GET /subscriptions/current (abonnement actif)
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

  return new Response('Not Found', { status: 404 });
}

