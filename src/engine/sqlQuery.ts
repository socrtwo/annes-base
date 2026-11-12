import type { Database } from 'sql.js';
import type { Cell } from './database';

export const MAX_QUERY_ROWS = 1000;
export const MAX_QUERY_LENGTH = 100_000;
export interface QueryResult { columns: string[]; rows: Cell[][]; truncated: boolean; elapsedMs: number }
export interface PlanStep { id: number; parent: number; detail: string }

/**
 * Splits SQL into top-level statements without preparing it. Comments, string literals and
 * quoted identifiers are skipped so that semicolons inside them are not statement breaks.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0; let index = 0; let meaningful = false;
  const push = (end: number) => { if (meaningful) statements.push(sql.slice(start, end).trim()); meaningful = false; };
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === '-' && next === '-') { const end = sql.indexOf('\n', index); index = end < 0 ? sql.length : end + 1; continue; }
    if (character === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end < 0) throw new Error('A /* comment is not closed.');
      index = end + 2; continue;
    }
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      const close = character === '[' ? ']' : character;
      let position = index + 1;
      for (;;) {
        const found = sql.indexOf(close, position);
        if (found < 0) throw new Error(character === "'" ? 'A text value is missing its closing quote.' : 'A quoted name is missing its closing quote.');
        if (close !== ']' && sql[found + 1] === close) { position = found + 2; continue; }
        position = found + 1; break;
      }
      meaningful = true; index = position; continue;
    }
    if (character === ';') { push(index); start = index + 1; index++; continue; }
    if (!/\s/.test(character)) meaningful = true;
    index++;
  }
  push(sql.length);
  return statements;
}

/** The first keyword of a statement, ignoring leading comments. */
export function leadingKeyword(statement: string): string {
  const stripped = statement.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, '');
  return (/^[A-Za-z]+/.exec(stripped)?.[0] ?? '').toUpperCase();
}

function readOnlyStatement(sql: string): string {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('Type a SELECT statement to run.');
  if (sql.length > MAX_QUERY_LENGTH) throw new Error('Queries are limited to 100,000 characters.');
  const statements = splitStatements(sql);
  if (statements.length !== 1) throw new Error(statements.length ? 'Run one statement at a time.' : 'Type a SELECT statement to run.');
  const keyword = leadingKeyword(statements[0]);
  if (!['SELECT', 'WITH', 'VALUES'].includes(keyword)) {
    throw new Error('The SQL view runs read-only SELECT, WITH and VALUES statements. Use the table commands to change data so every change is journaled and can be undone.');
  }
  return statements[0];
}

function assertQueryOnly(db: Database): void {
  // Defense in depth: writes are refused by SQLite itself while query_only is on.
  if (db.exec('PRAGMA query_only')[0]?.values[0]?.[0] !== 1) throw new Error('The database is not in read-only query mode; the query was not run.');
}

/** Runs one read-only statement and returns at most MAX_QUERY_ROWS rows with exact integers. */
export function runReadOnlyQuery(db: Database, sql: string, limit = MAX_QUERY_ROWS): QueryResult {
  const statementSql = readOnlyStatement(sql);
  assertQueryOnly(db);
  const started = performance.now();
  const statement = db.prepare(statementSql);
  try {
    assertQueryOnly(db);
    const reader = statement as typeof statement & { get(params: null, options: { useBigInt: true }): Cell[] };
    const rows: Cell[][] = [];
    let truncated = false;
    while (statement.step()) {
      if (rows.length >= limit) { truncated = true; break; }
      rows.push(reader.get(null, { useBigInt: true }));
    }
    return { columns: statement.getColumnNames(), rows, truncated, elapsedMs: performance.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/readonly|read-only/i.test(message)) throw new Error('The SQL view is read-only. Use the table commands to change data so every change is journaled.');
    throw error;
  } finally { statement.free(); db.run('PRAGMA query_only = ON'); }
}

/** Returns SQLite's query plan for one read-only statement without running it. */
export function explainQuery(db: Database, sql: string): PlanStep[] {
  const statementSql = readOnlyStatement(sql);
  assertQueryOnly(db);
  const statement = db.prepare('EXPLAIN QUERY PLAN ' + statementSql);
  try {
    const steps: PlanStep[] = [];
    while (statement.step()) {
      const [id, parent, , detail] = statement.get();
      steps.push({ id: Number(id), parent: Number(parent), detail: String(detail) });
    }
    return steps;
  } finally { statement.free(); db.run('PRAGMA query_only = ON'); }
}

/** A light formatter that puts major clauses on their own lines; literals are preserved. */
export function formatSql(sql: string): string {
  const clauses = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'UNION ALL', 'UNION', 'EXCEPT', 'INTERSECT', 'LEFT JOIN', 'INNER JOIN', 'CROSS JOIN', 'JOIN', 'WITH', 'VALUES'];
  const parts: string[] = [];
  let index = 0; let plain = '';
  const flush = () => {
    if (!plain) return;
    const pattern = new RegExp(`\\b(${clauses.map(clause => clause.replace(' ', '\\s+')).join('|')})\\b`, 'gi');
    parts.push(plain.replace(/\s+/g, ' ').replace(pattern, match => '\n' + match.toUpperCase().replace(/\s+/g, ' '))); plain = '';
  };
  while (index < sql.length) {
    const character = sql[index];
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      const close = character === '[' ? ']' : character;
      let end = index + 1;
      for (;;) {
        const found = sql.indexOf(close, end);
        if (found < 0) { end = sql.length; break; }
        if (close !== ']' && sql[found + 1] === close) { end = found + 2; continue; }
        end = found + 1; break;
      }
      flush(); parts.push(sql.slice(index, end)); index = end; continue;
    }
    if (character === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index); const stop = end < 0 ? sql.length : end + 1;
      flush(); parts.push(sql.slice(index, stop)); index = stop; continue;
    }
    plain += character; index++;
  }
  flush();
  return parts.join('').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}
