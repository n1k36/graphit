/**
 * Isolated server lifecycle for harnesses.
 *
 * Every harness gets its own process, its own ephemeral port and its own
 * temporary database. That is deliberate: during development, a stale server
 * left holding port 4173 silently served old code three separate times, and
 * the results looked plausible enough to believe. Binding to port 0 makes that
 * impossible — you cannot collide with something you did not start.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../server/db.js';
import { createServer } from '../../server/server.js';
import { seed as seedDemo } from '../../server/seed.js';

/**
 * Boot a server nobody else can reach.
 *
 * @param {object} options
 * @param {boolean} options.seed      populate the demo markets and users
 * @param {boolean} options.onDisk    use a temp file rather than :memory:
 *                                    (needed to exercise WAL and busy_timeout)
 * @param {object}  options.env       environment overrides, restored on close
 */
export async function startHarnessServer({ seed = false, onDisk = false, env = {} } = {}) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }

  let directory = null;
  let file = ':memory:';
  if (onDisk) {
    directory = mkdtempSync(path.join(tmpdir(), 'tell-harness-'));
    file = path.join(directory, 'harness.db');
  }

  const db = openDb(file);
  if (seed) seedDemo(db);

  const server = createServer(db);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    db,
    server,
    port,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      try {
        db.close();
      } catch {
        /* already closed */
      }
      if (directory) rmSync(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

/** Run `fn` against a fresh server and always tear it down. */
export async function withServer(options, fn) {
  const harness = await startHarnessServer(options);
  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
}
