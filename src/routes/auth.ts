import { hashPassword, comparePassword, generateToken, verifyToken } from '../utils/auth';

export async function handleAuth(request: Request, db: D1Database): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/auth/register' && request.method === 'POST') {
    const body = await request.json();
    const { email, password, companyName, phone, rcNumber, nif, nis, ai } = body;

    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) {
      return new Response(JSON.stringify({ error: 'Email already exists' }), { status: 400 });
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

    return new Response(JSON.stringify({ token, user: { id: userId, email, companyName } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (path === '/auth/login' && request.method === 'POST') {
    const { email, password } = await request.json();
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (!user || !(await comparePassword(password, user.password))) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401 });
    }
    const token = generateToken(user.id);
    return new Response(JSON.stringify({ token, user: { id: user.id, email, companyName: user.company_name } }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (path === '/auth/me' && request.method === 'GET') {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return new Response('Unauthorized', { status: 401 });
    const token = authHeader.split(' ')[1];
    const payload = verifyToken(token);
    if (!payload) return new Response('Unauthorized', { status: 401 });

    const user = await db.prepare('SELECT id, email, company_name FROM users WHERE id = ?').bind(payload.userId).first();
    const subscription = await db
      .prepare('SELECT plan_name, display_name, expires_at FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
      .bind(payload.userId)
      .first();

    return new Response(JSON.stringify({ user, subscription }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Not Found', { status: 404 });
}
