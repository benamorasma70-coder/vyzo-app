import { verifyToken } from '../utils/auth';

// Définition des plans (identique à celle de subscriptions.ts)
const PLANS = [
  { id: 'free', name: 'free', display_name: 'Gratuit', price_monthly: 0, duration_months: 1 },
  { id: 'monthly', name: 'monthly', display_name: 'Mensuel', price_monthly: 10, duration_months: 1 },
  { id: 'semester', name: 'semester', display_name: 'Semestriel', price_monthly: 8, duration_months: 6 },
  { id: 'yearly', name: 'yearly', display_name: 'Annuel', price_monthly: 6, duration_months: 12 },
];

export async function handleAdmin(request: Request, db: D1Database, env: any): Promise<Response> {
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

  // GET /admin/subscription-requests (liste des demandes en attente)
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
    return new Response(JSON.stringify(requests.results), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST /admin/subscription-requests/:id/approve
  const approveMatch = path.match(/^\/admin\/subscription-requests\/(\d+)\/approve$/);
  if (approveMatch && request.method === 'POST') {
    const requestId = approveMatch[1];

    // Récupérer la demande
    const reqData = await db
      .prepare('SELECT * FROM subscription_requests WHERE id = ? AND status = "pending"')
      .bind(requestId)
      .first();
    if (!reqData) {
      return new Response(JSON.stringify({ error: 'Demande introuvable ou déjà traitée' }), { status: 404 });
    }

    // Trouver le plan correspondant
    const plan = PLANS.find(p => p.name === reqData.plan_name);
    if (!plan) {
      return new Response(JSON.stringify({ error: 'Plan inconnu' }), { status: 400 });
    }

    // Calculer la date d'expiration (à partir d'aujourd'hui)
    const expires = new Date();
    expires.setMonth(expires.getMonth() + plan.duration_months);
    const expiresAt = expires.toISOString().split('T')[0]; // format YYYY-MM-DD

    // Insérer l'abonnement actif
    await db
      .prepare(
        'INSERT INTO subscriptions (user_id, plan_name, display_name, expires_at) VALUES (?, ?, ?, ?)'
      )
      .bind(reqData.user_id, reqData.plan_name, reqData.display_name, expiresAt)
      .run();

    // Mettre à jour le statut de la demande
    await db
      .prepare('UPDATE subscription_requests SET status = "approved", processed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(requestId)
      .run();

    // Envoyer un email de notification à l'utilisateur (optionnel)
    if (env.RESEND_API_KEY) {
      try {
        const userEmail = await db.prepare('SELECT email FROM users WHERE id = ?').bind(reqData.user_id).first();
        if (userEmail) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'noreply@vyzo.app',
              to: userEmail.email,
              subject: 'Votre abonnement a été activé',
              text: `Bonjour,\n\nVotre demande d'abonnement au plan "${reqData.display_name}" a été approuvée.\nVotre abonnement est actif jusqu'au ${new Date(expiresAt).toLocaleDateString()}.`,
            }),
          });
        }
      } catch (e) {
        console.error('Erreur envoi email utilisateur:', e);
      }
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }

  // POST /admin/subscription-requests/:id/reject (optionnel)
  const rejectMatch = path.match(/^\/admin\/subscription-requests\/(\d+)\/reject$/);
  if (rejectMatch && request.method === 'POST') {
    const requestId = rejectMatch[1];
    await db
      .prepare('UPDATE subscription_requests SET status = "rejected", processed_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(requestId)
      .run();

    // Optionnel : envoyer un email de rejet à l'utilisateur
    if (env.RESEND_API_KEY) {
      try {
        const reqData = await db.prepare('SELECT user_id, display_name FROM subscription_requests WHERE id = ?').bind(requestId).first();
        if (reqData) {
          const userEmail = await db.prepare('SELECT email FROM users WHERE id = ?').bind(reqData.user_id).first();
          if (userEmail) {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                from: 'noreply@vyzo.app',
                to: userEmail.email,
                subject: 'Demande d\'abonnement rejetée',
                text: `Bonjour,\n\nVotre demande d'abonnement au plan "${reqData.display_name}" a été rejetée. Contactez l'administrateur pour plus d'informations.`,
              }),
            });
          }
        }
      } catch (e) {
        console.error('Erreur envoi email rejet:', e);
      }
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }

  return new Response('Not Found', { status: 404 });
}
