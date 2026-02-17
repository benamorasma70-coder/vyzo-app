// Génère un numéro unique pour les factures, devis, BL
export async function generateNumber(
  db: D1Database,
  userId: number,
  prefix: string,
  table: string,
  field: string
): Promise<string> {
  const year = new Date().getFullYear();
  const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
  const base = `${prefix}${year}${month}`;

  // Compter les documents du mois en cours
  const { count } = await db
    .prepare(
      `SELECT COUNT(*) as count FROM ${table} 
       WHERE user_id = ? AND strftime('%Y%m', created_at) = strftime('%Y%m', 'now')`
    )
    .bind(userId)
    .first<{ count: number }>();

  const seq = (count + 1).toString().padStart(4, '0');
  return `${base}-${seq}`;
}
