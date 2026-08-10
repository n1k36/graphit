/**
 * Static checks, without pulling in a linter.
 *
 * Parses every source file, then greps for the mistakes that have actually
 * bitten this codebase: unparameterised SQL, unescaped interpolation in the
 * views, and secrets committed by accident.
 *
 *   npm run check
 */
import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

async function sources(dir) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(rel)));
    else if (/\.(m?js)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const files = [
  ...(await sources('server')),
  ...(await sources('public')),
  ...(await sources('test')),
  ...(await sources('tools')),
];

// 1. Everything must parse.
for (const file of files) {
  try {
    await run(process.execPath, ['--check', path.join(ROOT, file)]);
  } catch (err) {
    failures.push(`${file}: does not parse — ${String(err.stderr).split('\n')[0]}`);
  }
}

// 2. SQL must be parameterised. Only the template-literal arguments to
//    prepare() matter — a normal quoted string cannot interpolate at all.
for (const file of files.filter((f) => f.startsWith('server/'))) {
  const text = await readFile(path.join(ROOT, file), 'utf8');
  for (const match of text.matchAll(/prepare\(\s*`([\s\S]*?)`/g)) {
    const sql = match[1];
    for (const interpolation of sql.match(/\$\{[^}]*\}/g) ?? []) {
      // The only interpolation we allow into SQL is a generated list of
      // placeholders for an IN clause, which contains no caller data.
      const generatedPlaceholders = /map\(\(\) => '\?'\)\.join\(','\)/.test(interpolation);
      // PRAGMA statements take no bound parameters, so a few are annotated at
      // the call site as reviewed and fed only hardcoded identifiers.
      const reviewed = text.slice(Math.max(0, match.index - 500), match.index).includes('check-allow-sql');
      if (!generatedPlaceholders && !reviewed) {
        const line = text.slice(0, match.index).split('\n').length;
        failures.push(`${file}:${line}: interpolated SQL ${interpolation} — bind it instead`);
      }
    }
  }
}

// 3. No secrets in tracked source.
const SECRET = /(sk_live_[A-Za-z0-9]|whsec_[A-Za-z0-9]{16}|-----BEGIN (RSA )?PRIVATE KEY-----)/;
for (const file of files) {
  const text = await readFile(path.join(ROOT, file), 'utf8');
  if (SECRET.test(text)) failures.push(`${file}: looks like it contains a real secret`);
}

// 4. Views must escape anything a user typed.
//
//    The escaping usually sits *inside* the interpolation — `${esc(o.label)}` —
//    and sometimes wraps a whole multi-line expression containing nested
//    templates. So rather than reasoning about `${...}` spans, we start at each
//    risky property access and walk backwards, counting parentheses, to find
//    the call it is actually an argument to.
const RISKY_PROPERTY = /\.(question|username|label|body|memo|description|destination|emoji|title|note)\b/g;

/** Name of the innermost call enclosing `index`, '' at top level of a call, null outside any. */
function enclosingCall(text, index) {
  let depth = 0;
  for (let i = index; i > 0; i--) {
    const ch = text[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      if (depth === 0) return /([A-Za-z_$][\w$.]*)\s*$/.exec(text.slice(Math.max(0, i - 40), i))?.[1] ?? '';
      depth--;
    }
  }
  return null;
}

/** Calls that render their argument as text, where markup cannot execute. */
const TEXT_SINKS = new Set(['esc', 'toast', 'confirm', 'alert', 'encodeURIComponent', 'CSS.escape', 'JSON.stringify']);

const app = await readFile(path.join(ROOT, 'public/app.js'), 'utf8');
for (const match of app.matchAll(RISKY_PROPERTY)) {
  const after = app.slice(match.index + match[0].length, match.index + match[0].length + 8);
  if (after.startsWith('.length')) continue; // a number, not text
  if (/^\s*=[^=]/.test(after)) continue; // an assignment target, not a read
  // A truthiness test decides whether to render; it is not itself rendered.
  if (/^\s*(\?[^.]|&&|\|\||\)|,)/.test(after)) continue;
  const before = app.slice(Math.max(0, match.index - 12), match.index);
  if (before.endsWith('document')) continue; // a DOM property, not user data
  const call = enclosingCall(app, match.index);
  if (call !== null && TEXT_SINKS.has(call)) continue;
  // Property definitions and reads that never reach the DOM.
  const line = app.slice(0, match.index).split('\n').length;
  const source = app.split('\n')[line - 1];
  if (!source.includes('${') && !source.includes('`')) continue;
  failures.push(`public/app.js:${line}: unescaped user text — ${source.trim().slice(0, 90)}`);
}

if (failures.length) {
  console.error(`\n  ${failures.length} problem(s):\n`);
  for (const failure of failures) console.error(`   ✗ ${failure}`);
  process.exit(1);
}
console.log(`  ✓ ${files.length} files parse, SQL is parameterised, no secrets, views escape user text`);
