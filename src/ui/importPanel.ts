import { planDelimitedImport, planJsonImport, type ImportPlan } from '../engine/exchange';
import { FIELD_TYPES, type Field } from '../engine/journal';
import type { Relationship } from '../engine/database';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;
};
function label(text: string, input: HTMLElement) { input.setAttribute('aria-label', text); const value = node('label', text); value.append(input); return value; }
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
export interface ImportSource { name: string; size: number; text(): Promise<string> }

/** Previews a text or JSON file as a new table; nothing is written until Import is confirmed. */
export function mountImportPanel(host: HTMLElement, canImport: () => boolean, importTable: (name: string, fields: Field[], records: (string | null)[][]) => void) {
  host.className = 'import-panel'; host.hidden = true; host.setAttribute('aria-label', 'Import data');
  const heading = node('h3', 'Import data as a new table'); heading.tabIndex = -1;
  const help = node('p', 'Choose a CSV, tab-delimited or JSON file. The first row (or the JSON keys) names the fields. Review the field types before importing; the import is one change that Undo removes completely. Limits: 32 columns, 200,000 records, 32 MiB.');
  const input = node('input'); input.type = 'file'; input.accept = '.csv,.tsv,.tab,.txt,.json,text/csv,text/plain,application/json';
  const delimiter = node('select');
  for (const [value, text] of [['', 'Detect automatically'], [',', 'Comma'], ['\t', 'Tab'], [';', 'Semicolon'], ['|', 'Vertical bar']]) { const option = node('option', text); option.value = value; delimiter.append(option); }
  const status = node('p'); status.setAttribute('role', 'status');
  const error = node('p'); error.setAttribute('role', 'alert');
  const preview = node('form'); preview.className = 'import-preview';
  let text = ''; let fileName = ''; let plan: ImportPlan | undefined;
  const close = node('button', 'Close import'); close.type = 'button'; close.addEventListener('click', () => { host.hidden = true; });
  function build() {
    preview.replaceChildren(); error.textContent = ''; plan = undefined;
    if (!text) return;
    try {
      plan = /\.json$/i.test(fileName) || /^\s*[[{]/.test(text) && !delimiter.value ? planJsonImport(fileName, text) : planDelimitedImport(fileName, text, delimiter.value || undefined);
    } catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); return; }
    const current = plan;
    const name = node('input'); name.value = current.name; name.maxLength = 64; name.required = true;
    preview.append(label('New table name', name));
    for (const warning of current.warnings) preview.append(node('p', warning));
    const controls = current.fields.map((field, index) => {
      const row = node('div'); row.className = 'field-definition';
      const fieldName = node('input'); fieldName.value = field.name; fieldName.maxLength = 64; fieldName.required = true;
      const type = node('select');
      for (const option of FIELD_TYPES) { const item = node('option', option.label); item.value = option.value; type.append(item); }
      type.value = field.type;
      const sample = current.records.find(record => record[index] !== null)?.[index];
      row.append(label(`Field ${index + 1} name`, fieldName), label(`Field ${index + 1} type`, type), node('small', sample == null ? 'All values are empty' : `Example: ${sample.slice(0, 60)}`));
      preview.append(row);
      return { fieldName, type };
    });
    const submit = node('button', `Import ${current.records.length.toLocaleString('en-US')} records`); submit.type = 'submit';
    preview.append(submit);
    status.textContent = `${fileName}: ${current.fields.length} fields and ${current.records.length.toLocaleString('en-US')} records found. Nothing has been imported yet.`;
    preview.onsubmit = event => {
      event.preventDefault(); error.textContent = '';
      if (!canImport()) { error.textContent = 'Open an editable native database to import into.'; return; }
      try {
        importTable(name.value, controls.map(control => ({ name: control.fieldName.value, type: control.type.value as Field['type'], required: false })), current.records);
        status.textContent = `Imported ${current.records.length.toLocaleString('en-US')} records into ${name.value}. Undo removes the whole import.`;
        preview.replaceChildren(); text = ''; plan = undefined;
      } catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); }
    };
  }
  async function choose(file: ImportSource) {
    error.textContent = ''; preview.replaceChildren(); text = ''; plan = undefined;
    if (file.size > MAX_IMPORT_BYTES) { error.textContent = 'Import files are limited to 32 MiB.'; return; }
    try { text = await file.text(); fileName = file.name; build(); }
    catch (reason) { error.textContent = `Cannot read this file: ${reason instanceof Error ? reason.message : String(reason)}`; }
  }
  input.addEventListener('change', () => { const file = input.files?.[0]; input.value = ''; if (file) void choose(file); });
  delimiter.addEventListener('change', build);
  host.append(heading, help, label('File to import', input), label('Delimiter', delimiter), status, error, preview, close);
  return {
    show() { host.hidden = false; host.scrollIntoView?.({ block: 'start' }); heading.focus(); },
    choose,
    get plan() { return plan; },
  };
}

/** Lists declared relationships as text and a simple diagram of the tables they connect. */
export function showRelationships(host: HTMLElement, tables: string[], relationships: Relationship[], editable: boolean, close: () => void) {
  host.replaceChildren(); host.hidden = false; host.className = 'relationships'; host.setAttribute('aria-label', 'Relationships');
  const heading = node('h3', 'Relationships'); heading.tabIndex = -1;
  host.append(heading);
  if (!relationships.length) {
    host.append(node('p', editable
      ? 'This database has no declared relationships. Native tables do not support defining relationships yet; enforced relationships arrive with the Relationships designer.'
      : 'This database declares no foreign keys between its tables.'));
  } else {
    const list = node('ul');
    for (const item of relationships) {
      list.append(node('li', `${item.table} (${item.columns.join(', ')}) → ${item.referencedTable} (${item.referencedColumns.join(', ')}) · on update ${item.onUpdate.toLowerCase()} · on delete ${item.onDelete.toLowerCase()}`));
    }
    host.append(list, diagram(tables, relationships));
  }
  const dismiss = node('button', 'Close relationships'); dismiss.type = 'button'; dismiss.addEventListener('click', close);
  host.append(dismiss); heading.focus(); host.scrollIntoView?.({ block: 'start' });
}

function diagram(tables: string[], relationships: Relationship[]): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const involved = tables.filter(table => relationships.some(item => item.table === table || item.referencedTable === table));
  const width = 180; const height = 36; const gap = 60; const columns = Math.max(1, Math.min(4, involved.length));
  const position = new Map(involved.map((table, index) => [table, { x: 10 + (index % columns) * (width + gap), y: 10 + Math.floor(index / columns) * (height + gap) }]));
  const svg = document.createElementNS(namespace, 'svg');
  const rowsCount = Math.ceil(involved.length / columns);
  svg.setAttribute('viewBox', `0 0 ${20 + columns * (width + gap) - gap} ${20 + rowsCount * (height + gap) - gap}`);
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Relationship diagram'); svg.classList.add('relationship-diagram');
  for (const item of relationships) {
    const from = position.get(item.table); const to = position.get(item.referencedTable);
    if (!from || !to) continue;
    const line = document.createElementNS(namespace, 'line');
    line.setAttribute('x1', String(from.x + width / 2)); line.setAttribute('y1', String(from.y + height / 2));
    line.setAttribute('x2', String(to.x + width / 2)); line.setAttribute('y2', String(to.y + height / 2));
    svg.append(line);
  }
  for (const [table, { x, y }] of position) {
    const rect = document.createElementNS(namespace, 'rect');
    rect.setAttribute('x', String(x)); rect.setAttribute('y', String(y)); rect.setAttribute('width', String(width)); rect.setAttribute('height', String(height)); rect.setAttribute('rx', '6');
    const text = document.createElementNS(namespace, 'text');
    text.setAttribute('x', String(x + width / 2)); text.setAttribute('y', String(y + height / 2 + 5)); text.setAttribute('text-anchor', 'middle');
    text.textContent = table.length > 22 ? table.slice(0, 21) + '…' : table;
    svg.append(rect, text);
  }
  return svg;
}
