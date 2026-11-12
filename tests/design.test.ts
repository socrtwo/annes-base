import { readFileSync } from 'node:fs';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSession } from '../src/engine/database';
import type { Field } from '../src/engine/journal';

let sqlite: SqlJsStatic;
const sessions: DatabaseSession[] = [];
beforeAll(async () => { sqlite = await initSqlJs({ wasmBinary: Uint8Array.from(readFileSync('node_modules/sql.js/dist/sql-wasm.wasm')).buffer }); });
afterEach(() => sessions.splice(0).forEach(session => session.close()));
const track = (session: DatabaseSession) => { sessions.push(session); return session; };
const reopen = (session: DatabaseSession) => track(DatabaseSession.open(sqlite, session.exportCopy(), 'reopened.qbase'));
const version = (session: DatabaseSession) => session.query("SELECT value FROM qb_meta WHERE key='schema_version'").rows[0][0];

describe('field types', () => {
  it('stores Yes/No and Date fields with validation and CHECK constraints', () => {
    const session = track(DatabaseSession.create(sqlite));
    expect(version(session)).toBe('2-preview');
    const fields: Field[] = [{ name: 'done', type: 'BOOLEAN', required: true }, { name: 'due', type: 'DATE', required: false }];
    session.createTable('Tasks', fields);
    expect(version(session)).toBe('3-preview');
    session.insertRecord('Tasks', { done: 'Yes', due: '2024-02-29' });
    session.insertRecord('Tasks', { done: 'false', due: null });
    expect(session.page('Tasks').rows).toEqual([[1n, 1n, '2024-02-29'], [2n, 0n, null]]);
    expect(() => session.insertRecord('Tasks', { done: 'maybe' })).toThrow('Yes or No');
    expect(() => session.insertRecord('Tasks', { done: '1', due: '2023-02-29' })).toThrow('YYYY-MM-DD');
    expect(() => session.insertRecord('Tasks', { done: '1', due: '12/01/2024' })).toThrow('YYYY-MM-DD');
    expect(session.columns('Tasks').map(column => column.kind)).toEqual(['integer', 'integer', 'date']);
    expect(session.page('Tasks', 0, { filter: { column: 'due', operator: 'gt', value: '2024-01-01' } }).rows).toHaveLength(1);
    const copy = reopen(session);
    expect(copy.editable).toBe(true);
    copy.updateRecord('Tasks', '2', { done: 'yes', due: '2025-12-31' });
    expect(copy.record('Tasks', '2')).toEqual([2n, 1n, '2025-12-31']);
    copy.undo(); expect(copy.record('Tasks', '2')).toEqual([2n, 0n, null]);
  });
});

describe('table design changes', () => {
  function sample() {
    const session = track(DatabaseSession.create(sqlite));
    session.createTable('People', [{ name: 'name', type: 'TEXT', required: true }, { name: 'age', type: 'INTEGER', required: false }, { name: 'city', type: 'TEXT', required: false }]);
    session.insertRecord('People', { name: 'Ana', age: '9007199254740993', city: 'Lima' });
    session.insertRecord('People', { name: 'Bo', age: null, city: 'Oslo' });
    return session;
  }

  it('adds, renames, removes and reorders fields, then undoes back to the exact data', () => {
    const session = sample();
    const before = session.page('People').rows;
    session.alterTable('People', [
      { field: { name: 'town', type: 'TEXT', required: false }, source: 'city' },
      { field: { name: 'full name', type: 'TEXT', required: true }, source: 'name' },
      { field: { name: 'member', type: 'BOOLEAN', required: false }, source: null },
    ]);
    expect(session.columns('People').map(column => column.name)).toEqual(['id', 'town', 'full name', 'member']);
    expect(session.page('People').rows).toEqual([[1n, 'Lima', 'Ana', null], [2n, 'Oslo', 'Bo', null]]);
    expect(session.canEditTable('People')).toBe(true);
    session.updateRecord('People', '1', { town: 'Cusco', 'full name': 'Ana', member: 'yes' });
    expect(session.history()[0].operation).toBe('update');
    const copy = reopen(session);
    copy.undo(); copy.undo();
    expect(copy.columns('People').map(column => column.name)).toEqual(['id', 'name', 'age', 'city']);
    expect(copy.page('People').rows).toEqual(before);
    expect(copy.canEditTable('People')).toBe(true);
    copy.insertRecord('People', { name: 'Cy' });
    expect(copy.page('People').rows.at(-1)?.[0]).toBe(3n);
  });

  it('keeps record ids unique across redesigns and starts record history at the current design', () => {
    const session = sample();
    session.deleteRecord('People', '2');
    session.alterTable('People', [{ field: { name: 'name', type: 'TEXT', required: true }, source: 'name' }]);
    expect(session.insertRecord('People', { name: 'Dee' })).toBe('3');
    const history = session.recordHistory('People', '3');
    expect(history.versions.map(version => version.operation)).toEqual(['insert']);
    expect(session.recordHistory('People', '1').versions).toEqual([]);
  });

  it('refuses unsafe or empty redesigns without changing the table', () => {
    const session = sample();
    const rows = session.page('People').rows;
    const keep = (name: string, type: Field['type'] = 'TEXT', required = false) => ({ field: { name, type, required }, source: name });
    expect(() => session.alterTable('People', [keep('name', 'TEXT', true), keep('age'), keep('city')])).toThrow('cannot change type');
    expect(() => session.alterTable('People', [keep('name', 'TEXT', true), keep('age', 'INTEGER', true), keep('city')])).toThrow('required field would be empty');
    expect(() => session.alterTable('People', [keep('name', 'TEXT', true), { field: { name: 'x', type: 'TEXT', required: true }, source: null }])).toThrow('required field would be empty');
    expect(() => session.alterTable('People', [keep('name', 'TEXT', true), keep('name', 'TEXT', true)])).toThrow();
    expect(() => session.alterTable('People', [keep('name', 'TEXT', true), keep('age', 'INTEGER'), keep('city')])).toThrow('not changed');
    expect(() => session.alterTable('People', [{ field: { name: 'x', type: 'TEXT', required: false }, source: 'missing' }])).toThrow('kept only once');
    expect(session.page('People').rows).toEqual(rows);
    expect(session.history()).toHaveLength(3);
  });

  it('makes a field required when every record has a value, and undo relaxes it again', () => {
    const session = sample();
    session.alterTable('People', [{ field: { name: 'name', type: 'TEXT', required: true }, source: 'name' }, { field: { name: 'city', type: 'TEXT', required: true }, source: 'city' }]);
    expect(() => session.insertRecord('People', { name: 'Eve' })).toThrow('city is required');
    session.undo();
    expect(session.fields('People').map(field => [field.name, field.required])).toEqual([['name', true], ['age', false], ['city', false]]);
    expect(session.record('People', '1')).toEqual([1n, 'Ana', 9007199254740993n, 'Lima']);
    session.alterTable('People', [{ field: { name: 'city', type: 'TEXT', required: false }, source: 'city' }]);
    expect(session.page('People').rows).toEqual([[1n, 'Lima'], [2n, 'Oslo']]);
    session.undo();
    expect(session.fields('People')[0]).toEqual({ name: 'name', type: 'TEXT', required: true });
    expect(session.page('People').rows).toEqual([[1n, 'Ana', 9007199254740993n, 'Lima'], [2n, 'Bo', null, 'Oslo']]);
  });
});

describe('table import', () => {
  it('imports records as a single undoable event', () => {
    const session = track(DatabaseSession.create(sqlite));
    const count = session.importTable('Imported', [{ name: 'code', type: 'TEXT', required: false }, { name: 'qty', type: 'INTEGER', required: false }], [['007', '3'], [null, '-9223372036854775808']]);
    expect(count).toBe(2);
    expect(session.page('Imported').rows).toEqual([[1n, '007', 3n], [2n, null, -9223372036854775808n]]);
    expect(session.history().map(entry => entry.operation)).toEqual(['importTable']);
    session.insertRecord('Imported', { code: 'x' });
    const copy = reopen(session);
    copy.undo(); copy.undo();
    expect(copy.tables()).toEqual([]);
    expect(() => session.importTable('Bad', [{ name: 'qty', type: 'INTEGER', required: false }], [['abc']])).toThrow('Record 1: qty must be a whole number');
    expect(() => session.importTable('qb_x', [{ name: 'a', type: 'TEXT', required: false }], [])).toThrow('reserved');
    expect(session.tables()).toEqual(['Imported']);
  });
});
