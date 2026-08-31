import type {
  BatchRecord,
  MigrationRecord,
  PortfolioStats,
} from '../store/types.js';
import type { MigrationException } from '../domain/migration.js';

/**
 * Institution operations dashboard (§18).
 *
 * Server-rendered from live store data, so it is never a mock: what it shows is
 * what the API would return. It is a working surface, not a demo screen — the
 * exception queue is ordered by what an operator should pick up next.
 *
 * Visual decisions, following the data-viz method:
 *  - Headline numbers are stat tiles, not charts. A count has no shape worth plotting.
 *  - Both bar charts are single-series magnitude, so every bar is one hue
 *    (blue, validated >= 3:1 on both surfaces). Colouring bars by category would
 *    imply an identity encoding that isn't there.
 *  - Status colour (good / critical) appears only on tiles, always with an icon
 *    and a word. Green-vs-red fails CVD separation (ΔE 4.1 deutan), so hue never
 *    carries the meaning on its own.
 *  - Dark mode is a selected set of steps for the dark surface, declared under
 *    both the OS media query and an explicit theme stamp.
 */

type ExceptionRow = MigrationException & { migrationId: string; resolvedAt: string | null };

export interface DashboardData {
  stats: PortfolioStats;
  migrations: MigrationRecord[];
  exceptions: ExceptionRow[];
  batches: BatchRecord[];
}

const esc = (s: unknown): string =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const num = (n: number): string => n.toLocaleString('en-US');

const STATE_ORDER = [
  'CREATED',
  'DATA_CONNECTED',
  'ANALYZED',
  'PLAN_GENERATED',
  'CUSTOMER_AUTHORIZED',
  'IN_PROGRESS',
  'WAITING_EXTERNAL',
  'ACTION_REQUIRED',
  'VERIFYING',
  'COMPLETED',
  'CANCELLED',
];

/** Horizontal bars: one series, one hue, direct-labelled, sorted by magnitude. */
function barChart(
  rows: { label: string; value: number; share?: number }[],
  opts: { emptyMessage: string; valueFormat?: (v: number, share?: number) => string },
): string {
  if (rows.length === 0) {
    return `<p class="empty">${esc(opts.emptyMessage)}</p>`;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);
  const fmt = opts.valueFormat ?? ((v: number) => num(v));

  return `<div class="bars">${rows
    .map((r) => {
      const width = Math.max((r.value / max) * 100, r.value > 0 ? 1.5 : 0);
      return `
      <div class="bar-row" tabindex="0"
           data-tip="${esc(r.label)}: ${esc(fmt(r.value, r.share))}">
        <span class="bar-label">${esc(r.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${width.toFixed(2)}%"></span></span>
        <span class="bar-value">${esc(fmt(r.value, r.share))}</span>
      </div>`;
    })
    .join('')}</div>`;
}

function table(headers: string[], rows: string[][], emptyMessage: string): string {
  if (rows.length === 0) return `<p class="empty">${esc(emptyMessage)}</p>`;
  return `<div class="scroll"><table>
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
      .join('')}</tbody>
  </table></div>`;
}

export interface ExceptionGroup {
  code: string;
  severity: string;
  resolution: string;
  /** One representative message; the rest differ only in the subject. */
  sample: string;
  affected: number;
  migrationIds: string[];
}

/**
 * Collapse the exception list into one row per root cause.
 *
 * In a mass migration the same cause repeats across thousands of customers —
 * one destination that does not sell the LEP produces one exception per holder.
 * A queue that lists them individually is 23 identical rows here and 4,000 in
 * production, and an operator cannot see that it is a single decision to make
 * once. Grouping by (code, resolution) turns the queue back into a list of
 * things to *do*, with the affected population as the measure of how much each
 * one is worth.
 */
export function groupExceptions(exceptions: ExceptionRow[]): ExceptionGroup[] {
  const severityRank: Record<string, number> = { BLOCKING: 0, WARNING: 1, INFO: 2 };
  const groups = new Map<string, ExceptionGroup>();

  for (const e of exceptions) {
    const key = `${e.code}::${e.resolution}`;
    const existing = groups.get(key);
    if (existing) {
      existing.affected++;
      if (existing.migrationIds.length < 5) existing.migrationIds.push(e.migrationId);
    } else {
      groups.set(key, {
        code: e.code,
        severity: e.severity,
        resolution: e.resolution,
        sample: e.message,
        affected: 1,
        migrationIds: [e.migrationId],
      });
    }
  }

  return [...groups.values()].sort(
    (a, b) =>
      (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3) ||
      b.affected - a.affected ||
      a.code.localeCompare(b.code),
  );
}

export function renderDashboard(data: DashboardData): string {
  const { stats, migrations, exceptions, batches } = data;

  const stateRows = STATE_ORDER.filter((s) => (stats.byState[s] ?? 0) > 0).map((s) => ({
    label: s.replace(/_/g, ' '),
    value: stats.byState[s] ?? 0,
  }));

  const failureRows = stats.failureReasons.map((f) => ({
    label: f.code.replace(/_/g, ' '),
    value: f.count,
    share: f.share,
  }));

  const openBlocking = exceptions.filter((e) => e.severity === 'BLOCKING');
  const queue = groupExceptions(exceptions);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Migration Operations</title>
<style>
:root {
  color-scheme: light;
  --page:           #f9f9f7;
  --surface:        #fcfcfb;
  --text-primary:   #0b0b0b;
  --text-secondary: #52514e;
  --muted:          #898781;
  --grid:           #e1e0d9;
  --axis:           #c3c2b7;
  --border:         rgba(11,11,11,0.10);
  --series-1:       #2a78d6;
  --track:          #ebeae4;
  --good:           #0ca30c;
  --warning:        #fab219;
  --critical:       #d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page:           #0d0d0d;
    --surface:        #1a1a19;
    --text-primary:   #ffffff;
    --text-secondary: #c3c2b7;
    --muted:          #898781;
    --grid:           #2c2c2a;
    --axis:           #383835;
    --border:         rgba(255,255,255,0.10);
    --series-1:       #3987e5;
    --track:          #2c2c2a;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page:           #0d0d0d;
  --surface:        #1a1a19;
  --text-primary:   #ffffff;
  --text-secondary: #c3c2b7;
  --muted:          #898781;
  --grid:           #2c2c2a;
  --axis:           #383835;
  --border:         rgba(255,255,255,0.10);
  --series-1:       #3987e5;
  --track:          #2c2c2a;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--page);
  color: var(--text-primary);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 32px 24px 64px; }

header { margin-bottom: 28px; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
.sub { color: var(--text-secondary); font-size: 13px; margin: 0; }

h2 {
  font-size: 12px; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--muted);
  margin: 0 0 14px;
}

.tiles {
  display: grid; gap: 12px; margin-bottom: 28px;
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
}
.tile {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 16px 18px;
}
.tile-label {
  font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--muted); margin-bottom: 6px;
  display: flex; align-items: center; gap: 6px;
}
.tile-value { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }
.tile-note { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }
/* Status hue never travels alone: each carries a glyph and a word. */
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }
.dot.good { background: var(--good); }
.dot.critical { background: var(--critical); }
.dot.warning { background: var(--warning); }

.grid2 { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; margin-bottom: 28px; }
@media (max-width: 820px) { .grid2 { grid-template-columns: 1fr; } }

.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 18px 20px;
}

.bars { display: flex; flex-direction: column; gap: 8px; }
.bar-row {
  display: grid; grid-template-columns: 168px 1fr 76px;
  align-items: center; gap: 12px; outline: none;
}
.bar-row:hover .bar-fill, .bar-row:focus-visible .bar-fill { filter: brightness(1.08); }
.bar-row:focus-visible { outline: 2px solid var(--series-1); outline-offset: 3px; border-radius: 4px; }
.bar-label {
  font-size: 12px; color: var(--text-secondary);
  line-height: 1.3; word-break: break-word;
}
.bar-track { background: var(--track); border-radius: 4px; height: 14px; position: relative; }
.bar-fill {
  display: block; height: 100%; background: var(--series-1);
  border-radius: 0 4px 4px 0; min-width: 3px;
}
.bar-value {
  font-size: 12px; color: var(--text-secondary);
  text-align: right; font-variant-numeric: tabular-nums;
}

.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  text-align: left; font-weight: 500; color: var(--muted);
  font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase;
  padding: 0 12px 8px 0; border-bottom: 1px solid var(--grid); white-space: nowrap;
}
td {
  padding: 9px 12px 9px 0; border-bottom: 1px solid var(--grid);
  color: var(--text-secondary); vertical-align: top;
}
td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--text-primary); }
td.num { font-variant-numeric: tabular-nums; text-align: right; }
tr:last-child td { border-bottom: none; }

.chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 500; white-space: nowrap;
  padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--text-primary);
}
.meter { width: 72px; height: 6px; background: var(--track); border-radius: 3px; display: inline-block; vertical-align: middle; }
.meter > span { display: block; height: 100%; background: var(--series-1); border-radius: 3px; }
.empty { color: var(--muted); font-size: 13px; margin: 4px 0; }
footer { margin-top: 32px; color: var(--muted); font-size: 12px; }

#tip {
  position: fixed; pointer-events: none; opacity: 0;
  background: var(--text-primary); color: var(--surface);
  padding: 5px 9px; border-radius: 6px; font-size: 12px;
  transition: opacity .1s; z-index: 10; white-space: nowrap;
}
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>Migration Operations</h1>
  <p class="sub">Portfolio view · generated ${esc(new Date().toISOString())}</p>
</header>

<section class="tiles">
  <div class="tile">
    <div class="tile-label">Total migrations</div>
    <div class="tile-value">${num(stats.total)}</div>
  </div>
  <div class="tile">
    <div class="tile-label"><span class="dot good"></span>Completed</div>
    <div class="tile-value">${num(stats.completed)}</div>
    <div class="tile-note">${stats.total ? pct(stats.completed / stats.total) : '—'} of portfolio</div>
  </div>
  <div class="tile">
    <div class="tile-label">In progress</div>
    <div class="tile-value">${num(stats.inProgress)}</div>
  </div>
  <div class="tile">
    <div class="tile-label"><span class="dot critical"></span>Blocked</div>
    <div class="tile-value">${num(stats.blocked)}</div>
    <div class="tile-note">${num(openBlocking.length)} open blocking cases</div>
  </div>
  <div class="tile">
    <div class="tile-label">Relationship completion</div>
    <div class="tile-value">${pct(stats.averageCompletion)}</div>
    <div class="tile-note">weighted across migrating items</div>
  </div>
</section>

<section class="grid2">
  <div class="card">
    <h2>Migrations by state</h2>
    ${barChart(stateRows, { emptyMessage: 'No migrations yet.' })}
  </div>
  <div class="card">
    <h2>Why migrations stall</h2>
    ${barChart(failureRows, {
      emptyMessage: 'No open exceptions.',
      valueFormat: (v, share) => (share === undefined ? num(v) : `${num(v)} · ${pct(share)}`),
    })}
  </div>
</section>

${
  batches.length > 0
    ? `<section class="card" style="margin-bottom:28px">
  <h2>Batches</h2>
  ${table(
    ['Batch', 'Status', 'Customers', 'Planned', 'Blocked', 'Failed'],
    batches.map((b) => [
      `${esc(b.name)}<br><span class="mono" style="font-size:11px;color:var(--muted)">${esc(b.id)}</span>`,
      `<span class="chip">${esc(b.status)}</span>`,
      `<span class="num">${num(b.totalCustomers)}</span>`,
      `<span class="num">${num(b.plannedCount)}</span>`,
      `<span class="num">${num(b.blockedCount)}</span>`,
      `<span class="num">${num(b.failedCount)}</span>`,
    ]),
    'No batches.',
  )}
</section>`
    : ''
}

<section class="card" style="margin-bottom:28px">
  <h2>Exception queue — ${num(queue.length)} cases, ${num(exceptions.length)} migrations affected</h2>
  <p class="empty" style="margin:-6px 0 14px">
    Grouped by root cause. One destination gap or one detection threshold produces
    one row here, not one row per customer.
  </p>
  ${table(
    ['Severity', 'Cause', 'Affected', 'What happened', 'Next action'],
    queue
      .slice(0, 20)
      .map((g) => [
        `<span class="chip"><span class="dot ${
          g.severity === 'BLOCKING' ? 'critical' : g.severity === 'WARNING' ? 'warning' : 'good'
        }"></span>${esc(g.severity)}</span>`,
        `<span class="mono">${esc(g.code)}</span>`,
        `<span class="num" style="font-weight:600">${num(g.affected)}</span>
         <span style="color:var(--muted)">migration${g.affected === 1 ? '' : 's'}</span>
         <div class="mono" style="font-size:11px;color:var(--muted);margin-top:3px">
           ${g.migrationIds.map((id) => esc(id.slice(0, 14))).join('<br>')}${
             g.affected > g.migrationIds.length
               ? `<br>+${num(g.affected - g.migrationIds.length)} more`
               : ''
           }
         </div>`,
        esc(g.sample),
        esc(g.resolution),
      ]),
    'Nothing needs attention.',
  )}
</section>

<section class="card">
  <h2>Recent migrations</h2>
  ${table(
    ['Migration', 'Customer', 'State', 'Completion', 'Left behind', 'Est. days'],
    migrations
      .slice(-15)
      .reverse()
      .map((m) => [
        `<span class="mono">${esc(m.id)}</span>`,
        `<span class="mono">${esc(m.customerId)}</span>`,
        // A migration can finish everything it is allowed to do while part of
        // the customer's money stays at the origin — an LEP the destination
        // does not sell, say. Reporting that as a plain COMPLETED lets an
        // institution believe a customer moved when they half did.
        `<span class="chip">${esc(m.state.replace(/_/g, ' '))}${
          m.state === 'COMPLETED' && m.blockingExceptionCount > 0 ? ' · partial' : ''
        }</span>`,
        `<span class="meter"><span style="width:${(m.completion * 100).toFixed(1)}%"></span></span>
         <span class="num" style="margin-left:8px">${pct(m.completion)}</span>`,
        `<span class="num">${m.blockingExceptionCount > 0 ? `<span class="dot critical"></span> ${num(m.blockingExceptionCount)}` : '—'}</span>`,
        `<span class="num">${num(m.estimatedDurationDays)}</span>`,
      ]),
    'No migrations yet.',
  )}
</section>

<footer>
  Financial Migration OS · served live from <code>GET /dashboard</code>.
  Every number here is the same data <code>GET /v1/portfolio/stats</code> returns.
</footer>

</div>

<div id="tip" role="status"></div>
<script>
// Hover layer for the bar charts. Every mark reports its own value, so the
// reader never has to measure a bar against a gridline.
(function () {
  var tip = document.getElementById('tip');
  function show(e, text) {
    tip.textContent = text;
    tip.style.opacity = '1';
    var x = (e.clientX || 0) + 12, y = (e.clientY || 0) + 14;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    if (x + w > window.innerWidth - 8) x = window.innerWidth - w - 8;
    if (y + h > window.innerHeight - 8) y = (e.clientY || 0) - h - 10;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hide() { tip.style.opacity = '0'; }
  document.querySelectorAll('[data-tip]').forEach(function (el) {
    el.addEventListener('mousemove', function (e) { show(e, el.getAttribute('data-tip')); });
    el.addEventListener('mouseleave', hide);
    el.addEventListener('focus', function () {
      var r = el.getBoundingClientRect();
      show({ clientX: r.left + r.width / 2, clientY: r.top }, el.getAttribute('data-tip'));
    });
    el.addEventListener('blur', hide);
  });
})();
</script>
</body>
</html>`;
}
