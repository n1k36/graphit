/**
 * Terminal reporting for the harnesses.
 *
 * A harness that prints a wall of numbers tells you nothing; a harness that
 * prints a number next to the threshold it had to beat tells you whether to
 * ship. Every metric here carries its own verdict, and the process exit code
 * is the sum of those verdicts.
 */
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : String(text));

export const dim = (t) => paint('2', t);
export const bold = (t) => paint('1', t);
export const green = (t) => paint('32', t);
export const red = (t) => paint('31', t);
export const yellow = (t) => paint('33', t);
export const cyan = (t) => paint('36', t);

/** Visible width, ignoring the escape sequences `paint` may have added. */
const width = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, '').length;

const pad = (text, to, align) => {
  const gap = Math.max(0, to - width(text));
  return align === 'right' ? ' '.repeat(gap) + text : text + ' '.repeat(gap);
};

/** Fixed-width numbers, because columns of ragged decimals are unreadable. */
export const num = (value, places = 2) =>
  Number.isFinite(value) ? value.toFixed(places) : '—';
export const pct = (value, places = 1) =>
  Number.isFinite(value) ? `${(value * 100).toFixed(places)}%` : '—';
export const money = (value) => (Number.isFinite(value) ? `$${value.toFixed(2)}` : '—');

/**
 * Render a table. Columns whose every cell is numeric are right-aligned;
 * everything else stays left. No borders — whitespace reads better in a log.
 */
export function table(headers, rows) {
  if (!rows.length) return dim('  (no rows)');
  const columns = headers.length;
  const aligns = Array.from({ length: columns }, (_, i) =>
    rows.every((row) => /^[-$]?[\d.,]+%?$|^—$/.test(String(row[i]))) ? 'right' : 'left',
  );
  const widths = Array.from({ length: columns }, (_, i) =>
    Math.max(width(headers[i]), ...rows.map((row) => width(row[i]))),
  );
  const line = (cells, decorate = (x) => x) =>
    '  ' + cells.map((cell, i) => decorate(pad(String(cell), widths[i], aligns[i]))).join('  ');
  return [
    line(headers, dim),
    line(widths.map((w) => '─'.repeat(w)), dim),
    ...rows.map((row) => line(row)),
  ].join('\n');
}

class Section {
  constructor(title) {
    this.title = title;
    this.blocks = [];
    this.checks = [];
  }

  /** Free text, indented to line up with tables. */
  note(text) {
    this.blocks.push({ kind: 'note', text });
    return this;
  }

  table(headers, rows) {
    this.blocks.push({ kind: 'table', headers, rows });
    return this;
  }

  /**
   * A measurement with a pass condition. `detail` explains the threshold in
   * words, so a failure is actionable without reading this file.
   */
  check(label, ok, detail = '') {
    this.checks.push({ label, ok: !!ok, detail });
    this.blocks.push({ kind: 'check', label, ok: !!ok, detail });
    return this;
  }

  /** A number worth recording that nothing depends on. */
  metric(label, value, detail = '') {
    this.blocks.push({ kind: 'metric', label, value, detail });
    return this;
  }
}

export class Report {
  constructor(title, subtitle = '') {
    this.title = title;
    this.subtitle = subtitle;
    this.sections = [];
    this.startedAt = Date.now();
  }

  section(title) {
    const section = new Section(title);
    this.sections.push(section);
    return section;
  }

  get checks() {
    return this.sections.flatMap((s) => s.checks);
  }

  get failures() {
    return this.checks.filter((c) => !c.ok);
  }

  get ok() {
    return this.failures.length === 0;
  }

  render(out = process.stdout) {
    const write = (text = '') => out.write(text + '\n');
    write();
    write(bold(this.title) + (this.subtitle ? dim(`  ${this.subtitle}`) : ''));
    write(dim('─'.repeat(Math.max(20, width(this.title) + width(this.subtitle) + 2))));

    for (const section of this.sections) {
      write();
      write(cyan(section.title));
      for (const block of section.blocks) {
        if (block.kind === 'table') write(table(block.headers, block.rows));
        else if (block.kind === 'note') write(dim('  ' + block.text));
        else if (block.kind === 'metric') {
          write(`  ${pad(block.label, 42)} ${bold(block.value)}${block.detail ? dim('  ' + block.detail) : ''}`);
        } else {
          const mark = block.ok ? green('✓') : red('✗');
          const detail = block.detail ? dim(`  ${block.detail}`) : '';
          write(`  ${mark} ${pad(block.label, 40)}${detail}`);
        }
      }
    }

    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const passed = this.checks.length - this.failures.length;
    write();
    write(
      this.ok
        ? green(`${passed}/${this.checks.length} checks passed`) + dim(`  in ${seconds}s`)
        : red(`${this.failures.length} of ${this.checks.length} checks failed`) + dim(`  in ${seconds}s`),
    );
    for (const failure of this.failures) write(red(`  ✗ ${failure.label}`) + (failure.detail ? dim(`  ${failure.detail}`) : ''));
    write();
    return this.ok;
  }

  toJSON() {
    return {
      title: this.title,
      subtitle: this.subtitle,
      ok: this.ok,
      durationMs: Date.now() - this.startedAt,
      sections: this.sections.map((s) => ({
        title: s.title,
        checks: s.checks,
        blocks: s.blocks,
      })),
    };
  }
}

/** Deterministic PRNG. Seeded, so a failing run can be replayed exactly. */
export function rng(seed = 1) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Box-Muller, for the noise in trader beliefs. */
  next.normal = (mean = 0, sd = 1) => {
    const u = Math.max(next(), 1e-12);
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  next.pick = (items) => items[Math.floor(next() * items.length)];
  next.between = (lo, hi) => lo + next() * (hi - lo);
  return next;
}

/** Percentile of an unsorted array of numbers. */
export function percentile(values, p) {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN);
