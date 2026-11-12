import type { Cell, DatabaseSession } from '../engine/database';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;
};
const display = (value: Cell) => value === null ? 'NULL' : value === '' ? '(empty text)' : value instanceof Uint8Array ? `BLOB · ${value.byteLength} bytes` : String(value).slice(0, 2000);
function button(text: string, action: () => void) { const value = node('button', text); value.type = 'button'; value.addEventListener('click', action); return value; }
function valuesTable(caption: string, columns: string[], rows: Cell[][], action?: (row: Cell[], index: number) => HTMLElement) {
  const wrapper = node('div'); wrapper.className = 'datasheet-scroll'; wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', caption);
  const table = node('table'); table.append(node('caption', caption));
  const head = node('tr'); if (action) { const th = node('th', 'Action'); th.scope = 'col'; head.append(th); }
  for (const column of columns) { const th = node('th', column); th.scope = 'col'; head.append(th); }
  const thead = node('thead'); thead.append(head);
  const body = node('tbody');
  rows.forEach((row, index) => {
    const tr = node('tr');
    if (action) { const td = node('td'); td.append(action(row, index)); tr.append(td); }
    for (const value of row) { const td = node('td', display(value)); if (value === null) td.className = 'null-cell'; tr.append(td); }
    body.append(tr);
  });
  table.append(thead, body); wrapper.append(table);
  return wrapper;
}

/** Undo Delete: deleted records of the current design that are still absent, restorable one at a time. */
export function showDeletedRecords(host: HTMLElement, session: DatabaseSession, table: string, restore: (eventId: string, recordId: string) => void, close: () => void) {
  host.replaceChildren(); host.hidden = false; host.className = 'journal-view'; host.setAttribute('aria-label', 'Undo Delete');
  const heading = node('h3', `Undo Delete · ${table}`); heading.tabIndex = -1;
  host.append(heading, node('p', 'Deleted records that are still missing, newest deletion first. Restoring brings back the record with its original id as a new change that can itself be undone; other records are not affected.'));
  const error = node('p'); error.setAttribute('role', 'alert');
  const deleted = session.deletedRecords(table);
  if (!deleted.length) host.append(node('p', 'No deleted records to bring back in this table’s current design.'));
  else {
    const fields = ['id', ...session.fields(table).map(field => field.name)];
    host.append(valuesTable('Deleted records', ['Deleted', ...fields], deleted.map(entry => [new Date(entry.time).toLocaleString(), ...entry.values]), (_, index) => {
      const entry = deleted[index];
      const control = button('Restore', () => { try { restore(entry.eventId, entry.recordId); } catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); } });
      control.setAttribute('aria-label', `Restore deleted record ${entry.recordId}`);
      return control;
    }));
  }
  host.append(error, button('Close Undo Delete', close));
  heading.focus(); host.scrollIntoView?.({ block: 'start' });
}

const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);

/** Show Table as of: a read-only reconstruction from the journal. */
export function showTableAsOf(host: HTMLElement, session: DatabaseSession, table: string, close: () => void) {
  host.replaceChildren(); host.hidden = false; host.className = 'journal-view'; host.setAttribute('aria-label', 'Show table as of');
  const heading = node('h3', `Show ${table} as of…`); heading.tabIndex = -1;
  const form = node('form');
  const input = node('input'); input.type = 'datetime-local'; input.step = '1'; input.required = true; input.value = localInput(new Date());
  input.setAttribute('aria-label', 'Date and time');
  const label = node('label', 'Date and time'); label.append(input);
  const submit = node('button', 'Show table'); submit.type = 'submit';
  form.append(label, submit);
  const status = node('p'); status.setAttribute('role', 'status');
  const error = node('p'); error.setAttribute('role', 'alert');
  const result = node('div');
  form.addEventListener('submit', event => {
    event.preventDefault(); error.textContent = ''; result.replaceChildren(); status.textContent = '';
    try {
      const when = new Date(input.value);
      if (Number.isNaN(when.getTime())) throw new Error('Choose a valid date and time.');
      const view = session.tableAsOf(table, when.toISOString());
      result.append(valuesTable(`${table} as of ${when.toLocaleString()}`, view.columns, view.rows));
      status.textContent = `${view.rows.length.toLocaleString('en-US')} records as of ${when.toLocaleString()}. This view is read-only and reflects the journal's active changes${view.undoneSkipped ? `; ${view.undoneSkipped} undone changes are left out` : ''}.`;
    } catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); }
  });
  host.append(heading, node('p', 'Rebuilds the table from the change journal for any time since its current design. Changes made outside the journal and changes that were undone are not shown.'), form, status, error, result, button('Close table as of', close));
  heading.focus(); host.scrollIntoView?.({ block: 'start' });
}
