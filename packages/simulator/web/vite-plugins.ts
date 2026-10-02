import type { Plugin } from 'vite';

// Validates CSP entries so a view's declared domains can never inject another directive.
const clean = (domains: unknown): string => (Array.isArray(domains) ? domains.filter((d): d is string => typeof d === 'string' && !/[;\r\n'" ]/.test(d)).join(' ') : '');

interface Csp {
  resourceDomains?: string[];
  connectDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

export function buildCspHeader(csp: Csp = {}): string {
  const resources = clean(csp.resourceDomains);
  const connect = clean(csp.connectDomains);
  const frames = clean(csp.frameDomains);
  const base = clean(csp.baseUriDomains);
  return [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resources}`.trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${resources}`.trim(),
    `img-src 'self' data: blob: ${resources}`.trim(),
    `font-src 'self' data: blob: ${resources}`.trim(),
    `connect-src 'self' ${connect}`.trim(),
    frames ? `frame-src ${frames}` : "frame-src 'none'",
    "object-src 'none'",
    base ? `base-uri ${base}` : "base-uri 'none'",
  ].join('; ');
}

/** Dev server for the sandbox origin: serves sandbox.html with a CSP header taken from ?csp=, which a view cannot alter. */
export function sandboxServer(): Plugin {
  return {
    name: 'resolveai-sandbox',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://sandbox');
        if (url.pathname === '/' || url.pathname === '/sandbox.html') {
          let csp: Csp | undefined;
          try {
            const raw = url.searchParams.get('csp');
            csp = raw ? (JSON.parse(raw) as Csp) : undefined;
          } catch {
            csp = undefined;
          }
          res.setHeader('Content-Security-Policy', buildCspHeader(csp));
          res.setHeader('Cache-Control', 'no-store');
          req.url = '/sandbox.html';
        }
        next();
      });
    },
  };
}

/** The host origin must not serve the sandbox page: it exists to be on a different origin. */
export function withoutSandbox(): Plugin {
  return {
    name: 'resolveai-no-sandbox',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (new URL(req.url ?? '/', 'http://host').pathname === '/sandbox.html') {
          res.statusCode = 404;
          res.end('The sandbox is served on its own origin');
          return;
        }
        next();
      });
    },
  };
}
