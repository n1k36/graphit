import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { BRAND, ROOT, openDb } from './db.js';
import { HttpError } from './errors.js';
import { handleApi } from './api.js';
import * as auth from './auth.js';
import { seed } from './seed.js';

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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
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
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createServer(db) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
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
  const db = openDb(dbFile);
  const seeded = seed(db);
  const server = createServer(db);
  server.listen(port, () => {
    if (!quiet) {
      const actual = server.address().port;
      console.log(`\n  ${BRAND.name} — ${BRAND.tagline}`);
      console.log(`  Live on http://localhost:${actual}`);
      if (seeded) console.log('  Seeded a fresh database with demo markets (sign in as demo / demo123).');
      console.log('');
    }
  });
  return { server, db };
}

if (import.meta.url === `file://${process.argv[1]}`) start();
