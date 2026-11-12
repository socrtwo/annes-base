import type { Cell, DatabaseSession } from '../engine/database';
import { toDelimited } from '../engine/exchange';
import { formatSql, MAX_QUERY_ROWS, type QueryResult } from '../engine/sqlQuery';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;
};
const display = (value: Cell) => value === null ? 'NULL' : value instanceof Uint8Array ? `BLOB · ${value.byteLength} bytes` : String(value).slice(0, 2000);
export const MAX_QUERY_HISTORY = 50;

export interface SqlViewContext { session: DatabaseSession | undefined; table: string | undefined; busy: boolean }

/** Read-only SQL view: run, explain, format and re-run recent statements for the open database. */
export function mountSqlView(host: HTMLElement, context: () => SqlViewContext, download: (bytes: Uint8Array, name: string, type: string) => void) {
  host.className = 'sql-view'; host.hidden = true; host.setAttribute('aria-label', 'SQL view');
  const heading = node('h3', 'SQL view'); heading.tabIndex = -1;
  const help = node('p', `Run one SELECT, WITH or VALUES statement at a time. The SQL view is read-only, so data changes stay in the journal and can be undone. Results show up to ${MAX_QUERY_ROWS.toLocaleString('en-US')} rows. Ctrl+Enter runs; Ctrl+Shift+E explains.`);
  const editor = node('textarea'); editor.rows = 6; editor.spellcheck = false; editor.className = 'sql-editor';
  editor.setAttribute('aria-label', 'SQL statement');
  const status = node('p'); status.setAttribute('role', 'status');
  const error = node('p'); error.setAttribute('role', 'alert');
  const results = node('div'); results.className = 'sql-results';
  const historyList = node('ol'); historyList.className = 'query-history';
  const historyBox = node('details'); historyBox.append(node('summary', 'Query history'), historyList);
  const history: string[] = [];
  let last: QueryResult | undefined;
  let lastSession: DatabaseSession | undefined;
  const button = (text: string, action: () => void) => { const value = node('button', text); value.type = 'button'; value.addEventListener('click', action); return value; };
  const remember = (sql: string) => {
    const index = history.indexOf(sql); if (index >= 0) history.splice(index, 1);
    history.unshift(sql); history.splice(MAX_QUERY_HISTORY);
    historyList.replaceChildren(...history.map(entry => {
      const item = node('li'); const text = node('code', entry.length > 200 ? entry.slice(0, 200) + '…' : entry);
      const use = button('Use', () => { editor.value = entry; editor.focus(); }); use.setAttribute('aria-label', `Use query: ${entry.slice(0, 80)}`);
      item.append(text, use); return item;
    }));
  };
  const current = () => {
    const ctx = context();
    if (!ctx.session || ctx.busy) throw new Error('Open a database first.');
    if (ctx.session !== lastSession) { last = undefined; lastSession = ctx.session; }
    return ctx.session;
  };
  const guard = (action: () => void) => { error.textContent = ''; try { action(); } catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); } };
  function run() {
    guard(() => {
      const session = current(); const sql = editor.value;
      results.replaceChildren(); last = undefined; exportButton.disabled = true;
      const result = session.query(sql);
      remember(sql.trim()); last = result; exportButton.disabled = false;
      status.textContent = `${result.rows.length.toLocaleString('en-US')} rows${result.truncated ? ` (first ${MAX_QUERY_ROWS.toLocaleString('en-US')} shown; add LIMIT or narrow the query)` : ''} · ${result.elapsedMs.toFixed(1)} ms`;
      const wrapper = node('div'); wrapper.className = 'datasheet-scroll'; wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', 'Query results');
      const table = node('table'); table.append(node('caption', 'Query results'));
      const head = node('tr'); for (const column of result.columns) { const th = node('th', column); th.scope = 'col'; head.append(th); }
      const thead = node('thead'); thead.append(head);
      const body = node('tbody');
      for (const row of result.rows) {
        const tr = node('tr');
        for (const value of row) { const td = node('td', display(value)); if (value === null) td.className = 'null-cell'; tr.append(td); }
        body.append(tr);
      }
      table.append(thead, body); wrapper.append(table); results.append(wrapper);
    });
  }
  function explain() {
    guard(() => {
      const steps = current().explain(editor.value);
      results.replaceChildren();
      const list = node('ul'); list.className = 'query-plan'; list.setAttribute('aria-label', 'Query plan');
      const depth = new Map<number, number>([[0, 0]]);
      for (const step of steps) {
        const level = (depth.get(step.parent) ?? 0) + 1; depth.set(step.id, level);
        const item = node('li', step.detail); item.style.marginInlineStart = `${(level - 1) * 1.25}rem`; list.append(item);
      }
      results.append(node('h4', 'Query plan'), list);
      status.textContent = 'Query plan shown. The statement was not run.';
    });
  }
  const runButton = button('Run query', run);
  const explainButton = button('Explain plan', explain);
  const formatButton = button('Format SQL', () => guard(() => { editor.value = formatSql(editor.value); editor.focus(); }));
  const exportButton = button('Download results (CSV)', () => guard(() => {
    if (!last) return;
    const csv = toDelimited({ name: 'Query', columns: last.columns, types: last.columns.map(() => ''), rows: last.rows });
    download(new TextEncoder().encode(csv), 'query-results.csv', 'text/csv');
    status.textContent = `Downloaded ${last.rows.length.toLocaleString('en-US')} result rows as CSV.`;
  }));
  exportButton.disabled = true;
  const close = button('Close SQL view', () => { host.hidden = true; });
  editor.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); run(); }
    else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toUpperCase() === 'E') { event.preventDefault(); event.stopPropagation(); explain(); }
  });
  const actions = node('div'); actions.className = 'editor-actions'; actions.append(runButton, explainButton, formatButton, exportButton, close);
  host.append(heading, help, editor, actions, status, error, results, historyBox);
  return {
    show(focusHistory = false) {
      const ctx = context();
      if (!editor.value.trim() && ctx.table) editor.value = `SELECT * FROM "${ctx.table.replaceAll('"', '""')}" LIMIT 100`;
      host.hidden = false; host.scrollIntoView?.({ block: 'start' });
      if (focusHistory) { historyBox.open = true; historyBox.querySelector('summary')!.focus(); } else editor.focus();
    },
    run: () => { if (!host.hidden) run(); },
    explain: () => { if (!host.hidden) explain(); },
    format: () => formatButton.click(),
    get open() { return !host.hidden; },
    get historyCount() { return history.length; },
    contextChanged() { const ctx = context(); if (ctx.session !== lastSession) { results.replaceChildren(); status.textContent = ''; error.textContent = ''; last = undefined; exportButton.disabled = true; lastSession = ctx.session; } runButton.disabled = explainButton.disabled = !ctx.session || ctx.busy; },
  };
}
