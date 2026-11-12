// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRegistry } from '../src/commands/registry';
import { mountDatabasePane } from '../src/ui/databasePane';

let sqlite: SqlJsStatic;
const cleanups: (() => void)[] = [];
beforeAll(async () => { sqlite = await initSqlJs({ wasmBinary: Uint8Array.from(readFileSync('node_modules/sql.js/dist/sql-wasm.wasm')).buffer }); });
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); document.body.replaceChildren(); });

function setup() {
  const root = document.createElement('div'); document.body.append(root);
  const registry = createRegistry(); const download = vi.fn();
  const pane = mountDatabasePane(root, registry, vi.fn(), vi.fn(), { load: async () => sqlite, download, confirmDiscard: () => true });
  cleanups.push(pane.dispose);
  const button = (label: string) => { const found = [...root.querySelectorAll('button')].find(item => item.textContent === label); if (!found) throw new Error(`Missing button ${label}`); return found; };
  const labeled = <T extends HTMLElement>(label: string) => root.querySelector<T>(`[aria-label="${label}"]`)!;
  return { root, registry, pane, download, button, labeled };
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
async function sample(context: ReturnType<typeof setup>) {
  context.button('Try sample database').click();
  await vi.waitFor(() => expect(context.root.querySelector('h2')?.textContent).toBe('Sample.qbase'));
}

describe('design view', () => {
  it('renames, adds and removes fields through Design view and undoes the redesign', async () => {
    const context = setup(); const { root, registry, button, labeled } = context;
    await sample(context);
    expect(registry.isAvailable('view.design')).toBe(true);
    registry.execute('view.design');
    expect(root.querySelector('.database-editor h3')?.textContent).toBe('Design view · Customers');
    const names = [...root.querySelectorAll<HTMLInputElement>('.database-editor input[aria-label="Field name"]')];
    expect(names.map(input => input.value)).toEqual(['name', 'city']);
    names[1].value = 'town';
    button('Add field').click();
    const added = [...root.querySelectorAll<HTMLInputElement>('.database-editor input[aria-label="Field name"]')].at(-1)!;
    added.value = 'vip';
    [...root.querySelectorAll<HTMLSelectElement>('.database-editor select[aria-label="Type"]')].at(-1)!.value = 'BOOLEAN';
    button('Save design').click();
    expect([...root.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['Select', 'id', 'name', 'town', 'vip']);
    expect(root.textContent).toContain('Montréal');
    root.querySelector<HTMLInputElement>('input[aria-label="Select record 1"]')!.click();
    button('Edit selected').click();
    labeled<HTMLInputElement>('vip: NULL').click();
    labeled<HTMLSelectElement>('vip').value = '1';
    button('Save record').click();
    expect(root.querySelector('tbody tr')?.textContent).toContain('Yes');
    registry.execute('edit.undo'); registry.execute('edit.undo');
    expect([...root.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['Select', 'id', 'name', 'city']);
  });

  it('keeps Design view unavailable for read-only tables', async () => {
    const context = setup();
    const db = new sqlite.Database(); db.run('CREATE TABLE t (a)'); const bytes = db.export(); db.close();
    await context.pane.openFile({ name: 't.sqlite', size: bytes.byteLength, arrayBuffer: async () => Uint8Array.from(bytes).buffer } as File);
    expect(context.registry.isAvailable('view.design')).toBe(false);
    expect(context.registry.isAvailable('view.sql')).toBe(true);
    expect(context.registry.isAvailable('ext.importText')).toBe(false);
  });
});

describe('SQL view', () => {
  it('runs read-only queries, explains them, keeps history and downloads CSV results', async () => {
    const context = setup(); const { root, registry, button, download, labeled } = context;
    await sample(context);
    registry.execute('view.sql');
    const editor = labeled<HTMLTextAreaElement>('SQL statement');
    expect(document.activeElement).toBe(editor);
    expect(editor.value).toBe('SELECT * FROM "Customers" LIMIT 100');
    editor.value = "SELECT name FROM Customers WHERE city = 'Boston'";
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    expect(root.querySelector('.sql-results tbody')?.textContent).toBe('Alex Example');
    expect(registry.isAvailable('query.history')).toBe(true);
    button('Download results (CSV)').click();
    expect(text(download.mock.calls[0][0])).toBe('name\r\nAlex Example\r\n');
    expect(download.mock.calls[0].slice(1)).toEqual(['query-results.csv', 'text/csv']);
    registry.execute('query.explain');
    expect(root.querySelector('.query-plan')?.textContent).toContain('SCAN');
    editor.value = 'DELETE FROM Customers';
    registry.execute('query.run');
    expect(root.querySelector('.sql-view [role=alert]')?.textContent).toContain('read-only');
    expect(root.textContent).toContain('Renée Example');
    editor.value = 'select a from b where c';
    registry.execute('query.formatSql');
    expect(editor.value).toBe('SELECT a\nFROM b\nWHERE c');
  });
});

describe('import, export and relationships', () => {
  it('previews a CSV import, lets field types change and imports as one undoable change', async () => {
    const context = setup(); const { root, registry, labeled } = context;
    await sample(context);
    registry.execute('ext.importText');
    const panel = root.querySelector('.import-panel') as HTMLElement;
    expect(panel.hidden).toBe(false);
    const input = panel.querySelector<HTMLInputElement>('input[type=file]')!;
    const file = new File(['zip,amount,when\n02134,1.5,2024-01-02\n10001,2,2024-01-03\n'], 'Places.csv', { type: 'text/csv' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(panel.textContent).toContain('3 fields and 2 records found'));
    expect(labeled<HTMLSelectElement>('Field 1 type').value).toBe('TEXT');
    expect(labeled<HTMLSelectElement>('Field 3 type').value).toBe('DATE');
    labeled<HTMLInputElement>('New table name').value = 'Places';
    [...panel.querySelectorAll('button')].find(item => item.textContent === 'Import 2 records')!.click();
    expect(root.querySelector('.datasheet h3')?.textContent).toBe('Places');
    expect(root.querySelector('tbody')?.textContent).toContain('02134');
    registry.execute('edit.undo');
    expect([...root.querySelectorAll('nav[aria-label="Database tables"] button')].map(item => item.textContent)).toEqual(['Customers', 'Orders']);
  });

  it('exports the current view in each format and the database as a SQL script', async () => {
    const context = setup(); const { registry, download, labeled, button } = context;
    await sample(context);
    registry.execute('sort.descending');
    registry.execute('ext.exportText');
    expect(download.mock.calls[0][1]).toBe('Customers.csv');
    expect(text(download.mock.calls[0][0]).split('\r\n')[1]).toBe('3,架空 Example,');
    registry.execute('ext.exportJson'); expect(JSON.parse(text(download.mock.calls[1][0]))[0].name).toBe('架空 Example');
    registry.execute('ext.exportHtml'); expect(text(download.mock.calls[2][0])).toContain('<caption>Customers</caption>');
    registry.execute('ext.exportXml'); expect(text(download.mock.calls[3][0])).toContain('<table name="Customers">');
    labeled<HTMLSelectElement>('Export format').value = 'sql';
    labeled<HTMLSelectElement>('Export format').dispatchEvent(new Event('change'));
    button('Export').click();
    expect(download.mock.calls[4][1]).toBe('Sample.sql');
    const db = new sqlite.Database(); db.run(text(download.mock.calls[4][0]));
    expect(db.exec('SELECT COUNT(*) FROM Orders')[0].values[0][0]).toBe(3); db.close();
  });

  it('shows declared relationships for SQLite files', async () => {
    const context = setup(); const { root, registry, pane } = context;
    const db = new sqlite.Database(); db.run('CREATE TABLE a (id INTEGER PRIMARY KEY); CREATE TABLE b (id INTEGER PRIMARY KEY, a_id REFERENCES a(id))'); const bytes = db.export(); db.close();
    await pane.openFile({ name: 'rel.sqlite', size: bytes.byteLength, arrayBuffer: async () => Uint8Array.from(bytes).buffer } as File);
    registry.execute('dbtools.relationships');
    expect(root.querySelector('.relationships')?.textContent).toContain('b (a_id) → a (id)');
    expect(root.querySelectorAll('.relationship-diagram rect')).toHaveLength(2);
  });
});
