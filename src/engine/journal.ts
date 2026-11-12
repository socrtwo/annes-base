import type { Database, BindParams } from 'sql.js';
import type { Cell } from './database';

export type FieldType = 'TEXT' | 'INTEGER' | 'REAL' | 'BOOLEAN' | 'DATE';
export interface Field { name: string; type: FieldType; required: boolean }
export const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: 'TEXT', label: 'Text' }, { value: 'INTEGER', label: 'Whole number' }, { value: 'REAL', label: 'Decimal number' },
  { value: 'BOOLEAN', label: 'Yes/No' }, { value: 'DATE', label: 'Date' },
];
/** A redesigned field and the existing field (by name) whose values it keeps, or null for a new empty field. */
export interface FieldChange { field: Field; source: string | null }
export const MAX_IMPORT_ROWS = 200_000;
export const SCHEMA_VERSIONS = ['1-preview', '2-preview', '3-preview'] as const;
const SCHEMA_OPERATIONS = ['createTable', 'alterTable', 'importTable'];
const isDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
};
export type RecordValues = Record<string, string | null>;
export interface HistoryEntry { id: string; operation: string; table: string; recordId: string | null; time: string; undone: boolean }
export interface RecordVersion extends HistoryEntry { before: Cell[] | null; after: Cell[] | null }
export interface RecordHistory {
  columns: string[]; versions: RecordVersion[]; hasMore: boolean;
  currentToken: string | null; restorable: boolean; reason: string;
}
export const quoteName = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const schemas = {
  qb_meta: 'CREATE TABLE qb_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  qb_objects: 'CREATE TABLE qb_objects (name TEXT PRIMARY KEY, fields_json TEXT NOT NULL)',
  qb_journal: 'CREATE TABLE qb_journal (id INTEGER PRIMARY KEY, operation TEXT NOT NULL, table_name TEXT NOT NULL, record_id TEXT, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0)',
};

export function rows(db: Database, sql: string, params: BindParams = []): Cell[][] {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    const reader = statement as typeof statement & { get(params: null, options: { useBigInt: true }): Cell[] };
    const result: Cell[][] = [];
    while (statement.step()) result.push(reader.get(null, { useBigInt: true }));
    return result;
  } finally { statement.free(); }
}

function validName(name: string): void {
  if (!name.trim() || name.length > 64 || /[\x00-\x1f]/.test(name)) throw new Error('Use a name of 1–64 characters without control characters.');
}
function fieldsValid(fields: Field[]): void {
  if (!Array.isArray(fields) || !fields.length || fields.length > 32) throw new Error('Add between 1 and 32 fields.');
  const names = new Set(['id']);
  for (const field of fields) {
    if (!field || typeof field.name !== 'string') throw new Error('Invalid field.');
    validName(field.name);
    if (!FIELD_TYPES.some(type => type.value === field.type) || typeof field.required !== 'boolean') throw new Error('Invalid field type or required setting.');
    const name = field.name.toLowerCase();
    if (names.has(name)) throw new Error('Field names must be unique; id is provided automatically.');
    names.add(name);
  }
}
function columnSql(field: Field): string {
  const name = quoteName(field.name);
  // CHECK constraints keep Yes/No and Date values valid even for SQL written outside the editor.
  const check = field.type === 'BOOLEAN' ? ` CHECK (${name} IN (0, 1))` : field.type === 'DATE' ? ` CHECK (${name} IS date(${name}))` : '';
  return `${name} ${field.type}${field.required ? ' NOT NULL' : ''}${check}`;
}
function tableSql(name: string, fields: Field[]): string {
  return `CREATE TABLE ${quoteName(name)} (id INTEGER PRIMARY KEY, ${fields.map(columnSql).join(', ')})`;
}
const usesVersion3 = (fields: Field[]) => fields.some(field => field.type === 'BOOLEAN' || field.type === 'DATE');
const encodeCell = (cell: Cell) => typeof cell === 'bigint' ? { integer: String(cell) } : cell;
const encode = (row: Cell[] | undefined) => row ? JSON.stringify(row.map(encodeCell)) : null;
function decodeCell(value: any, type: FieldType, nullable: boolean): Cell {
  if (value === null && nullable) return null;
  if ((type === 'INTEGER' || type === 'BOOLEAN') && value && typeof value === 'object' && typeof value.integer === 'string' && value.integer.length <= 20 && /^-?\d+$/.test(value.integer)) {
    const n = BigInt(value.integer);
    if (type === 'BOOLEAN' ? n === 0n || n === 1n : n >= -(2n ** 63n) && n < 2n ** 63n) return n;
  }
  if (type === 'TEXT' && typeof value === 'string') return value;
  if (type === 'DATE' && typeof value === 'string' && isDate(value)) return value;
  if (type === 'REAL' && (typeof value === 'number' && Number.isFinite(value) || value && typeof value === 'object' && typeof value.integer === 'string' && Number.isFinite(Number(value.integer)))) {
    return typeof value === 'number' ? value : Number(value.integer);
  }
  throw new Error('Invalid journal value.');
}
function decode(json: string, fields: Field[]): Cell[] {
  const cells: unknown = JSON.parse(json);
  if (!Array.isArray(cells) || cells.length !== fields.length + 1) throw new Error('Invalid journal record.');
  return cells.map((value, i) => decodeCell(value, i === 0 ? 'INTEGER' : fields[i - 1].type, i > 0 && !fields[i - 1].required));
}
const sameFields = (a: Field[], b: Field[]) => JSON.stringify(a.map(f => [f.name, f.type, f.required])) === JSON.stringify(b.map(f => [f.name, f.type, f.required]));
/** Parses a user-entered value for one field; returns the SQLite binding. */
export function fieldValue(field: Field, value: string | null): string | number | null {
  if (value === null) { if (field.required) throw new Error(`${field.name} is required.`); return null; }
  if (typeof value !== 'string') throw new Error('Field values must be text or null.');
  if (field.type === 'INTEGER') {
    if (!/^[+-]?\d+$/.test(value.trim())) throw new Error(`${field.name} must be a whole number.`);
    const integer = BigInt(value.trim());
    if (integer < -(2n ** 63n) || integer >= 2n ** 63n) throw new Error(`${field.name} is outside the 64-bit integer range.`);
    return String(integer);
  }
  if (field.type === 'REAL') {
    if (!value.trim() || !Number.isFinite(Number(value))) throw new Error(`${field.name} must be a finite decimal number.`);
    return Number(value);
  }
  if (field.type === 'BOOLEAN') {
    const word = value.trim().toLowerCase();
    if (['1', 'yes', 'true', 'on', 'y'].includes(word)) return 1;
    if (['0', 'no', 'false', 'off', 'n'].includes(word)) return 0;
    throw new Error(`${field.name} must be Yes or No.`);
  }
  if (field.type === 'DATE') {
    if (!isDate(value.trim())) throw new Error(`${field.name} must be a date written as YYYY-MM-DD.`);
    return value.trim();
  }
  return value;
}
const bindCells = (cells: Cell[]) => cells.map(cell => typeof cell === 'bigint' ? String(cell) : cell);

/** Writes only supported native schemas; each user mutation and its journal event commit together. */
export class NativeJournal {
  changed = false;
  constructor(private readonly db: Database) {}

  static initialize(db: Database, sample: boolean): NativeJournal {
    db.run(Object.values(schemas).join(';'));
    db.run("INSERT INTO qb_meta VALUES ('application', 'annes-base'), ('schema_version', '2-preview')");
    const journal = new NativeJournal(db);
    if (sample) {
      journal.addTable('Customers', [{ name: 'name', type: 'TEXT', required: true }, { name: 'city', type: 'TEXT', required: false }]);
      journal.addTable('Orders', [{ name: 'customer_id', type: 'INTEGER', required: false }, { name: 'item', type: 'TEXT', required: false }, { name: 'amount_cents', type: 'INTEGER', required: false }]);
      db.run(`INSERT INTO Customers VALUES (1, 'Alex Example', 'Boston'), (2, 'Renée Example', 'Montréal'), (3, '架空 Example', NULL);
        INSERT INTO Orders VALUES (1, 1, 'Notebook', 1250), (2, 2, 'Desk lamp', 4500), (3, 1, 'Folder', 350)`);
    }
    return journal;
  }

  static attach(db: Database): NativeJournal | undefined {
    try {
      if (!(SCHEMA_VERSIONS as readonly string[]).includes(String(rows(db, "SELECT value FROM qb_meta WHERE key='schema_version'")[0]?.[0]))) return undefined;
      for (const [name, sql] of Object.entries(schemas)) {
        if (rows(db, 'SELECT sql FROM sqlite_schema WHERE name=? AND type=\'table\'', [name])[0]?.[0] !== sql) return undefined;
      }
      if (rows(db, "SELECT name FROM sqlite_schema WHERE type='trigger'").length) return undefined;
      return new NativeJournal(db);
    } catch { return undefined; }
  }

  fields(name: string): Field[] {
    const result = rows(this.db, 'SELECT fields_json FROM qb_objects WHERE name=?', [name]);
    if (!result[0]) throw new Error('This table is read-only; its schema is not managed by this preview.');
    const fields: Field[] = JSON.parse(String(result[0][0]));
    fieldsValid(fields);
    if (rows(this.db, "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?", [name])[0]?.[0] !== tableSql(name, fields)) throw new Error('This table has an unsupported or modified schema.');
    return fields;
  }

  private transaction<T>(change: () => T): T {
    this.db.run('PRAGMA query_only=OFF; BEGIN IMMEDIATE');
    try {
      const result = change();
      this.db.run('COMMIT');
      this.changed = true;
      return result;
    } catch (error) { this.db.run('ROLLBACK'); throw error; }
    finally { this.db.run('PRAGMA query_only=ON'); }
  }
  private event(operation: string, table: string, id: string | null, before: string | null, after: string | null): void {
    this.db.run('INSERT INTO qb_journal (operation, table_name, record_id, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', [operation, table, id, before, after, new Date().toISOString()]);
  }
  private addTable(name: string, fields: Field[]): void {
    this.db.run(tableSql(name, fields));
    this.db.run('INSERT INTO qb_objects VALUES (?, ?)', [name, JSON.stringify(fields)]);
  }
  /** Start of the table's lifetime; record ids are never reused after it. */
  private boundary(table: string): string {
    return String(rows(this.db, "SELECT COALESCE(MAX(id),0) FROM qb_journal WHERE table_name=? AND operation IN ('createTable','importTable') AND undone=0", [table])[0][0]);
  }
  /** Start of the table's current design; record images before it use another field list. */
  private designBoundary(table: string): string {
    return String(rows(this.db, `SELECT COALESCE(MAX(id),0) FROM qb_journal WHERE table_name=? AND operation IN (${SCHEMA_OPERATIONS.map(() => '?').join(',')}) AND undone=0`, [table, ...SCHEMA_OPERATIONS])[0][0]);
  }
  private requireVersion3(): void {
    this.db.run("UPDATE qb_meta SET value='3-preview' WHERE key='schema_version'");
  }
  private canonicalId(id: string): string {
    if (id.length > 20 || !/^-?\d+$/.test(id) || BigInt(id) < -(2n ** 63n) || BigInt(id) >= 2n ** 63n) throw new Error('Invalid record or history id.');
    return String(BigInt(id));
  }
  private current(table: string, id: string): Cell[] | undefined {
    return rows(this.db, `SELECT * FROM ${quoteName(table)} WHERE id=?`, [id])[0];
  }
  createTable(name: string, fields: Field[]): void {
    validName(name); fieldsValid(fields);
    if (/^(qb_|sqlite_)/i.test(name)) throw new Error('Names starting with qb_ or sqlite_ are reserved.');
    this.transaction(() => {
      if (usesVersion3(fields)) this.requireVersion3();
      this.addTable(name, fields); this.event('createTable', name, null, null, JSON.stringify(fields));
    });
  }

  /** Imports a new table and its records as one journal event that undoes as a unit. */
  importTable(name: string, fields: Field[], records: (string | null)[][]): number {
    validName(name); fieldsValid(fields);
    if (/^(qb_|sqlite_)/i.test(name)) throw new Error('Names starting with qb_ or sqlite_ are reserved.');
    if (!Array.isArray(records) || records.length > MAX_IMPORT_ROWS) throw new Error(`Import at most ${MAX_IMPORT_ROWS.toLocaleString('en-US')} records.`);
    const bound = records.map((record, index) => {
      if (!Array.isArray(record) || record.length !== fields.length) throw new Error(`Record ${index + 1} has ${record?.length ?? 0} values; expected ${fields.length}.`);
      try { return fields.map((field, column) => fieldValue(field, record[column])); }
      catch (error) { throw new Error(`Record ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
    });
    return this.transaction(() => {
      this.requireVersion3();
      this.addTable(name, fields);
      const statement = this.db.prepare(`INSERT INTO ${quoteName(name)} (id, ${fields.map(f => quoteName(f.name)).join(',')}) VALUES (?, ${fields.map(() => '?').join(',')})`);
      try { bound.forEach((values, index) => { statement.run([index + 1, ...values]); }); }
      finally { statement.free(); }
      this.event('importTable', name, null, null, JSON.stringify({ fields, records: bound.length }));
      return bound.length;
    });
  }

  /**
   * Redesigns an existing table: add, remove, rename, reorder fields and change Required.
   * The table is rebuilt so its stored SQL stays canonical; removed values are journaled for undo.
   */
  alterTable(table: string, changes: FieldChange[]): void {
    const before = this.fields(table);
    if (!Array.isArray(changes)) throw new Error('Invalid table design.');
    const fields = changes.map(change => change?.field);
    fieldsValid(fields);
    const sources = changes.map(change => change.source);
    const used = new Set<string>();
    for (const [index, source] of sources.entries()) {
      if (source === null) continue;
      const original = before.find(field => field.name === source);
      if (typeof source !== 'string' || !original || used.has(source)) throw new Error('Each existing field can be kept only once.');
      if (original.type !== fields[index].type) throw new Error(`${original.name} cannot change type. Add a new field, copy values, then remove the old field.`);
      used.add(source);
    }
    if (sameFields(before, fields) && sources.every((source, index) => source === before[index].name)) throw new Error('The table design has not changed.');
    const dropped = before.filter(field => !used.has(field.name));
    this.transaction(() => {
      const removed = Object.fromEntries(dropped.map(field => [field.name,
        rows(this.db, `SELECT id, ${quoteName(field.name)} FROM ${quoteName(table)} WHERE ${quoteName(field.name)} IS NOT NULL ORDER BY id`).map(([id, value]) => [String(id), encodeCell(value)])]));
      this.requireVersion3();
      try { this.rebuild(table, fields, sources); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/NOT NULL/i.test(message)) throw new Error('A required field would be empty in some records. Leave it optional, fill in the values, then make it required.');
        throw error;
      }
      this.event('alterTable', table, null, JSON.stringify({ fields: before, removed }), JSON.stringify({ fields, sources }));
    });
  }
  private rebuild(table: string, fields: Field[], sources: (string | null)[]): void {
    const temporary = 'qb_rebuild'; // User tables cannot use the reserved qb_ prefix.
    this.db.run(`ALTER TABLE ${quoteName(table)} RENAME TO ${quoteName(temporary)}`);
    this.db.run(tableSql(table, fields));
    const kept = fields.map((field, index) => [field, sources[index]] as const).filter(([, source]) => source !== null);
    this.db.run(`INSERT INTO ${quoteName(table)} (id${kept.map(([field]) => ', ' + quoteName(field.name)).join('')}) SELECT id${kept.map(([, source]) => ', ' + quoteName(source!)).join('')} FROM ${quoteName(temporary)}`);
    this.db.run(`DROP TABLE ${quoteName(temporary)}`);
    this.db.run('UPDATE qb_objects SET fields_json=? WHERE name=?', [JSON.stringify(fields), table]);
  }

  record(table: string, id: string): Cell[] {
    this.fields(table);
    const result = this.current(table, this.canonicalId(id));
    if (!result) throw new Error('The record no longer exists.');
    return result;
  }

  private values(fields: Field[], values: RecordValues): (string | number | null)[] {
    if (Object.keys(values).some(key => !fields.some(field => field.name === key))) throw new Error('Unknown field.');
    return fields.map(field => fieldValue(field, Object.hasOwn(values, field.name) ? values[field.name] ?? null : null));
  }
  insert(table: string, values: RecordValues): string {
    const fields = this.fields(table);
    const params = this.values(fields, values);
    return this.transaction(() => {
      const currentMax = rows(this.db, `SELECT COALESCE(MAX(id),0) FROM ${quoteName(table)}`)[0][0] as bigint;
      const historicMax = rows(this.db, 'SELECT COALESCE(MAX(CAST(record_id AS INTEGER)),0) FROM qb_journal WHERE table_name=? AND id>?', [table, this.boundary(table)])[0][0] as bigint;
      const highest = currentMax > historicMax ? currentMax : historicMax;
      const next = (highest > 0n ? highest : 0n) + 1n;
      if (next >= 2n ** 63n) throw new Error('No unused automatic record ids remain.');
      const id = String(next);
      this.db.run(`INSERT INTO ${quoteName(table)} (id, ${fields.map(f => quoteName(f.name)).join(',')}) VALUES (?, ${fields.map(() => '?').join(',')})`, [id, ...params]);
      this.event('insert', table, id, null, encode(this.record(table, id)));
      return id;
    });
  }
  update(table: string, id: string, values: RecordValues): void {
    id = this.canonicalId(id);
    const fields = this.fields(table);
    const params = this.values(fields, values);
    this.transaction(() => {
      const before = this.record(table, id);
      decode(encode(before)!, fields);
      this.db.run(`UPDATE ${quoteName(table)} SET ${fields.map(f => `${quoteName(f.name)}=?`).join(',')} WHERE id=?`, [...params, id]);
      this.event('update', table, id, encode(before), encode(this.record(table, id)));
    });
  }
  delete(table: string, id: string): void {
    id = this.canonicalId(id);
    const fields = this.fields(table);
    this.transaction(() => {
      const before = this.record(table, id);
      decode(encode(before)!, fields);
      this.db.run(`DELETE FROM ${quoteName(table)} WHERE id=?`, [id]);
      this.event('delete', table, id, encode(before), null);
    });
  }
  history(): HistoryEntry[] {
    return rows(this.db, 'SELECT id, operation, table_name, record_id, created_at, undone FROM qb_journal ORDER BY id DESC LIMIT 100').map(row => ({
      id: String(row[0]), operation: String(row[1]), table: String(row[2]), recordId: row[3] === null ? null : String(row[3]), time: String(row[4]), undone: row[5] === 1n,
    }));
  }
  recordHistory(table: string, recordId: string, beforeEvent?: string): RecordHistory {
    const fields = this.fields(table); const id = this.canonicalId(recordId); const boundary = this.designBoundary(table);
    const where = 'table_name=? AND record_id=? AND id>?';
    const params = [table, id, boundary];
    const actual = this.current(table, id);
    const reused = Number(rows(this.db, `SELECT COUNT(*) FROM qb_journal WHERE ${where} AND operation='insert'`, params)[0][0]) > 1;
    const latest = rows(this.db, `SELECT operation, after_json FROM qb_journal WHERE ${where} AND undone=0 ORDER BY id DESC LIMIT 1`, params)[0];
    const earliest = latest ? undefined : rows(this.db, `SELECT operation, before_json FROM qb_journal WHERE ${where} ORDER BY id LIMIT 1`, params)[0];
    const expected = latest ?? earliest;
    let tracked = true;
    if (expected) {
      if (!['insert', 'update', 'delete', 'restore'].includes(String(expected[0]))) throw new Error('Unsupported record history operation.');
      tracked = encode(actual) === (expected[1] === null ? null : encode(decode(String(expected[1]), fields)));
    }
    const limit = beforeEvent === undefined ? '' : ' AND id<?';
    const values = beforeEvent === undefined ? params : [...params, this.canonicalId(beforeEvent)];
    const history = rows(this.db, `SELECT id, operation, record_id, created_at, undone, before_json, after_json FROM qb_journal WHERE ${where}${limit} ORDER BY id DESC LIMIT 51`, values);
    const versions = history.slice(0, 50).map(row => {
      if (!['insert', 'update', 'delete', 'restore'].includes(String(row[1]))) throw new Error('Unsupported record history operation.');
      const before = row[5] === null ? null : decode(String(row[5]), fields);
      const after = row[6] === null ? null : decode(String(row[6]), fields);
      if ([before, after].some(image => image && String(image[0]) !== id)) throw new Error('Invalid journal record id.');
      return { id: String(row[0]), operation: String(row[1]), table, recordId: id, time: String(row[3]), undone: row[4] === 1n, before, after };
    });
    return {
      columns: ['id', ...fields.map(field => field.name)], versions, hasMore: history.length > 50,
      currentToken: encode(actual), restorable: !reused && tracked,
      reason: reused ? 'This id was reused in an older file. History may include different records; selective restore is disabled.'
        : !tracked ? 'The record changed outside its journal. Selective restore is disabled.' : '',
    };
  }
  restoreVersion(table: string, recordId: string, eventId: string, side: 'before' | 'after', expectedCurrent: string | null): void {
    const fields = this.fields(table); const id = this.canonicalId(recordId); const event = this.canonicalId(eventId);
    if (!['before', 'after'].includes(side)) throw new Error('Choose before or after values.');
    const entry = rows(this.db, 'SELECT operation, before_json, after_json FROM qb_journal WHERE id=? AND table_name=? AND record_id=? AND id>?', [event, table, id, this.designBoundary(table)])[0];
    if (!entry) throw new Error('This change does not belong to the current table and record.');
    if (!['insert', 'update', 'delete', 'restore'].includes(String(entry[0]))) throw new Error('Unsupported record history operation.');
    const image = entry[side === 'before' ? 1 : 2];
    if (image === null) throw new Error('This version has no record values to restore.');
    const saved = decode(String(image), fields);
    if (String(saved[0]) !== id) throw new Error('Invalid journal record id.');
    this.transaction(() => {
      const history = this.recordHistory(table, id);
      if (!history.restorable) throw new Error(history.reason);
      if (history.currentToken !== expectedCurrent) throw new Error('The record changed after history was opened. Refresh its history before restoring.');
      const before = this.current(table, id);
      if (before) this.db.run(`UPDATE ${quoteName(table)} SET ${fields.map(f => `${quoteName(f.name)}=?`).join(',')} WHERE id=?`, [...bindCells(saved.slice(1)), id]);
      else this.db.run(`INSERT INTO ${quoteName(table)} (id, ${fields.map(f => quoteName(f.name)).join(',')}) VALUES (${saved.map(() => '?').join(',')})`, bindCells(saved));
      this.db.run("UPDATE qb_meta SET value='2-preview' WHERE key='schema_version' AND value='1-preview'");
      this.event('restore', table, id, encode(before), encode(this.record(table, id)));
    });
  }
  canUndo(): boolean { return rows(this.db, 'SELECT id FROM qb_journal WHERE undone=0 LIMIT 1').length > 0; }
  undo(): void {
    const entry = rows(this.db, 'SELECT id, operation, table_name, record_id, before_json, after_json FROM qb_journal WHERE undone=0 ORDER BY id DESC LIMIT 1')[0];
    if (!entry) throw new Error('Nothing to undo.');
    const [eventId, operation, name, recordId, before, after] = entry;
    const table = String(name);
    const fields = this.fields(table);
    this.transaction(() => {
      if (operation === 'createTable') {
        if (JSON.stringify(fields) !== after || rows(this.db, `SELECT id FROM ${quoteName(table)} LIMIT 1`).length) throw new Error('The table changed outside its journal; undo was stopped.');
        this.db.run(`DROP TABLE ${quoteName(table)}`);
        this.db.run('DELETE FROM qb_objects WHERE name=?', [table]);
      } else if (operation === 'importTable') {
        const saved = JSON.parse(String(after));
        const count = rows(this.db, `SELECT COUNT(*), COALESCE(MIN(id),1), COALESCE(MAX(id),0) FROM ${quoteName(table)}`)[0];
        if (!sameFields(fields, saved.fields) || count[0] !== BigInt(saved.records) || count[1] !== 1n || count[2] !== BigInt(saved.records)) throw new Error('The imported table changed outside its journal; undo was stopped.');
        this.db.run(`DROP TABLE ${quoteName(table)}`);
        this.db.run('DELETE FROM qb_objects WHERE name=?', [table]);
      } else if (operation === 'alterTable') {
        const previous = JSON.parse(String(before)); const next = JSON.parse(String(after));
        if (!sameFields(fields, next.fields)) throw new Error('The table design changed outside its journal; undo was stopped.');
        fieldsValid(previous.fields);
        const sources: (string | null)[] = next.sources;
        for (const [index, source] of sources.entries()) {
          if (source === null && rows(this.db, `SELECT 1 FROM ${quoteName(table)} WHERE ${quoteName(fields[index].name)} IS NOT NULL LIMIT 1`).length) {
            throw new Error(`${fields[index].name} has values that were entered outside the journal; undo was stopped.`);
          }
        }
        const reverse = (previous.fields as Field[]).map(field => {
          const index = sources.indexOf(field.name);
          return index >= 0 ? fields[index].name : null;
        });
        // Removed fields come back empty first and receive their journaled values below.
        const relaxed = (previous.fields as Field[]).map((field, index) => reverse[index] === null ? { ...field, required: false } : field);
        this.rebuild(table, relaxed, reverse);
        for (const [index, field] of (previous.fields as Field[]).entries()) {
          if (reverse[index] !== null) continue;
          const values: [string, unknown][] = previous.removed?.[field.name] ?? [];
          for (const [id, value] of values) {
            this.db.run(`UPDATE ${quoteName(table)} SET ${quoteName(field.name)}=? WHERE id=?`, [bindCells([decodeCell(value, field.type, false)])[0], this.canonicalId(id)]);
            if (this.db.getRowsModified() !== 1) throw new Error('A record changed outside its journal; undo was stopped.');
          }
        }
        if (relaxed.some((field, index) => field.required !== previous.fields[index].required)) this.rebuild(table, previous.fields, previous.fields.map((field: Field) => field.name));
      } else if (operation === 'insert' || operation === 'update' || operation === 'restore') {
        if (encode(this.record(table, String(recordId))) !== after) throw new Error('The record changed outside its journal; undo was stopped.');
        if (operation === 'insert' || operation === 'restore' && before === null) this.db.run(`DELETE FROM ${quoteName(table)} WHERE id=?`, [String(recordId)]);
        else {
          const saved = decode(String(before), fields);
          if (String(saved[0]) !== String(recordId)) throw new Error('Invalid journal record id.');
          this.db.run(`UPDATE ${quoteName(table)} SET ${fields.map(f => `${quoteName(f.name)}=?`).join(',')} WHERE id=?`, [...bindCells(saved.slice(1)), String(recordId)]);
        }
      } else if (operation === 'delete') {
        const saved = decode(String(before), fields);
        if (String(saved[0]) !== String(recordId)) throw new Error('Invalid journal record id.');
        this.db.run(`INSERT INTO ${quoteName(table)} (id, ${fields.map(f => quoteName(f.name)).join(',')}) VALUES (${saved.map(() => '?').join(',')})`, bindCells(saved));
      } else throw new Error('Unsupported journal operation.');
      this.db.run('UPDATE qb_journal SET undone=1 WHERE id=?', [String(eventId)]);
    });
  }
}
