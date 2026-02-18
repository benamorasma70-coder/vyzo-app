import { hashPassword, comparePassword, generateToken, verifyToken } from '../utils/auth';

export async function handleAuth(request: Request, db: D1Database): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Helper pour ajouter des en-têtes anti-cache
  const jsonResponse = (data: any, status = 200) => {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  };

  // POST /auth/register
  if (path === '/auth/register' && request.method === 'POST') {
    const body = await request.json();
    const { email, password, companyName, phone, rcNumber, nif, nis, ai } = body;

    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) {
      return jsonResponse({ error: 'Email already exists' }, 400);
    }

    const hashed = await hashPassword(password);
    const result = await db
      .prepare(
        `INSERT INTO users (email, password, company_name, phone, rc_number, nif, nis, ai)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(email, hashed, companyName, phone, rcNumber, nif, nis, ai)
      .run();

    const userId = result.meta.last_row_id;
    const token = generateToken(userId);

    // Créer automatiquement un abonnement gratuit de 1 mois
    const expires = new Date();
    expires.setMonth(expires.getMonth() + 1);
    await db
      .prepare(
        `INSERT INTO subscriptions (user_id, plan_name, display_name, expires_at)
         VALUES (?, 'free', 'Gratuit', ?)`
      )
      .bind(userId, expires.toISOString().split('T')[0])
      .run();

    return jsonResponse({ token, user: { id: userId, email, companyName } });
  }

  // POST /auth/login
  if (path === '/auth/login' && request.method === 'POST') {
    const { email, password } = await request.json();
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (!user || !(await comparePassword(password, user.password))) {
      return jsonResponse({ error: 'Invalid credentials' }, 401);
    }
    const token = generateToken(user.id);
    return jsonResponse({ token, user: { id: user.id, email, companyName: user.company_name } });
  }

  // GET /auth/me
  if (path === '/auth/me' && request.method === 'GET') {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return jsonResponse({ error: 'Unauthorized' }, 401);
    const token = authHeader.split(' ')[1];
    const payload = verifyToken(token);
    if (!payload) return jsonResponse({ error: 'Unauthorized' }, 401);

    const user = await db.prepare('SELECT id, email, company_name FROM users WHERE id = ?').bind(payload.userId).first();

    // Récupérer l'abonnement le plus récent (trié par created_at DESC)
    let subscription = await db
      .prepare('SELECT plan_name, display_name, expires_at FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
      .bind(payload.userId)
      .first();

    // Si aucun abonnement n'existe (anciens utilisateurs), en créer un par défaut
    if (!subscription) {
      const expires = new Date();
      expires.setMonth(expires.getMonth() + 1);
      await db
        .prepare('INSERT INTO subscriptions (user_id, plan_name, display_name, expires_at) VALUES (?, ?, ?, ?)')
        .bind(payload.userId, 'free', 'Gratuit', expires.toISOString().split('T')[0])
        .run();
      // Re-récupérer
      subscription = await db
        .prepare('SELECT plan_name, display_name, expires_at FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
        .bind(payload.userId)
        .first();
    }

    // Calculer les jours restants et l'état d'expiration proche
    if (subscription) {
      const expires = new Date(subscription.expires_at);
      const now = new Date();
      const daysRemaining = Math.ceil((expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      subscription = {
        ...subscription,
        expires_soon: daysRemaining <= 7,
        days_remaining: daysRemaining,
      };
    }

    // Log pour débogage (visible dans les logs Cloudflare)
    console.log(`/auth/me for user ${payload.userId}:`, { user, subscription });

    return jsonResponse({ user, subscription });
  }

  return jsonResponse({ error: 'Not Found' }, 404);
}
