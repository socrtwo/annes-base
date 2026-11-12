import type { Cell } from './database';
import { fieldValue, MAX_IMPORT_ROWS, quoteName, type Field, type FieldType } from './journal';

export const MAX_IMPORT_FIELDS = 32;
export interface ImportPlan { name: string; fields: Field[]; records: (string | null)[][]; warnings: string[] }
export interface ExportData { name: string; columns: string[]; types: string[]; rows: Cell[][] }

/** RFC 4180 CSV with quoted fields, doubled quotes, CRLF/LF/CR line ends and an optional BOM. */
export function parseDelimited(text: string, delimiter = detectDelimiter(text)): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records: string[][] = [];
  let record: string[] = []; let field = ''; let quoted = false; let index = 0; let started = false;
  const endField = () => { record.push(field); field = ''; started = false; };
  const endRecord = () => { endField(); if (record.length > 1 || record[0] !== '') records.push(record); record = []; };
  while (index < text.length) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 2; continue; }
        quoted = false; index++; continue;
      }
      field += character; index++; continue;
    }
    if (character === '"' && !started && field === '') { quoted = true; started = true; index++; continue; }
    if (character === delimiter) { endField(); index++; continue; }
    if (character === '\r' || character === '\n') {
      endRecord(); index += character === '\r' && text[index + 1] === '\n' ? 2 : 1; continue;
    }
    field += character; started = true; index++;
  }
  if (quoted) throw new Error('A quoted value is not closed; check the file for a missing quotation mark.');
  if (field !== '' || record.length) endRecord();
  return records;
}

export function detectDelimiter(text: string): string {
  const line = text.replace(/^﻿/, '').split(/\r\n|\n|\r/, 1)[0] ?? '';
  let best = ','; let bestCount = 0;
  for (const candidate of [',', '\t', ';', '|']) {
    let count = 0; let quoted = false;
    for (const character of line) { if (character === '"') quoted = !quoted; else if (!quoted && character === candidate) count++; }
    if (count > bestCount) { best = candidate; bestCount = count; }
  }
  return best;
}

function fieldNames(header: string[]): { names: string[]; warnings: string[] } {
  const used = new Set(['id']); const warnings: string[] = [];
  const names = header.map((raw, index) => {
    let name = String(raw ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 60) || `Field${index + 1}`;
    if (used.has(name.toLowerCase())) {
      let suffix = 2;
      while (used.has(`${name}_${suffix}`.toLowerCase())) suffix++;
      warnings.push(`Column “${name}” was renamed to “${name}_${suffix}” because names must be unique and id is automatic.`);
      name = `${name}_${suffix}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
  return { names, warnings };
}

const integerPattern = /^[+-]?\d+$/;
const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
/** Chooses the narrowest field type that accepts every non-empty value. */
export function inferType(values: (string | null)[]): FieldType {
  const present = values.filter((value): value is string => value !== null);
  if (!present.length) return 'TEXT';
  const accepts = (type: FieldType) => present.every(value => { try { fieldValue({ name: 'value', type, required: false }, value); return true; } catch { return false; } });
  if (present.every(value => integerPattern.test(value.trim()))) {
    // Codes such as 02134 or long account numbers keep every character as text.
    return present.some(value => /^[+-]?0\d/.test(value.trim())) || !accepts('INTEGER') ? 'TEXT' : 'INTEGER';
  }
  if (present.every(value => numberPattern.test(value.trim())) && accepts('REAL')) return 'REAL';
  if (present.every(value => /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) && accepts('DATE')) return 'DATE';
  if (present.every(value => ['true', 'false', 'yes', 'no'].includes(value.trim().toLowerCase()))) return 'BOOLEAN';
  return 'TEXT';
}

function plan(name: string, header: string[], body: (string | null)[][], warnings: string[] = []): ImportPlan {
  if (!header.length) throw new Error('The file has no columns to import.');
  if (header.length > MAX_IMPORT_FIELDS) throw new Error(`This file has ${header.length} columns; import supports up to ${MAX_IMPORT_FIELDS}.`);
  if (body.length > MAX_IMPORT_ROWS) throw new Error(`This file has ${body.length.toLocaleString('en-US')} records; import supports up to ${MAX_IMPORT_ROWS.toLocaleString('en-US')}.`);
  const named = fieldNames(header);
  const records = body.map((record, index) => {
    if (record.length > header.length) throw new Error(`Record ${index + 1} has ${record.length} values but the header has ${header.length} columns.`);
    return header.map((_, column) => record[column] ?? null);
  });
  const fields = named.names.map((fieldName, column) => ({ name: fieldName, type: inferType(records.map(record => record[column])), required: false }));
  const tableName = name.replace(/\.[^.]+$/, '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 64) || 'Imported';
  return { name: /^(qb_|sqlite_)/i.test(tableName) ? `Imported ${tableName}`.slice(0, 64) : tableName, fields, records, warnings: [...warnings, ...named.warnings] };
}

/** Plans a delimited-text import. The first row names the fields; empty values become NULL. */
export function planDelimitedImport(fileName: string, text: string, delimiter?: string): ImportPlan {
  const [header, ...body] = parseDelimited(text, delimiter);
  if (!header) throw new Error('The file is empty.');
  const short = body.filter(record => record.length < header.length).length;
  const warnings = short ? [`${short} records have fewer values than the header; missing values are NULL.`] : [];
  return plan(fileName, header, body.map(record => record.map(value => value === '' ? null : value)), warnings);
}

/** Plans a JSON import from an array of flat objects (nested values are stored as JSON text). */
export function planJsonImport(fileName: string, text: string): ImportPlan {
  let value: unknown;
  try { value = JSON.parse(text.replace(/^﻿/, '')); } catch (error) { throw new Error(`This is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const arrays = Object.values(value).filter(Array.isArray);
    if (arrays.length === 1) value = arrays[0];
  }
  if (!Array.isArray(value)) throw new Error('Import JSON expects an array of records, such as [{"name": "Alex"}].');
  const header: string[] = []; const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Every JSON record must be an object of field names and values.');
    for (const key of Object.keys(item)) if (!seen.has(key)) { seen.add(key); header.push(key); }
  }
  let unsafe = false;
  const body = value.map((item: Record<string, unknown>) => header.map(key => {
    const cell = item[key];
    if (cell === null || cell === undefined) return null;
    if (typeof cell === 'boolean') return cell ? 'true' : 'false';
    if (typeof cell === 'number') { if (Number.isInteger(cell) && !Number.isSafeInteger(cell)) unsafe = true; return String(cell); }
    if (typeof cell === 'string') return cell;
    return JSON.stringify(cell);
  }));
  return plan(fileName, header, body, unsafe ? ['Some whole numbers exceed 2^53 and lost precision when the JSON was read. Store them as quoted text to keep every digit.'] : []);
}

const blobHex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const blobBase64 = (bytes: Uint8Array) => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
const isBoolean = (type: string) => type.toUpperCase() === 'BOOLEAN';

export function toDelimited(data: ExportData, delimiter = ','): string {
  const quote = (text: string) => /["\r\n]|^\s|\s$/.test(text) || text.includes(delimiter) ? '"' + text.replaceAll('"', '""') + '"' : text;
  const cell = (value: Cell) => value === null ? '' : value instanceof Uint8Array ? blobBase64(value) : String(value);
  return [data.columns, ...data.rows.map(row => row.map(cell))].map(row => row.map(quote).join(delimiter)).join('\r\n') + '\r\n';
}

function jsonValue(value: Cell, type: string): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return isBoolean(type) && (value === 0n || value === 1n) ? String(value === 1n) : String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (value instanceof Uint8Array) return JSON.stringify({ base64: blobBase64(value) });
  return JSON.stringify(value);
}
/** JSON array of objects. Whole numbers are written with every digit, beyond JavaScript's safe range. */
export function toJson(data: ExportData): string {
  const lines = data.rows.map(row => '  {' + data.columns.map((column, index) => `${JSON.stringify(column)}: ${jsonValue(row[index], data.types[index])}`).join(', ') + '}');
  return lines.length ? '[\n' + lines.join(',\n') + '\n]\n' : '[]\n';
}

const escapeMarkup = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const markupValue = (value: Cell) => value instanceof Uint8Array ? `BLOB · ${value.byteLength} bytes` : String(value);
export function toHtml(data: ExportData): string {
  const head = data.columns.map(column => `<th scope="col">${escapeMarkup(column)}</th>`).join('');
  const body = data.rows.map(row => '<tr>' + row.map(value => value === null ? '<td></td>' : `<td>${escapeMarkup(markupValue(value))}</td>`).join('') + '</tr>').join('\n');
  return `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${escapeMarkup(data.name)}</title></head>\n<body>\n<table>\n<caption>${escapeMarkup(data.name)}</caption>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>\n</body>\n</html>\n`;
}
export function toXml(data: ExportData): string {
  // Field names are attributes, so any column name is representable without element-name mangling.
  const records = data.rows.map(row => '  <record>\n' + row.map((value, index) => {
    const name = escapeMarkup(data.columns[index]);
    if (value === null) return `    <field name="${name}" null="true"/>`;
    if (value instanceof Uint8Array) return `    <field name="${name}" encoding="base64">${blobBase64(value)}</field>`;
    return `    <field name="${name}">${escapeMarkup(String(value)).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, character => `&#x${character.charCodeAt(0).toString(16)};`)}</field>`;
  }).join('\n') + '\n  </record>').join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<table name="${escapeMarkup(data.name)}">\n${records}${records ? '\n' : ''}</table>\n`;
}

export function sqlLiteral(value: Cell): string {
  if (value === null) return 'NULL';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value > 0 ? '9e999' : value < 0 ? '-9e999' : 'NULL';
    const text = String(value);
    return /[.eE]/.test(text) ? text : text + '.0';
  }
  if (value instanceof Uint8Array) return `X'${blobHex(value)}'`;
  return "'" + value.replaceAll("'", "''") + "'";
}
export interface ScriptObject { type: string; name: string; table: string; sql: string }
/** A plain SQL script that recreates the given schema objects and their rows in any SQLite database. */
export function toSqlScript(objects: ScriptObject[], tableRows: (table: string) => { columns: string[]; rows: Iterable<Cell[]> }, source: string): string {
  const lines = [`-- SQL script exported by Anne's Base from ${source.replace(/[\r\n]/g, ' ')}`, `-- ${new Date().toISOString()}`, 'BEGIN TRANSACTION;'];
  const order = ['table', 'index', 'view', 'trigger'];
  for (const object of [...objects].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))) {
    lines.push(object.sql.trimEnd() + ';');
    if (object.type !== 'table') continue;
    const { columns, rows } = tableRows(object.name);
    const names = columns.map(quoteName).join(', ');
    for (const row of rows) lines.push(`INSERT INTO ${quoteName(object.name)} (${names}) VALUES (${row.map(sqlLiteral).join(', ')});`);
  }
  lines.push('COMMIT;', '');
  return lines.join('\n');
}
