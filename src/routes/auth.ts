import { hashPassword, comparePassword, generateToken, verifyToken } from '../utils/auth';

// Fonction utilitaire pour générer un token aléatoire (crypto)
function generateRandomToken(): string {
  const buffer = new Uint8Array(32);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Helper pour les réponses JSON avec en-têtes anti-cache
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

export async function handleAuth(request: Request, db: D1Database, env: any): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // --- Route: POST /auth/forgot-password ---
  if (path === '/auth/forgot-password' && request.method === 'POST') {
    const body = await request.json();
    const { email } = body;

    if (!email) {
      return jsonResponse({ error: 'Email requis' }, 400);
    }

    // Vérifier si l'utilisateur existe
    const user = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (!user) {
      // Pour des raisons de sécurité, on renvoie un message neutre
      return jsonResponse({ message: 'Si cet email existe, vous recevrez un lien de réinitialisation.' }, 200);
    }

    // Générer un token unique
    const token = generateRandomToken();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1); // Expire dans 1 heure

    // Supprimer les anciens tokens pour cet email
    await db.prepare('DELETE FROM password_resets WHERE email = ?').bind(email).run();

    // Insérer le nouveau token
    await db.prepare(
      'INSERT INTO password_resets (email, token, expires_at) VALUES (?, ?, ?)'
    ).bind(email, token, expiresAt.toISOString()).run();

    // Construire le lien de réinitialisation vers le FRONTEND (variable d'environnement)
    const FRONTEND_URL = env.FRONTEND_URL; // ex: https://mon-projet.pages.dev
    const resetLink = `${FRONTEND_URL}/reset-password?token=${token}`;

    // Appeler le worker d'envoi d'email (Resend)
    const EMAIL_WORKER_URL = env.EMAIL_WORKER_URL;
    const EMAIL_WORKER_TOKEN = env.EMAIL_WORKER_TOKEN;

    const emailResponse = await fetch(EMAIL_WORKER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${EMAIL_WORKER_TOKEN}`,
      },
      body: JSON.stringify({
        to: email,
        subject: 'Réinitialisation de votre mot de passe',
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #6c8dff;">Réinitialisation du mot de passe</h2>
            <p>Bonjour,</p>
            <p>Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le lien ci-dessous pour procéder :</p>
            <p style="margin: 30px 0;">
              <a href="${resetLink}" style="background: #6c8dff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px;">
                Réinitialiser mon mot de passe
              </a>
            </p>
            <p>Ou copiez ce lien : <br> <a href="${resetLink}">${resetLink}</a></p>
            <p>Ce lien est valable 1 heure.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="color: #6b7280; font-size: 13px;">VYZO - Gestion commerciale</p>
          </div>
        `,
      }),
    });

    if (!emailResponse.ok) {
      // Ne pas divulguer l'échec à l'utilisateur, mais loguer l'erreur
      console.error("Échec de l'envoi d'email pour", email, await emailResponse.text());
    }

    return jsonResponse({ message: 'Si cet email existe, vous recevrez un lien de réinitialisation.' }, 200);
  }

  // --- Route: POST /auth/reset-password ---
  if (path === '/auth/reset-password' && request.method === 'POST') {
    const body = await request.json();
    const { token, newPassword } = body;

    if (!token || !newPassword) {
      return jsonResponse({ error: 'Token et nouveau mot de passe requis' }, 400);
    }

    // Récupérer l'entrée de reset
    const resetEntry = await db.prepare(
      'SELECT email, expires_at FROM password_resets WHERE token = ?'
    ).bind(token).first();

    if (!resetEntry) {
      return jsonResponse({ error: 'Token invalide' }, 400);
    }

    // Vérifier l'expiration
    const now = new Date();
    const expiresAt = new Date(resetEntry.expires_at);
    if (now > expiresAt) {
      await db.prepare('DELETE FROM password_resets WHERE token = ?').bind(token).run();
      return jsonResponse({ error: 'Token expiré' }, 400);
    }

    // Récupérer l'utilisateur correspondant
    const user = await db.prepare('SELECT id FROM users WHERE email = ?').bind(resetEntry.email).first();
    if (!user) {
      // Supprimer le token orphelin
      await db.prepare('DELETE FROM password_resets WHERE token = ?').bind(token).run();
      return jsonResponse({ error: 'Utilisateur non trouvé' }, 404);
    }

    // Hasher le nouveau mot de passe
    const hashedPassword = await hashPassword(newPassword);

    // Mettre à jour le mot de passe
    await db.prepare('UPDATE users SET password = ? WHERE id = ?').bind(hashedPassword, user.id).run();

    // Supprimer le token utilisé
    await db.prepare('DELETE FROM password_resets WHERE token = ?').bind(token).run();

    return jsonResponse({ message: 'Mot de passe mis à jour avec succès' }, 200);
  }

  // --- Routes existantes (register, login, me) ---
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
        `INSERT INTO users (email, password, company_name, phone, rc_number, nif, nis, ai, is_admin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
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

    // Récupérer l'abonnement fraîchement créé
    const subscription = await db
      .prepare('SELECT plan_name, display_name, expires_at FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
      .bind(userId)
      .first();

    return jsonResponse({
      token,
      user: { id: userId, email, companyName, is_admin: 0 },
      subscription,
    });
  }

  // POST /auth/login
  if (path === '/auth/login' && request.method === 'POST') {
    const { email, password } = await request.json();

    const user = await db
      .prepare('SELECT id, email, company_name, password, is_admin FROM users WHERE email = ?')
      .bind(email)
      .first();

    if (!user || !(await comparePassword(password, user.password))) {
      return jsonResponse({ error: 'Invalid credentials' }, 401);
    }

    // Récupérer l'abonnement le plus récent
    let subscription = await db
      .prepare('SELECT plan_name, display_name, expires_at FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
      .bind(user.id)
      .first();

    if (!subscription) {
      const expires = new Date();
      expires.setMonth(expires.getMonth() + 1);
      await db
        .prepare('INSERT INTO subscriptions (user_id, plan_name, display_name, expires_at) VALUES (?, ?, ?, ?)')
        .bind(user.id, 'free', 'Gratuit', expires.toISOString().split('T')[0])
        .run();
      subscription = await db
        .prepare('SELECT plan_name, display_name, expires_at FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
        .bind(user.id)
        .first();
    }

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

    const token = generateToken(user.id);

    return jsonResponse({
      token,
      user: {
        id: user.id,
        email: user.email,
        companyName: user.company_name,
        is_admin: user.is_admin,
      },
      subscription,
    });
  }

  // GET /auth/me
  if (path === '/auth/me' && request.method === 'GET') {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return jsonResponse({ error: 'Unauthorized' }, 401);
    const token = authHeader.split(' ')[1];
    const payload = verifyToken(token);
    if (!payload) return jsonResponse({ error: 'Unauthorized' }, 401);

    // Récupérer l'utilisateur avec is_admin
    const user = await db
      .prepare('SELECT id, email, company_name, is_admin FROM users WHERE id = ?')
      .bind(payload.userId)
      .first();

    // Récupérer l'abonnement le plus récent
    let subscription = await db
      .prepare('SELECT plan_name, display_name, expires_at FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
      .bind(payload.userId)
      .first();

    // Si aucun abonnement, en créer un par défaut
    if (!subscription) {
      const expires = new Date();
      expires.setMonth(expires.getMonth() + 1);
      await db
        .prepare('INSERT INTO subscriptions (user_id, plan_name, display_name, expires_at) VALUES (?, ?, ?, ?)')
        .bind(payload.userId, 'free', 'Gratuit', expires.toISOString().split('T')[0])
        .run();
      subscription = await db
        .prepare('SELECT plan_name, display_name, expires_at FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1')
        .bind(payload.userId)
        .first();
    }

    // Calculer les jours restants
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

    return jsonResponse({ user, subscription });
  }

  return jsonResponse({ error: 'Not Found' }, 404);
}
