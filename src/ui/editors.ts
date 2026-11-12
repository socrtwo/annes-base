import type { Cell } from '../engine/database';
import { FIELD_TYPES, type Field, type FieldChange, type RecordValues } from '../engine/journal';

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
function label(text: string, input: HTMLElement): HTMLLabelElement {
  input.setAttribute('aria-label', text);
  const node = element('label', text); node.append(input); return node;
}
function editor(container: HTMLElement, title: string, submit: () => void, cancel: () => void, submitLabel: string) {
  container.replaceChildren(); container.hidden = false;
  const heading = element('h3', title);
  heading.tabIndex = -1;
  const form = element('form');
  const error = element('p'); error.setAttribute('role', 'alert');
  const buttons = element('div'); buttons.className = 'editor-actions';
  const save = element('button', submitLabel); save.type = 'submit';
  const back = element('button', 'Cancel editing'); back.type = 'button'; back.addEventListener('click', cancel);
  buttons.append(save, back);
  form.addEventListener('submit', event => {
    event.preventDefault();
    try { submit(); } catch (reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); }
  });
  container.append(heading, form, error);
  heading.focus();
  return { form, buttons };
}

export function tableEditor(container: HTMLElement, save: (name: string, fields: Field[]) => void, cancel: () => void): void {
  const name = element('input'); name.value = 'Table1'; name.required = true; name.maxLength = 64;
  const fields = element('div'); fields.className = 'field-list';
  const controls: { name: HTMLInputElement; type: HTMLSelectElement; required: HTMLInputElement; row: HTMLElement }[] = [];
  const { form, buttons } = editor(container, 'Create table', () => {
    save(name.value, controls.map(field => ({ name: field.name.value, type: field.type.value as Field['type'], required: field.required.checked })));
  }, cancel, 'Create table');
  function addField(fieldName = '', required = false) {
    const row = element('div'); row.className = 'field-definition';
    const input = element('input'); input.value = fieldName; input.required = true; input.maxLength = 64;
    const type = element('select');
    for (const { value, label: title } of FIELD_TYPES) {
      const option = element('option', title); option.value = value; type.append(option);
    }
    const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = required;
    const remove = element('button', 'Remove field'); remove.type = 'button';
    const control = { name: input, type, required: checkbox, row };
    remove.addEventListener('click', () => { controls.splice(controls.indexOf(control), 1); row.remove(); });
    row.append(label('Field name', input), label('Type', type), label('Required', checkbox), remove);
    controls.push(control); fields.append(row);
    return input;
  }
  const add = element('button', 'Add field'); add.type = 'button';
  add.addEventListener('click', () => { if (controls.length < 32) addField().focus(); });
  addField('title', true); addField('notes');
  form.append(label('Table name', name), element('p', 'An automatic integer id is included. Add up to 32 Text, Whole number, Decimal number, Yes/No or Date fields.'), fields, add, buttons);
}

export function recordEditor(container: HTMLElement, fields: Field[], row: Cell[] | undefined, save: (values: RecordValues) => void, cancel: () => void): void {
  const controls: { name: string; input: HTMLTextAreaElement | HTMLInputElement | HTMLSelectElement; nullBox: HTMLInputElement }[] = [];
  const { form, buttons } = editor(container, row ? `Edit record ${String(row[0])}` : 'Add record', () => {
    const values: RecordValues = Object.create(null);
    for (const control of controls) values[control.name] = control.nullBox.checked ? null : control.input.value;
    save(values);
  }, cancel, 'Save record');
  for (const [index, field] of fields.entries()) {
    const value = row?.[index + 1];
    let input: HTMLTextAreaElement | HTMLInputElement | HTMLSelectElement;
    if (field.type === 'BOOLEAN') {
      input = element('select');
      for (const [optionValue, title] of [['1', 'Yes'], ['0', 'No']]) { const option = element('option', title); option.value = optionValue; input.append(option); }
      input.value = value === 1n ? '1' : '0';
    } else if (field.type === 'DATE') {
      input = element('input'); input.type = 'date'; input.value = value == null ? '' : String(value);
    } else {
      input = element('textarea'); input.rows = field.type === 'TEXT' ? 2 : 1;
      if (field.type !== 'TEXT') input.inputMode = field.type === 'INTEGER' ? 'numeric' : 'decimal';
      input.value = value == null ? '' : String(value);
    }
    const control = input;
    const nullBox = element('input'); nullBox.type = 'checkbox'; nullBox.checked = row ? value === null : !field.required;
    nullBox.disabled = field.required;
    const sync = () => { control.disabled = nullBox.checked; control.required = field.required && field.type !== 'TEXT'; };
    nullBox.addEventListener('change', sync); sync();
    const group = element('div'); group.className = 'record-field';
    const typeName = FIELD_TYPES.find(type => type.value === field.type)?.label ?? field.type;
    group.append(label(field.name, input), label(`${field.name}: NULL`, nullBox), element('small', `${typeName}${field.required ? ' · Required' : ''}`));
    form.append(group); controls.push({ name: field.name, input, nullBox });
  }
  form.append(buttons);
}

/** Design view for an existing managed table. Existing fields keep their values; type changes are not offered. */
export function designEditor(container: HTMLElement, table: string, current: Field[], save: (changes: FieldChange[]) => void, cancel: () => void): void {
  const rows = element('div'); rows.className = 'field-list';
  const controls: { source: string | null; name: HTMLInputElement; type: HTMLSelectElement; required: HTMLInputElement; row: HTMLElement }[] = [];
  const { form, buttons } = editor(container, `Design view · ${table}`, () => {
    save(controls.map(control => ({ source: control.source, field: { name: control.name.value, type: control.type.value as Field['type'], required: control.required.checked } })));
  }, cancel, 'Save design');
  const renumber = () => controls.forEach((control, index) => {
    if (rows.children[index] !== control.row) rows.insertBefore(control.row, rows.children[index] ?? null);
    const [up, down] = control.row.querySelectorAll<HTMLButtonElement>('button[data-move]');
    up.disabled = index === 0; down.disabled = index === controls.length - 1;
    up.setAttribute('aria-label', `Move ${control.name.value || 'field'} up`); down.setAttribute('aria-label', `Move ${control.name.value || 'field'} down`);
  });
  function addRow(field: Field, source: string | null) {
    const row = element('div'); row.className = 'field-definition';
    const name = element('input'); name.value = field.name; name.required = true; name.maxLength = 64;
    const type = element('select');
    for (const { value, label: title } of FIELD_TYPES) { const option = element('option', title); option.value = value; type.append(option); }
    type.value = field.type; type.disabled = source !== null;
    const required = element('input'); required.type = 'checkbox'; required.checked = field.required;
    const move = (delta: number) => {
      const index = controls.indexOf(control); const target = index + delta;
      if (target < 0 || target >= controls.length) return;
      [controls[index], controls[target]] = [controls[target], controls[index]]; renumber(); name.focus();
    };
    const up = element('button', 'Up'); up.type = 'button'; up.dataset.move = 'up'; up.addEventListener('click', () => move(-1));
    const down = element('button', 'Down'); down.type = 'button'; down.dataset.move = 'down'; down.addEventListener('click', () => move(1));
    const remove = element('button', source === null ? 'Remove new field' : `Remove ${source}`); remove.type = 'button';
    const control = { source, name, type, required, row };
    remove.addEventListener('click', () => { controls.splice(controls.indexOf(control), 1); row.remove(); renumber(); });
    const origin = element('small', source === null ? 'New field · starts empty' : source === field.name ? 'Existing field' : `Existing field ${source}`);
    name.addEventListener('input', () => { if (source !== null) origin.textContent = name.value === source ? 'Existing field' : `Renamed from ${source}`; });
    row.append(label('Field name', name), label('Type', type), label('Required', required), up, down, remove, origin);
    controls.push(control); rows.append(row); renumber();
    return name;
  }
  for (const field of current) addRow(field, field.name);
  const add = element('button', 'Add field'); add.type = 'button';
  add.addEventListener('click', () => { if (controls.length < 32) addRow({ name: '', type: 'TEXT', required: false }, null).focus(); });
  form.append(element('p', 'Rename, reorder, add or remove fields and change Required. Removing a field deletes its values; Undo brings them back. Existing fields keep their type. The id field is automatic.'), rows, add, buttons);
}
