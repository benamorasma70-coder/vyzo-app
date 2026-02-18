// src/index.ts (version améliorée)
import { handleAuth } from './routes/auth';
import { handleSubscriptions } from './routes/subscriptions';
import { handleCustomers } from './routes/customers';
import { handleProducts } from './routes/products';
import { handleInvoices } from './routes/invoices';
import { handleQuotes } from './routes/quotes';
import { handleDeliveries } from './routes/deliveries';
import { handleDashboard } from './routes/dashboard';
import { getCorsHeaders, handleOptions } from './utils/cors';
import { handleAdmin } from './routes/admin';

export interface Env {
  DB: D1Database;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return handleOptions(request);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    let response: Response;

    try {
      if (path.startsWith('/auth')) {
        response = await handleAuth(request, env.DB);
      } else if (path.startsWith('/subscriptions')) {
        response = await handleSubscriptions(request, env.DB);
      } else if (path.startsWith('/customers')) {
        response = await handleCustomers(request, env.DB);
      } else if (path.startsWith('/products')) {
        response = await handleProducts(request, env.DB);
      } else if (path.startsWith('/invoices')) {
        response = await handleInvoices(request, env.DB);
      } else if (path.startsWith('/quotes')) {
        response = await handleQuotes(request, env.DB);
      } else if (path.startsWith('/deliveries')) {
        response = await handleDeliveries(request, env.DB);
      } else if (path.startsWith('/dashboard')) {
        response = await handleDashboard(request, env.DB);
      } else {
        response = new Response('Not Found', { status: 404 });
      }
      else if (path.startsWith('/admin')) {
        response = await handleAdmin(request, env.DB);
      }
      } catch (err) {
        console.error(err);
        // Renvoyer l'erreur sous forme de texte pour debug
        return new Response(String(err), { status: 500, headers: { 'Content-Type': 'text/plain' } });
      }

    // Ajouter les en-têtes CORS à toutes les réponses
    const corsHeaders = getCorsHeaders(request);
    const newHeaders = new Headers(response.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => newHeaders.set(key, value));
    
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },
};


