// Which pages may call these functions from a browser: the website, and the
// Android and iPhone apps - Capacitor serves the app from https://localhost on
// Android and capacitor://localhost on an iPhone. The ALLOWED_ORIGINS function
// secret (comma-separated; the older single ALLOWED_ORIGIN works too) replaces
// the website's addresses, e.g. to allow http://localhost:5173 in a dev project.
//
// This is a browser rule only: every function still checks who is calling
// (authorize.ts) before doing anything.
const SITE = (Deno.env.get('ALLOWED_ORIGINS') ?? Deno.env.get('ALLOWED_ORIGIN') ?? 'https://www.sanjeevnios.in,https://sanjeevnios.in')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const APP_ORIGINS = ['capacitor://localhost', 'https://localhost'];
const ALLOWED = new Set([...SITE, ...APP_ORIGINS]);
const PRIMARY = SITE[0] ?? 'https://www.sanjeevnios.in';

/** The Access-Control-Allow-Origin for this request: its own origin when it's
    allowed, else the website's (which the browser then refuses). */
export function allowedOrigin(req: Request): string {
  const origin = req.headers.get('Origin');
  return origin && ALLOWED.has(origin) ? origin : PRIMARY;
}

/** Wraps a function's handler: answers the browser's preflight (OPTIONS) with
    `headers`, and stamps every response with the right allowed origin. */
export function withCors(
  headers: Record<string, string>,
  handler: (req: Request) => Response | Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const origin = allowedOrigin(req);
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: { ...headers, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } });
    }
    const res = await handler(req);
    // A fresh copy: a response's own headers can be read-only.
    const out = new Response(res.body, res);
    out.headers.set('Access-Control-Allow-Origin', origin);
    out.headers.set('Vary', 'Origin');
    return out;
  };
}
