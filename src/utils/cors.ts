export const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // À restreindre en production
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Credentials': 'true',
};

export function handleOptions(request: Request): Response {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  return new Response('Method Not Allowed', { status: 405 });
}
