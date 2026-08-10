import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { BRAND, ROOT, openDb, validateEnvironment } from './db.js';
import { HttpError } from './errors.js';
import { handleApi } from './api.js';
import * as auth from './auth.js';
import { seed } from './seed.js';
import { attachStream, closeAllStreams, streamClientCount } from './events.js';

const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 256 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.mjs': 'text/javascript; charset=utf-8',
};

/**
 * Applied to every response. The CSP is tight because the app loads no third
 * party code at all: scripts come from this origin only, and the sole reason
 * style-src allows inline is the style="" attributes the views generate.
 */
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
};

/** HSTS only makes sense once traffic is actually served over TLS. */
function securityHeaders(req) {
  const https = req.headers['x-forwarded-proto'] === 'https';
  return https
    ? { ...SECURITY_HEADERS, 'strict-transport-security': 'max-age=31536000; includeSubDomains' }
    : SECURITY_HEADERS;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(res.securityHeaders ?? {}),
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return { body: {}, raw: '' };
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    return { body: parsed && typeof parsed === 'object' ? parsed : {}, raw };
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = path.join(PUBLIC_DIR, path.normalize(relative));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    // Unknown path with no extension: let the single-page app route it.
    if (path.extname(filePath)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    filePath = path.join(PUBLIC_DIR, 'index.html');
    info = await stat(filePath).catch(() => null);
    if (!info) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
  }
  const body = await readFile(filePath);
  // Fingerprint-free assets, so revalidate the shell but let icons sit in cache.
  const immutable = pathname.startsWith('/icons/');
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': immutable ? 'public, max-age=604800' : 'no-cache',
    ...(res.securityHeaders ?? {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createServer(db) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    res.securityHeaders = securityHeaders(req);
    try {
      // Liveness/readiness. Deliberately trivial and dependency-free so an
      // orchestrator can tell "process up" apart from "database reachable".
      if (url.pathname === '/healthz') {
        let database = 'ok';
        try {
          db.prepare('SELECT 1').get();
        } catch (err) {
          database = `error: ${err.message}`;
        }
        sendJson(res, database === 'ok' ? 200 : 503, {
          status: database === 'ok' ? 'ok' : 'degraded',
          database,
          uptime: Math.round(process.uptime()),
          streamClients: streamClientCount(),
          version: BRAND.name,
        });
        return;
      }
      // Live updates. Held open, so it bypasses the JSON request pipeline.
      if (url.pathname === '/api/stream') {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Use GET for the event stream.' });
          return;
        }
        // EventSource cannot set headers, so the token arrives in the query.
        const streamUser = auth.userForToken(db, url.searchParams.get('token'));
        attachStream(req, res, { userId: streamUser?.id ?? null });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        const token = auth.tokenFromRequest(req);
        const { body, raw } =
          req.method === 'GET' || req.method === 'HEAD' ? { body: {}, raw: '' } : await readBody(req);
        const ctx = {
          db,
          req,
          res,
          method: req.method,
          pathname: url.pathname,
          query: url.searchParams,
          body,
          rawBody: raw,
          token,
          user: auth.userForToken(db, token),
          ip: req.socket.remoteAddress ?? 'unknown',
        };
        const payload = await handleApi(ctx);
        sendJson(res, 200, payload ?? { ok: true });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end('Method not allowed');
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message, details: err.details });
      } else {
        console.error(`[${BRAND.name}] ${req.method} ${url.pathname} failed:`, err);
        sendJson(res, 500, { error: 'Something went wrong on our side.' });
      }
    }
  });
}

export function start({ port = Number(process.env.PORT) || 4173, dbFile, quiet = false } = {}) {
  const { provider, problems, warnings } = validateEnvironment();
  for (const warning of warnings) console.warn(`  [config] ${warning}`);
  if (problems.length) {
    for (const problem of problems) console.error(`  [config] ${problem}`);
    throw new Error('Refusing to start with an incomplete payment configuration.');
  }

  const db = openDb(dbFile);
  const seeded = seed(db);
  auth.pruneSessions(db);
  // Sweep expired sessions daily; unref so it never holds the process open.
  const sweeper = setInterval(() => auth.pruneSessions(db), 24 * 3600_000);
  sweeper.unref?.();

  const server = createServer(db);
  server.listen(port, () => {
    if (!quiet) {
      const actual = server.address().port;
      console.log(`\n  ${BRAND.name} — ${BRAND.tagline}`);
      console.log(`  Live on http://localhost:${actual}   payments: ${provider}`);
      if (seeded) console.log('  Seeded a fresh database with demo markets (sign in as demo / demo123).');
      console.log('');
    }
  });

  // Finish in-flight requests before the process goes away, so a deploy does
  // not drop somebody's trade.
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    if (!quiet) console.log(`\n  ${signal} received, draining connections…`);
    clearInterval(sweeper);
    closeAllStreams();
    server.close(() => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      process.exit(0);
    });
    // Do not hang forever on a wedged keep-alive connection.
    setTimeout(() => process.exit(0), 10_000).unref?.();
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(signal));

  return { server, db, shutdown };
}

if (import.meta.url === `file://${process.argv[1]}`) start();
