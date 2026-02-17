export function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  // Liste des origines autorisées (ajoutez votre domaine de production)
  const allowedOrigins = [
    'https://vyzo-saas.pages.dev',
    'http://localhost:5173', // pour le développement local
    'http://localhost:3000', // si nécessaire
  ];
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

export function handleOptions(request: Request): Response {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: getCorsHeaders(request) });
  }
  return new Response('Method Not Allowed', { status: 405 });
}
