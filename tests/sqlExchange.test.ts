import { readFileSync } from 'node:fs';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSession } from '../src/engine/database';
import { formatSql, leadingKeyword, splitStatements } from '../src/engine/sqlQuery';
import { detectDelimiter, inferType, parseDelimited, planDelimitedImport, planJsonImport, sqlLiteral, toDelimited, toHtml, toJson, toXml } from '../src/engine/exchange';

let sqlite: SqlJsStatic;
const sessions: DatabaseSession[] = [];
beforeAll(async () => { sqlite = await initSqlJs({ wasmBinary: Uint8Array.from(readFileSync('node_modules/sql.js/dist/sql-wasm.wasm')).buffer }); });
afterEach(() => sessions.splice(0).forEach(session => session.close()));
function open(sql: string, name = 'test.sqlite') { const db = new sqlite.Database(); db.run(sql); const session = DatabaseSession.open(sqlite, db.export(), name); db.close(); sessions.push(session); return session; }

describe('read-only SQL view', () => {
  it('splits statements outside literals and comments', () => {
    expect(splitStatements("SELECT ';' AS a; -- x;\n SELECT \"b;\" FROM [c;d] /* ; */;")).toEqual(["SELECT ';' AS a", '-- x;\n SELECT "b;" FROM [c;d] /* ; */']);
    expect(splitStatements('  ;  ; ')).toEqual([]);
    expect(() => splitStatements("SELECT 'open")).toThrow('closing quote');
    expect(leadingKeyword('/* c */ -- d\n  with x as (select 1) select * from x')).toBe('WITH');
  });

  it('runs SELECT with exact integers and a row limit, and refuses every write path', () => {
    const session = DatabaseSession.create(sqlite, true); sessions.push(session);
    const result = session.query('SELECT name, 9223372036854775807 AS big FROM Customers ORDER BY id');
    expect(result.columns).toEqual(['name', 'big']);
    expect(result.rows[0]).toEqual(['Alex Example', 9223372036854775807n]);
    expect(session.query('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n) SELECT x FROM n').truncated).toBe(true);
    for (const sql of ['PRAGMA query_only = OFF', 'DELETE FROM Customers', 'SELECT 1; PRAGMA query_only=OFF', 'SELECT 1; DELETE FROM Customers', "ATTACH ':memory:' AS x", 'EXPLAIN PRAGMA query_only=OFF', 'VACUUM']) {
      expect(() => session.query(sql), sql).toThrow();
    }
    expect(() => session.query('WITH x AS (SELECT 1) DELETE FROM Customers')).toThrow('read-only');
    expect(session.query('SELECT COUNT(*) FROM Customers').rows[0][0]).toBe(3n);
    expect(session.hasChanges).toBe(false);
    // The journaled editor still works afterward, proving query_only was restored rather than left off.
    session.insertRecord('Customers', { name: 'New' });
    expect(session.query('SELECT COUNT(*) FROM Customers').rows[0][0]).toBe(4n);
    expect(() => session.query("SELECT * FROM pragma_table_info('Customers')")).not.toThrow();
  });

  it('explains plans and formats SQL without touching literals', () => {
    const session = open('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT); CREATE INDEX tb ON t(b);');
    const plan = session.explain("SELECT * FROM t WHERE b = 'x'");
    expect(plan.some(step => /INDEX tb/.test(step.detail))).toBe(true);
    expect(formatSql("select a from t left join u on 1 where b = 'from where' order by a")).toBe("SELECT a\nFROM t\nLEFT JOIN u on 1\nWHERE b = 'from where'\nORDER BY a");
  });
});

describe('import and export', () => {
  it('parses RFC 4180 text and detects delimiters', () => {
    expect(parseDelimited('﻿a,b\r\n"x, ""y""",2\n"multi\nline",\n')).toEqual([['a', 'b'], ['x, "y"', '2'], ['multi\nline', '']]);
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\n')).toBe('\t');
    expect(() => parseDelimited('"open')).toThrow('not closed');
  });

  it('infers safe field types and plans unique names', () => {
    expect(inferType(['1', '-2', null])).toBe('INTEGER');
    expect(inferType(['02134', '1'])).toBe('TEXT');
    expect(inferType(['99999999999999999999'])).toBe('TEXT');
    expect(inferType(['1.5', '2'])).toBe('REAL');
    expect(inferType(['2024-01-31'])).toBe('DATE');
    expect(inferType(['2024-02-31'])).toBe('TEXT');
    expect(inferType(['Yes', 'no'])).toBe('BOOLEAN');
    const plan = planDelimitedImport('people.csv', 'id,Name,name,\n1,Ana,x\n');
    expect(plan.name).toBe('people');
    expect(plan.fields.map(field => [field.name, field.type])).toEqual([['id_2', 'INTEGER'], ['Name', 'TEXT'], ['name_2', 'TEXT'], ['Field4', 'TEXT']]);
    expect(plan.records).toEqual([['1', 'Ana', 'x', null]]);
    expect(() => planDelimitedImport('x.csv', 'a\n1,2\n')).toThrow('header has 1');
    const json = planJsonImport('data.json', '{"records":[{"a":1,"b":true},{"a":2,"c":{"d":1}}]}');
    expect(json.fields.map(field => [field.name, field.type])).toEqual([['a', 'INTEGER'], ['b', 'BOOLEAN'], ['c', 'TEXT']]);
    expect(json.records).toEqual([['1', 'true', null], ['2', null, '{"d":1}']]);
    expect(planJsonImport('n.json', '[{"n": 12345678901234567890}]').warnings[0]).toContain('precision');
    expect(() => planJsonImport('x.json', '[1]')).toThrow('object');
  });

  it('round-trips an import plan through the journaled native table', () => {
    const session = DatabaseSession.create(sqlite); sessions.push(session);
    const plan = planDelimitedImport('orders.csv', 'code,when,paid,amount\n007,2024-05-01,yes,1.5\n,2024-05-02,no,\n');
    session.importTable(plan.name, plan.fields, plan.records);
    expect(session.page('orders').rows).toEqual([[1n, '007', '2024-05-01', 1n, 1.5], [2n, null, '2024-05-02', 0n, null]]);
  });

  it('exports exact values to CSV, JSON, HTML and XML', () => {
    const data = { name: 'T<1>', columns: ['n', 'flag', 'text', 'blob'], types: ['INTEGER', 'BOOLEAN', 'TEXT', 'BLOB'], rows: [[9223372036854775807n, 1n, 'a,"b"\n', new Uint8Array([255, 0])], [null, 0n, '<x>&', null]] };
    expect(toDelimited(data)).toBe('n,flag,text,blob\r\n9223372036854775807,1,"a,""b""\n",/wA=\r\n,0,<x>&,\r\n');
    expect(toJson(data)).toBe('[\n  {"n": 9223372036854775807, "flag": true, "text": "a,\\"b\\"\\n", "blob": {"base64":"/wA="}},\n  {"n": null, "flag": false, "text": "<x>&", "blob": null}\n]\n');
    expect(toHtml(data)).toContain('<td>&lt;x&gt;&amp;</td>');
    expect(toHtml(data)).toContain('<title>T&lt;1&gt;</title>');
    expect(toXml(data)).toContain('<field name="n" null="true"/>');
    expect(toXml(data)).toContain('<field name="blob" encoding="base64">/wA=</field>');
    expect(toJson({ ...data, rows: [] })).toBe('[]\n');
  });

  it('writes a SQL script that recreates schema and rows exactly', () => {
    const session = open(`CREATE TABLE "it's" (id INTEGER PRIMARY KEY, r REAL, t TEXT, b BLOB, g INTEGER GENERATED ALWAYS AS (id * 2));
      CREATE INDEX it_t ON "it's"(t); CREATE VIEW v AS SELECT t FROM "it's";
      INSERT INTO "it's" (id, r, t, b) VALUES (9223372036854775807, 1.0, 'O''Neil', X'00FF'), (2, 0.1, NULL, NULL);`);
    const script = session.sqlScript();
    expect(sqlLiteral(1)).toBe('1.0'); expect(sqlLiteral(1e300)).toBe('1e+300');
    const db = new sqlite.Database(); db.run(script);
    const copy = DatabaseSession.open(sqlite, db.export(), 'copy.sqlite'); db.close(); sessions.push(copy);
    expect(copy.page("it's").rows).toEqual(session.page("it's").rows);
    expect(copy.query('SELECT typeof(r) FROM "it\'s" ORDER BY id').rows).toEqual([['real'], ['real']]);
    expect(copy.query("SELECT name FROM sqlite_schema WHERE type IN ('index','view') ORDER BY name").rows).toEqual([['it_t'], ['v']]);
    const native = DatabaseSession.create(sqlite, true); sessions.push(native);
    expect(native.sqlScript()).not.toContain('qb_journal');
    expect(native.exportData('Customers', { sorts: [{ column: 'name', direction: 'DESC' }] }).rows.map(row => row[1])).toEqual(['架空 Example', 'Renée Example', 'Alex Example']);
  });

  it('lists declared foreign keys as relationships', () => {
    const session = open('CREATE TABLE a (id INTEGER PRIMARY KEY, x, y, UNIQUE(x, y)); CREATE TABLE b (id INTEGER PRIMARY KEY, a_id REFERENCES a ON DELETE CASCADE, p, q, FOREIGN KEY (p, q) REFERENCES a(x, y));');
    expect(session.relationships()).toEqual(expect.arrayContaining([
      { table: 'b', columns: ['a_id'], referencedTable: 'a', referencedColumns: ['(primary key)'], onUpdate: 'NO ACTION', onDelete: 'CASCADE' },
      { table: 'b', columns: ['p', 'q'], referencedTable: 'a', referencedColumns: ['x', 'y'], onUpdate: 'NO ACTION', onDelete: 'NO ACTION' },
    ]));
  });

  it('computes sample standard deviation and variance', () => {
    const session = open('CREATE TABLE v (id INTEGER PRIMARY KEY, n INTEGER, t TEXT); INSERT INTO v VALUES (1,2,"a"),(2,4,"b"),(3,4,NULL),(4,4,NULL),(5,5,NULL),(6,5,NULL),(7,7,NULL),(8,9,NULL);');
    const result = session.totals('v', [{ column: 'n', operation: 'variance' }, { column: 'id', operation: 'stdev' }]);
    expect(result.values[0].value).toBeCloseTo(32 / 7, 12);
    expect(result.values[1].value).toBeCloseTo(Math.sqrt(6), 12);
    expect(session.totals('v', [{ column: 'n', operation: 'stdev' }], { filter: { column: 'id', operator: 'equals', value: '1' } }).values[0].value).toBeNull();
    expect(() => session.totals('v', [{ column: 't', operation: 'stdev' }])).toThrow('supported total');
  });
});
