// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRegistry } from '../src/commands/registry';
import { DatabaseSession } from '../src/engine/database';
import { mountDatabasePane } from '../src/ui/databasePane';

let sqlite: SqlJsStatic;
const cleanups: (() => void)[] = [];
beforeAll(async () => { sqlite = await initSqlJs({ wasmBinary: Uint8Array.from(readFileSync('node_modules/sql.js/dist/sql-wasm.wasm')).buffer }); });
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); document.body.replaceChildren(); vi.useRealTimers(); });
const at = (minute: number) => vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 12, minute)));
const iso = (minute: number, second = 30) => new Date(Date.UTC(2026, 0, 1, 12, minute, second)).toISOString();

describe('journal views', () => {
  it('reconstructs a table as of any time in its current design', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0); const session = DatabaseSession.create(sqlite); cleanups.push(() => session.close());
    session.createTable('Notes', [{ name: 'text', type: 'TEXT', required: false }]);
    at(1); session.insertRecord('Notes', { text: 'one' });
    at(2); session.insertRecord('Notes', { text: 'two' });
    at(3); session.updateRecord('Notes', '1', { text: 'ONE' });
    at(4); session.deleteRecord('Notes', '2');
    at(5); session.insertRecord('Notes', { text: 'three' }); session.undo();
    expect(session.tableAsOf('Notes', iso(0)).rows).toEqual([]);
    expect(session.tableAsOf('Notes', iso(2)).rows).toEqual([[1n, 'one'], [2n, 'two']]);
    expect(session.tableAsOf('Notes', iso(3)).rows).toEqual([[1n, 'ONE'], [2n, 'two']]);
    expect(session.tableAsOf('Notes', iso(4)).rows).toEqual([[1n, 'ONE']]);
    const latest = session.tableAsOf('Notes', iso(6));
    expect(latest.rows).toEqual([[1n, 'ONE']]); expect(latest.undoneSkipped).toBe(1);
    expect(session.page('Notes').rows).toEqual([[1n, 'ONE']]);
    at(7); session.alterTable('Notes', [{ field: { name: 'body', type: 'TEXT', required: false }, source: 'text' }]);
    expect(() => session.tableAsOf('Notes', iso(6))).toThrow('current design');
    expect(session.tableAsOf('Notes', iso(8)).columns).toEqual(['id', 'body']);
    expect(() => session.tableAsOf('Notes', 'not a time')).toThrow('valid date');
  });

  it('lists still-missing deletions and restores one as an undoable change', () => {
    const session = DatabaseSession.create(sqlite, true); cleanups.push(() => session.close());
    session.deleteRecord('Customers', '1'); session.deleteRecord('Customers', '2');
    const deleted = session.deletedRecords('Customers');
    expect(deleted.map(entry => entry.recordId)).toEqual(['2', '1']);
    expect(deleted[1].values).toEqual([1n, 'Alex Example', 'Boston']);
    session.undoDelete('Customers', deleted[1].eventId, '1');
    expect(session.record('Customers', '1')).toEqual([1n, 'Alex Example', 'Boston']);
    expect(session.deletedRecords('Customers').map(entry => entry.recordId)).toEqual(['2']);
    session.undo();
    expect(session.deletedRecords('Customers').map(entry => entry.recordId)).toEqual(['2', '1']);
  });

  it('offers Undo Delete and Show Table as of from commands', async () => {
    const root = document.createElement('div'); document.body.append(root);
    const registry = createRegistry();
    const pane = mountDatabasePane(root, registry, vi.fn(), vi.fn(), { load: async () => sqlite, download: vi.fn(), confirmDiscard: () => true });
    cleanups.push(pane.dispose);
    [...root.querySelectorAll('button')].find(button => button.textContent === 'Try sample database')!.click();
    await vi.waitFor(() => expect(registry.isAvailable('record.undoDelete')).toBe(true));
    root.querySelector<HTMLInputElement>('input[aria-label="Select record 3"]')!.click();
    registry.execute('record.delete');
    expect(root.querySelector('.datasheet tbody')?.textContent).not.toContain('架空');
    registry.execute('record.undoDelete');
    root.querySelector<HTMLButtonElement>('[aria-label="Restore deleted record 3"]')!.click();
    expect(root.querySelector('.datasheet tbody')?.textContent).toContain('架空');
    expect(root.querySelector<HTMLElement>('.journal-view')?.hidden ?? true).toBe(true);
    registry.execute('data.asOf');
    const form = root.querySelector<HTMLFormElement>('.journal-view form')!;
    form.requestSubmit();
    expect(root.querySelector('.journal-view [role=status]')?.textContent).toContain('3 records as of');
  });
});
