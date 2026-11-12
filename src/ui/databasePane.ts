import type { SqlJsStatic } from 'sql.js';
import type { CommandRegistry } from '../commands/registry';
import { DatabaseSession, MAX_DATABASE_BYTES, PAGE_SIZE, type Cell } from '../engine/database';
import { designEditor, recordEditor, tableEditor } from './editors';
import { mountSqlView } from './sqlView';
import { mountImportPanel, showRelationships } from './importPanel';
import { showDeletedRecords, showTableAsOf } from './journalViews';
import { toDelimited, toHtml, toJson, toXml } from '../engine/exchange';
import { IndexedDbRecoveryStore, type RecoveryMetadata, type RecoveryStore } from '../storage/recovery';
import { DocumentAutosave } from '../storage/autosave';
import { tableControls } from './tableControls';
import { sortLevels, filterConditions, type TableView } from '../engine/tableView';
import { showRecordHistory } from './recordHistory';
import { IndexedDbSnapshotStore, type SnapshotStore } from '../storage/snapshots';
import type { PreferenceStorage } from '../prefs';
import { mountSnapshots } from './snapshots';
import { IndexedDbSavedViewStore, type SavedViewStore } from '../storage/savedViews';
import { mountSavedViews } from './savedViews';
import { totalsRow } from './totalsRow';
import type { TableTotals, TotalChoice } from '../engine/totals';

export interface DatabaseDependencies {
  load: () => Promise<SqlJsStatic>;
  download: (bytes: Uint8Array, name: string, type?: string) => void;
  confirmDiscard?: () => boolean;
  recovery?: RecoveryStore;
  snapshots?: SnapshotStore;
  savedViews?: SavedViewStore;
  snapshotPreferences?: PreferenceStorage;
}
const defaultDependencies: DatabaseDependencies = {
  recovery: new IndexedDbRecoveryStore(),
  snapshots: new IndexedDbSnapshotStore(),
  savedViews: new IndexedDbSavedViewStore(),
  snapshotPreferences: { getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value) },
  load: async () => (await import('../engine/browser')).loadSqlite(),
  download: (bytes, name, type = 'application/vnd.sqlite3') => {
    const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }
  },
};

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

export function mountDatabasePane(
  container: HTMLElement,
  registry: CommandRegistry,
  changed: (name: string | undefined, busy: boolean) => void,
  showWorkspace: () => void,
  dependencies: DatabaseDependencies = defaultDependencies,
): { openFile: (file: File, readOnly?: boolean) => Promise<void>; dispose: () => void } {
  let session: DatabaseSession | undefined;
  let selected: string | undefined;
  let offset = 0;
  let busy = false;
  let disposed = false;
  let selectedRecord: string | undefined;
  let draftChanged = false;
  let openAsReadOnly = false;
  let autosave: DocumentAutosave | undefined;
  let snapshotDocumentId: string | undefined;
  let snapshots: ReturnType<typeof mountSnapshots> | undefined;
  const snapshotPanel = node('section'); snapshotPanel.hidden = true;
  const savedViewsPanel = node('section'); savedViewsPanel.hidden = true;
  let savedViews: ReturnType<typeof mountSavedViews> | undefined;
  let recoveryEntries: RecoveryMetadata[] = [];
  let recoveryError = '';
  let listing = 0;
  let recoveryBusy = false;
  let view: TableView = {};
  let filterEnabled = true;
  let totalsEnabled = false;
  let totalChoices: TotalChoice[] = [];
  let dataRevision = 0;
  let totalContext: { session: DatabaseSession | undefined; table: string | undefined } | undefined;
  let totalCache: { key: string; result: TableTotals } | undefined;
  const effectiveView = () => ({ ...view, filter: filterEnabled ? view.filter : undefined, filters: filterEnabled ? view.filters : undefined });
  const resetView = () => { view = {}; filterEnabled = true; };
  const recoveryStore = dependencies.recovery;
  const pane = node('section');
  pane.className = 'database-pane';
  pane.setAttribute('aria-label', 'Database workspace');
  const title = node('h2', 'Your database workspace');
  const message = node('p', 'Create a blank database, try the sample, or open a SQLite file from your device.');
  message.setAttribute('role', 'status');
  const actions = node('div');
  actions.className = 'database-actions';
  const button = (text: string, action: () => void) => {
    const control = node('button', text);
    control.addEventListener('click', () => { if (!disposed) action(); });
    actions.append(control);
    return control;
  };
  const input = node('input');
  input.type = 'file';
  input.accept = '.qbase,.sqlite,.sqlite3,.db,application/vnd.sqlite3,application/x-sqlite3';
  input.hidden = true;
  input.setAttribute('aria-label', 'Open SQLite database');
  const grid = node('div');
  grid.className = 'database-grid';
  const navigation = node('nav');
  navigation.setAttribute('aria-label', 'Database tables');
  const data = node('div');
  data.className = 'datasheet';
  const tools = node('section'); tools.className = 'table-tools'; tools.setAttribute('aria-label', 'Sort, filter and find');
  const note = node('p', 'Native edits autosave as recovery copies in this browser when storage is available. Unfinished forms are not autosaved. Keep downloaded backups: browser storage can be cleared or evicted. Other SQLite files are read-only. Limit: 32 MiB.');
  note.className = 'database-note';
  const editing = node('section'); editing.className = 'database-editor'; editing.hidden = true;
  editing.setAttribute('aria-label', 'Database editor');
  const history = node('details'); history.className = 'change-history';
  const recordHistory = node('section'); recordHistory.className = 'record-history'; recordHistory.hidden = true;
  recordHistory.setAttribute('aria-label', 'Record history');
  const closeHistory = () => { recordHistory.hidden = true; recordHistory.replaceChildren(); };
  const sqlPanel = node('section');
  const importHost = node('section');
  const relationshipsHost = node('section'); relationshipsHost.hidden = true;
  const closeRelationships = () => { relationshipsHost.hidden = true; relationshipsHost.replaceChildren(); };
  const journalHost = node('section'); journalHost.hidden = true;
  const closeJournalView = () => { journalHost.hidden = true; journalHost.replaceChildren(); };
  const recovery = node('section'); recovery.className = 'browser-recovery';
  recovery.setAttribute('aria-label', 'Browser recovery copies'); recovery.hidden = !recoveryStore;
  const recoveryHeading = node('h3', 'Browser recovery copies'); recoveryHeading.tabIndex = -1;
  const autosaveStatus = node('p'); autosaveStatus.setAttribute('role', 'status');
  const recoveryList = node('ul'); recoveryList.className = 'recovery-list';
  const retry = node('button', 'Retry browser autosave');
  retry.addEventListener('click', () => { if (session && autosave && !busy) autosave.save(session); });
  recovery.append(recoveryHeading, autosaveStatus, retry, recoveryList);
  const needsProtection = () => draftChanged || !!session?.hasChanges && autosave?.state.status !== 'saved';
  const confirmDiscard = () => (dependencies.confirmDiscard ?? (() => window.confirm('There are unsaved changes. Discard those changes?')))();
  const discard = () => !needsProtection() || confirmDiscard();
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (needsProtection() || snapshots?.isSaving || savedViews?.isSaving) { event.preventDefault(); event.returnValue = ''; }
  };
  window.addEventListener('beforeunload', beforeUnload);
  editing.addEventListener('input', () => { draftChanged = true; renderRecovery(); snapshots?.contextChanged(); });
  const cancelEditing = () => { editing.replaceChildren(); editing.hidden = true; draftChanged = false; renderRecovery(); snapshots?.contextChanged(); };
  function apply(change: () => void) {
    if (busy) throw new Error('Wait for the database to finish loading.');
    const snapshot = snapshots?.beforeChange();
    change(); dataRevision++; totalCache = undefined;
    if (snapshot) snapshots?.saveAutomatic(snapshot);
    cancelEditing(); closeHistory(); closeJournalView(); selectedRecord = undefined;
    if (selected && !session!.tables().includes(selected)) { selected = session!.tables()[0]; offset = 0; resetView(); }
    if (selected && offset > 0 && !session!.page(selected, offset, effectiveView()).rows.length) offset = Math.max(0, offset - PAGE_SIZE);
    message.textContent = 'Change recorded in the journal.';
    if (session && autosave) autosave.save(session);
    render();
  }
  async function refreshRecovery() {
    if (!recoveryStore || disposed) return;
    const request = ++listing;
    try {
      const entries = await recoveryStore.list();
      if (disposed || request !== listing) return;
      recoveryEntries = entries; recoveryError = '';
    } catch (error) {
      if (disposed || request !== listing) return;
      recoveryError = error instanceof Error ? error.message : String(error);
    }
    renderRecovery(); changed(session?.name, busy);
  }
  function renderRecovery() {
    if (disposed) return;
    retry.hidden = autosave?.state.status !== 'error'; retry.disabled = busy;
    if (autosave?.state.status === 'saved') autosaveStatus.textContent = 'Saved in this browser. Download a copy for a portable backup.';
    else if (autosave?.state.status === 'saving') autosaveStatus.textContent = 'Saving a browser recovery copy… Keep this page open until it finishes.';
    else if (autosave?.state.status === 'error') autosaveStatus.textContent = `Browser autosave failed: ${autosave.state.message} Download a copy to keep your changes.`;
    else autosaveStatus.textContent = recoveryError ? `Browser recovery unavailable: ${recoveryError}` : 'Committed edits to native databases are saved only in this browser on this site.';
    if (draftChanged) autosaveStatus.textContent += ' The current form has unsaved edits.';
    recoveryList.replaceChildren();
    for (const entry of recoveryEntries) {
      const item = node('li');
      const description = node('span', `${entry.name} · ${new Date(entry.savedAt).toLocaleString()}${entry.id === autosave?.id ? ' · Open' : ''}`);
      const restore = node('button', 'Restore copy');
      restore.setAttribute('aria-label', `Restore ${entry.name}`);
      restore.disabled = busy || recoveryBusy || entry.id === autosave?.id && autosave.state.status !== 'error';
      restore.addEventListener('click', () => { void restoreRecovery(entry.id); });
      const remove = node('button', 'Remove copy');
      remove.setAttribute('aria-label', `Remove browser copy of ${entry.name}`);
      remove.disabled = busy || recoveryBusy || entry.id === autosave?.id;
      remove.addEventListener('click', () => { void removeRecovery(entry); });
      item.append(description, restore, remove); recoveryList.append(item);
    }
    if (!recoveryEntries.length) recoveryList.append(node('li', 'No browser recovery copies yet.'));
  }
  function connectAutosave(restored?: RecoveryMetadata) {
    autosave = undefined;
    snapshotDocumentId = session?.editable ? crypto.randomUUID() : undefined;
    if (!recoveryStore || !session?.editable) return;
    const saver = new DocumentAutosave(recoveryStore, () => {
      if (disposed) return;
      if (autosave === saver) renderRecovery();
      if (saver.state.status === 'saved') void refreshRecovery();
    }, restored);
    autosave = saver; snapshotDocumentId = saver.id;
    if (!restored) saver.save(session);
  }
  async function restoreRecovery(id: string) {
    if (!recoveryStore || recoveryBusy) return;
    let recovered: RecoveryMetadata | undefined;
    await replace(async () => {
      const snapshot = await recoveryStore.read(id);
      const restored = DatabaseSession.open(await dependencies.load(), new Uint8Array(snapshot.bytes), snapshot.name);
      if (snapshot.pendingDownload && restored.editable) restored.markRecoveredChanges();
      recovered = snapshot;
      return restored;
    }, () => recovered);
  }
  async function removeRecovery(entry: RecoveryMetadata) {
    if (!recoveryStore || busy || recoveryBusy || entry.id === autosave?.id) return;
    recoveryBusy = true; renderRecovery();
    try { await recoveryStore.remove(entry.id, entry.revision); message.textContent = 'Browser recovery copy removed. Downloaded files were not changed.'; }
    catch (error) { message.textContent = `Cannot remove this copy: ${error instanceof Error ? error.message : String(error)}`; }
    finally { recoveryBusy = false; if (!disposed) await refreshRecovery(); }
  }
  const report = (action: () => void) => { try { action(); } catch (error) { message.textContent = error instanceof Error ? error.message : String(error); } };
  function openRecordHistory(table = selected, id = selectedRecord) {
    if (!session || !table || !session.canEditTable(table) || busy || draftChanged && !confirmDiscard()) return;
    cancelEditing(); showWorkspace();
    showRecordHistory(recordHistory, session, table, id, (recordId, eventId, side, token) => {
      apply(() => { session!.restoreVersion(table, recordId, eventId, side, token); selected = table; offset = 0; resetView(); });
      message.textContent = `Record ${recordId} restored. The restore can be undone.`;
    }, closeHistory);
  }
  function createTable() {
    if (!session?.editable || busy) return;
    if (draftChanged && !confirmDiscard()) return;
    draftChanged = false;
    showWorkspace();
    tableEditor(editing, (name, fields) => apply(() => { session!.createTable(name, fields); selected = name; offset = 0; resetView(); }), cancelEditing);
  }
  function designTable() {
    if (!session || !selected || !session.canEditTable(selected) || busy) return;
    if (draftChanged && !confirmDiscard()) return;
    draftChanged = false;
    showWorkspace();
    const table = selected;
    designEditor(editing, table, session.fields(table), changes => apply(() => { session!.alterTable(table, changes); offset = 0; resetView(); }), cancelEditing);
  }
  const fileBase = () => (session?.name ?? 'Database').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'Database';
  const EXPORTS = {
    csv: { label: 'CSV (comma-separated)', extension: 'csv', type: 'text/csv', write: (data: Parameters<typeof toDelimited>[0]) => toDelimited(data) },
    tsv: { label: 'Tab-delimited text', extension: 'txt', type: 'text/tab-separated-values', write: (data: Parameters<typeof toDelimited>[0]) => toDelimited(data, '\t') },
    json: { label: 'JSON', extension: 'json', type: 'application/json', write: toJson },
    html: { label: 'HTML table', extension: 'html', type: 'text/html', write: toHtml },
    xml: { label: 'XML', extension: 'xml', type: 'application/xml', write: toXml },
  } as const;
  type ExportFormat = keyof typeof EXPORTS | 'sql';
  function exportData(format: ExportFormat) {
    if (!session || busy) return;
    showWorkspace();
    try {
      if (format === 'sql') {
        dependencies.download(new TextEncoder().encode(session.sqlScript()), `${fileBase()}.sql`, 'application/sql');
        message.textContent = 'SQL script download started. It recreates every user table, index, view and trigger with its rows in any SQLite database.';
        return;
      }
      if (!selected) { message.textContent = 'Choose a table to export.'; return; }
      const choice = EXPORTS[format];
      const data = session.exportData(selected, effectiveView());
      const safeTable = selected.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'Table';
      dependencies.download(new TextEncoder().encode(choice.write(data)), `${safeTable}.${choice.extension}`, choice.type);
      message.textContent = `Exported ${data.rows.length.toLocaleString('en-US')} records from ${selected} as ${choice.label}. The current sort, filter and Find apply; the database was not changed.`;
    } catch (error) { message.textContent = `Export failed: ${error instanceof Error ? error.message : String(error)}`; }
  }
  function openRelationships() {
    if (!session || busy) return;
    showWorkspace();
    try { showRelationships(relationshipsHost, session.tables(), session.relationships(), session.editable, closeRelationships); }
    catch (error) { message.textContent = `Cannot read relationships: ${error instanceof Error ? error.message : String(error)}`; }
  }
  function undoDelete() {
    if (!session || !selected || !session.canEditTable(selected) || busy || draftChanged && !confirmDiscard()) return;
    cancelEditing(); showWorkspace();
    const table = selected;
    showDeletedRecords(journalHost, session, table, (eventId, recordId) => {
      apply(() => { session!.undoDelete(table, eventId, recordId); selected = table; });
      message.textContent = `Record ${recordId} restored. Undo removes it again.`;
    }, closeJournalView);
  }
  function tableAsOf() {
    if (!session || !selected || !session.canEditTable(selected) || busy) return;
    showWorkspace();
    showTableAsOf(journalHost, session, selected, closeJournalView);
  }
  function editRecord(insert = false) {
    if (!session || !selected || !session.canEditTable(selected) || busy || !insert && !selectedRecord) return;
    if (draftChanged && !confirmDiscard()) return;
    draftChanged = false;
    showWorkspace();
    const table = selected; const id = selectedRecord;
    recordEditor(editing, session.fields(table), insert ? undefined : session.record(table, id!), values => apply(() => {
      if (insert) session!.insertRecord(table, values); else session!.updateRecord(table, id!, values);
    }), cancelEditing);
  }

  const display = (value: Cell, type = ''): string => {
    if (value === null) return 'NULL';
    if (type.toUpperCase() === 'BOOLEAN' && (value === 0n || value === 1n)) return value === 1n ? 'Yes' : 'No';
    if (value instanceof Uint8Array) return `BLOB · ${value.byteLength} bytes`;
    const text = String(value);
    return text.length > 2000 ? text.slice(0, 2000) + '… [display shortened]' : text;
  };
  function applyView(next: TableView, enabled = filterEnabled) {
    if (!session || !selected || busy) return false;
    session.page(selected, 0, next);
    if (draftChanged && !confirmDiscard()) return false;
    cancelEditing(); closeHistory(); view = next; filterEnabled = enabled; offset = 0; selectedRecord = undefined;
    render(); return true;
  }
  function sortView(direction: 'ASC' | 'DESC') {
    if (!session || !selected) return;
    const column = tools.querySelector<HTMLSelectElement>('[data-sort-column]')?.value || session.columns(selected)[0]?.name;
    if (column) applyView({ ...view, sort: undefined, sorts: [{ column, direction }, ...sortLevels(view).slice(1).filter(level => level.column !== column)] });
  }
  function renderTable() {
    data.replaceChildren();
    if (!session || !selected) {
      data.append(node('p', session ? session.editable ? 'This database has no user tables. Use Create table to get started.' : 'This database has no user tables.' : 'No database is open.'));
      return;
    }
    try {
      const page = session.page(selected, offset, effectiveView());
      data.append(node('h3', selected));
      const wrapper = node('div');
      wrapper.className = 'datasheet-scroll';
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', `${selected} records`);
      const table = node('table');
      const editable = session.canEditTable(selected);
      const caption = node('caption', `${selected} · ${editable ? 'Select a record to edit or delete' : 'read-only'}`);
      const head = node('thead');
      const header = node('tr');
      if (editable) { const th = node('th', 'Select'); th.scope = 'col'; header.append(th); }
      for (const column of page.columns) {
        const th = node('th', column); th.scope = 'col';
        const levels = sortLevels(view); const index = levels.findIndex(level => level.column === column);
        if (index === 0) th.setAttribute('aria-sort', levels[0].direction === 'ASC' ? 'ascending' : 'descending');
        if (index >= 0) th.setAttribute('aria-label', `${column}, sort priority ${index + 1}, ${levels[index].direction === 'ASC' ? 'ascending' : 'descending'}`);
        header.append(th);
      }
      head.append(header);
      const body = node('tbody');
      const types = session.columns(selected).map(column => column.type);
      for (const row of page.rows) {
        const tr = node('tr');
        if (editable) {
          const td = node('td'); const radio = node('input'); radio.type = 'radio'; radio.name = 'selected-record';
          const id = String(row[0]); radio.checked = selectedRecord === id; radio.setAttribute('aria-label', `Select record ${id}`);
          radio.addEventListener('change', () => { selectedRecord = id; syncActions(); changed(session?.name, busy); });
          td.append(radio); tr.append(td);
        }
        for (const [index, value] of row.entries()) {
          const td = node('td', display(value, types[index]));
          if (value === null) td.className = 'null-cell';
          tr.append(td);
        }
        body.append(tr);
      }
      table.append(caption, head, body);
      let totals: ReturnType<typeof totalsRow> | undefined;
      if (totalsEnabled) {
        let result: TableTotals | undefined; let error = '';
        try {
          const key = JSON.stringify([dataRevision, effectiveView(), totalChoices]);
          if (totalCache?.key === key) result = totalCache.result;
          else { result = session.totals(selected, totalChoices, effectiveView()); totalCache = { key, result }; }
        } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
        totals = totalsRow(session.columns(selected), editable, totalChoices, result, error, (column, operation) => {
          if (busy || disposed) return;
          totalChoices = totalChoices.filter(choice => choice.column !== column);
          if (operation) totalChoices.push({ column, operation });
          renderTable();
          [...data.querySelectorAll<HTMLSelectElement>('tfoot select')].find(select => select.getAttribute('aria-label') === `Total for ${column}`)?.focus();
        });
        table.append(totals.footer);
      }
      wrapper.append(table);
      const pagination = node('div');
      pagination.className = 'pagination';
      const previous = node('button', 'Previous page');
      previous.disabled = offset === 0;
      previous.addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); selectedRecord = undefined; render(); });
      const next = node('button', 'Next page');
      next.disabled = !page.hasMore;
      next.addEventListener('click', () => { offset += PAGE_SIZE; selectedRecord = undefined; render(); });
      const range = page.rows.length ? `Rows ${offset + 1}–${offset + page.rows.length}` : view.search || filterConditions(view).length && filterEnabled ? 'No matching records' : 'No records';
      pagination.append(previous, node('span', range), next);
      data.append(wrapper, pagination);
      if (totals) data.append(totals.summary, totals.note);
    } catch (error) { data.append(node('p', `Cannot read this table: ${error instanceof Error ? error.message : String(error)}`)); }
  }

  function render() {
    if (disposed) return;
    if (totalContext?.session !== session || totalContext?.table !== selected) {
      totalsEnabled = false; totalChoices = []; totalCache = undefined; totalContext = { session, table: selected };
    }
    title.textContent = session ? session.name : 'Your database workspace';
    navigation.replaceChildren(node('h3', 'Tables'));
    for (const name of session?.tables() ?? []) {
      const item = node('button', name);
      item.setAttribute('aria-pressed', String(name === selected));
      item.addEventListener('click', () => { if (draftChanged && !confirmDiscard()) return; cancelEditing(); closeHistory(); closeJournalView(); selectedRecord = undefined; selected = name; offset = 0; resetView(); render(); });
      navigation.append(item);
    }
    for (const control of [newButton, sampleButton, openButton]) control.disabled = busy;
    exportButton.disabled = busy || !session;
    closeButton.disabled = busy || !session;
    sqlView.contextChanged();
    syncActions();
    history.replaceChildren(node('summary', 'Change history'));
    const entries = session?.history() ?? [];
    const list = node('ol');
    for (const entry of entries) {
      const item = node('li', `${entry.time} · ${entry.operation} · ${entry.table}${entry.recordId ? ` #${entry.recordId}` : ''}${entry.undone ? ' · Undone' : ''}`);
      if (entry.recordId !== null && session?.canEditTable(entry.table)) {
        const inspect = node('button', 'View record history');
        inspect.addEventListener('click', () => openRecordHistory(entry.table, entry.recordId!)); item.append(inspect);
      }
      list.append(item);
    }
    history.append(entries.length ? list : node('p', 'No changes recorded.'));
    pane.setAttribute('aria-busy', String(busy));
    editing.inert = busy;
    tools.inert = busy;
    tools.hidden = !session || !selected;
    if (session && selected) {
      try { tableControls(tools, session.columns(selected), view, filterEnabled, applyView); }
      catch (error) { tools.textContent = `Cannot inspect columns: ${error instanceof Error ? error.message : String(error)}`; }
    } else tools.replaceChildren();
    renderTable();
    renderRecovery();
    snapshots?.contextChanged();
    savedViews?.contextChanged();
    changed(session?.name, busy);
  }
  function syncActions() {
    if (disposed) return;
    createButton.disabled = busy || !session?.editable;
    const canEdit = !!session && !!selected && session.canEditTable(selected);
    addButton.disabled = busy || !canEdit;
    editButton.disabled = deleteButton.disabled = busy || !canEdit || !selectedRecord;
    undoButton.disabled = busy || !session?.canUndo();
    historyButton.disabled = busy || !canEdit;
    totalsButton.disabled = busy || !session || !selected; totalsButton.setAttribute('aria-pressed', String(totalsEnabled));
    designButton.disabled = busy || !canEdit;
    sqlButton.disabled = relationshipsButton.disabled = busy || !session;
    importButton.disabled = busy || !session?.editable;
    exportFormat.disabled = busy || !session;
    exportRun.disabled = busy || !session || exportFormat.value !== 'sql' && !selected;
  }

  async function replace(create: () => Promise<DatabaseSession>, recovered?: () => RecoveryMetadata | undefined) {
    if (busy || disposed || !discard()) return;
    busy = true;
    message.textContent = 'Loading SQLite…';
    render();
    let candidate: DatabaseSession | undefined;
    try {
      candidate = await create();
      if (disposed) { candidate.close(); return; }
      // Validate navigation before replacing a successfully opened database.
      const tables = candidate.tables();
      session?.close();
      session = candidate;
      cancelEditing(); closeHistory(); closeRelationships(); closeJournalView(); selectedRecord = undefined;
      candidate = undefined;
      selected = tables[0];
      offset = 0;
      resetView();
      connectAutosave(recovered?.());
      message.textContent = `${session.name} is open ${session.editable ? 'for journaled editing' : 'read-only'}. ${tables.length} user tables.`;
      showWorkspace();
    } catch (error) {
      candidate?.close();
      message.textContent = `${error instanceof Error ? error.message : String(error)}${session ? ' The current database is still open.' : ''}`;
    } finally { busy = false; if (!disposed) render(); }
  }

  function download() {
    if (!session || busy) return;
    showWorkspace();
    if (draftChanged) { message.textContent = 'Save or cancel the current form before downloading a copy.'; return; }
    try {
      const base = session.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'Database';
      const extension = session.isNative ? '.qbase' : '.sqlite';
      dependencies.download(session.exportCopy(), `${base}-copy${extension}`);
      session.acknowledgeDownload();
      if (autosave) autosave.save(session);
      message.textContent = 'Download started. Keep the downloaded copy; this preview does not save back to the original file.';
    } catch (error) { message.textContent = `Download failed: ${error instanceof Error ? error.message : String(error)}`; }
  }
  function close() {
    if (busy || !discard()) return;
    showWorkspace();
    session?.close(); session = undefined; autosave = undefined; snapshotDocumentId = undefined; selected = undefined; offset = 0; resetView();
    cancelEditing(); closeHistory(); closeRelationships(); closeJournalView(); selectedRecord = undefined;
    message.textContent = 'Database closed. Original files were not changed.';
    render();
  }
  async function openFile(file: File, readOnly = false) {
    showWorkspace();
    await replace(async () => {
      if (file.size > MAX_DATABASE_BYTES) throw new Error('This preview supports databases up to 32 MiB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      return DatabaseSession.open(await dependencies.load(), bytes, file.name, readOnly);
    });
  }
  const newButton = button('New blank database', () => { void replace(async () => DatabaseSession.create(await dependencies.load())); });
  const sampleButton = button('Try sample database', () => { void replace(async () => DatabaseSession.create(await dependencies.load(), true)); });
  const openButton = button('Open SQLite file', () => { openAsReadOnly = false; input.click(); });
  const exportButton = button('Download a copy', download);
  const closeButton = button('Close database', close);
  const createButton = button('Create table', createTable);
  const addButton = button('Add record', () => report(() => editRecord(true)));
  const editButton = button('Edit selected', () => report(() => editRecord()));
  const deleteButton = button('Delete selected', () => report(() => { if (!draftChanged || confirmDiscard()) apply(() => session!.deleteRecord(selected!, selectedRecord!)); }));
  const undoButton = button('Undo last change', () => report(() => { if (!draftChanged || confirmDiscard()) apply(() => session!.undo()); }));
  const historyButton = button('Record history', () => report(() => openRecordHistory()));
  const totalsButton = button('Totals row', () => {
    if (!session || !selected || busy) return;
    showWorkspace(); totalsEnabled = !totalsEnabled; renderTable(); syncActions(); changed(session.name, busy);
  });
  const designButton = button('Design table', () => report(designTable));
  const sqlButton = button('SQL view', () => { if (session && !busy) { showWorkspace(); sqlView.show(); } });
  const importButton = button('Import data', () => { if (session?.editable && !busy) { showWorkspace(); importPanel.show(); } });
  const relationshipsButton = button('Relationships', openRelationships);
  const exportFormat = node('select'); exportFormat.setAttribute('aria-label', 'Export format');
  for (const [value, choice] of Object.entries(EXPORTS)) { const option = node('option', `Table as ${choice.label}`); option.value = value; exportFormat.append(option); }
  { const option = node('option', 'Whole database as SQL script'); option.value = 'sql'; exportFormat.append(option); }
  exportFormat.addEventListener('change', syncActions);
  actions.append(exportFormat);
  const exportRun = button('Export', () => exportData(exportFormat.value as ExportFormat));
  const sqlView = mountSqlView(sqlPanel, () => ({ session, table: selected, busy }), dependencies.download);
  const importPanel = mountImportPanel(importHost, () => !!session?.editable && !busy, (name, fields, records) => {
    let count = 0;
    apply(() => { count = session!.importTable(name, fields, records); selected = name; offset = 0; resetView(); });
    message.textContent = `Imported ${count.toLocaleString('en-US')} records into ${name}. Undo removes the whole import.`;
  });
  if (dependencies.snapshots) {
    snapshots = mountSnapshots(snapshotPanel, dependencies.snapshots, dependencies.snapshotPreferences,
      () => ({ session, documentId: snapshotDocumentId, busy, draftChanged }),
      async (bytes, name) => replace(async () => {
        const copy = DatabaseSession.open(await dependencies.load(), bytes, name);
        if (copy.editable) copy.markRecoveredChanges();
        return copy;
      }), dependencies.download);
    button('Snapshots', () => { showWorkspace(); snapshots!.show(); });
    registry.bind('file.snapshots', () => { showWorkspace(); snapshots!.show(); }, () => !busy);
    registry.bind('recover.autoSnapshots', () => { showWorkspace(); snapshots!.show(); snapshots!.toggleAutomatic(); }, () => !busy);
  }
  if (dependencies.savedViews) {
    savedViews = mountSavedViews(savedViewsPanel, dependencies.savedViews,
      () => session && selected ? { identity: session, sourceName: session.name, table: selected, columns: session.columns(selected), view, filterEnabled, busy } : undefined,
      applyView);
    registry.bind('filter.savedViews', () => { showWorkspace(); savedViews!.show(); }, () => !!session && !!selected && !busy);
  }
  input.addEventListener('change', () => { const file = input.files?.[0]; input.value = ''; const readOnly = openAsReadOnly; openAsReadOnly = false; if (file) void openFile(file, readOnly); });
  for (const [id, handler, enabled] of [
    ['file.new', () => newButton.click(), () => !busy],
    ['file.open', () => openButton.click(), () => !busy],
    ['file.openReadOnly', () => { openAsReadOnly = true; input.click(); }, () => !busy],
    ['file.save', download, () => !!session && !busy],
    ['file.saveAs', download, () => !!session && !busy],
    ['file.closeDatabase', close, () => !!session && !busy],
    ['create.table', createTable, () => !!session?.editable && !busy],
    ['record.new', () => report(() => editRecord(true)), () => !!session && !!selected && session.canEditTable(selected) && !busy],
    ['record.delete', () => deleteButton.click(), () => !deleteButton.disabled],
    ['edit.undo', () => undoButton.click(), () => !!session?.canUndo() && !busy],
    ['sort.ascending', () => report(() => sortView('ASC')), () => !!session && !!selected && !busy],
    ['sort.descending', () => report(() => sortView('DESC')), () => !!session && !!selected && !busy],
    ['sort.clear', () => report(() => applyView({ ...view, sort: undefined, sorts: undefined })), () => sortLevels(view).length > 0 && !busy],
    ['sort.advanced', () => { showWorkspace(); tools.querySelector<HTMLSelectElement>('[data-sort-column]')?.focus(); }, () => !!session && !!selected && !busy],
    ['filter.advanced', () => { showWorkspace(); tools.querySelector<HTMLSelectElement>('[data-filter-column]')?.focus(); }, () => !!session && !!selected && !busy],
    ['filter.menu', () => { showWorkspace(); tools.querySelector<HTMLSelectElement>('[data-filter-column]')?.focus(); }, () => !!session && !!selected && !busy],
    ['filter.toggle', () => report(() => applyView(view, !filterEnabled)), () => filterConditions(view).length > 0 && !busy],
    ['filter.clearAll', () => report(() => applyView({ ...view, filter: undefined, filters: undefined, search: undefined }, true)), () => (filterConditions(view).length > 0 || !!view.search) && !busy],
    ['edit.find', () => { showWorkspace(); tools.querySelector<HTMLInputElement>('input[type=search]')?.focus(); }, () => !!session && !!selected && !busy],
    ['record.totals', () => totalsButton.click(), () => !!session && !!selected && !busy],
    ['record.history', () => report(() => openRecordHistory()), () => !!session && !!selected && session.canEditTable(selected) && !busy],
    ['create.tableDesign', createTable, () => !!session?.editable && !busy],
    ['record.undoDelete', () => report(undoDelete), () => !!session && !!selected && session.canEditTable(selected) && !busy],
    ['data.asOf', () => report(tableAsOf), () => !!session && !!selected && session.canEditTable(selected) && !busy],
    ['view.design', () => report(designTable), () => !!session && !!selected && session.canEditTable(selected) && !busy],
    ['table.addField', () => report(designTable), () => !!session && !!selected && session.canEditTable(selected) && !busy],
    ['table.renameField', () => report(designTable), () => !!session && !!selected && session.canEditTable(selected) && !busy],
    ['view.datasheet', () => { if (session && selected && (!draftChanged || confirmDiscard())) { cancelEditing(); showWorkspace(); data.scrollIntoView?.({ block: 'start' }); } }, () => !!session && !!selected && !busy],
    ['view.sql', () => sqlButton.click(), () => !!session && !busy],
    ['create.sqlQuery', () => sqlButton.click(), () => !!session && !busy],
    ['query.sqlEditor', () => sqlButton.click(), () => !!session && !busy],
    ['query.run', () => sqlView.run(), () => !!session && !busy && sqlView.open],
    ['query.explain', () => sqlView.explain(), () => !!session && !busy && sqlView.open],
    ['query.formatSql', () => sqlView.format(), () => sqlView.open],
    ['query.history', () => { showWorkspace(); sqlView.show(true); }, () => !!session && !busy && sqlView.historyCount > 0],
    ['ext.importText', () => importButton.click(), () => !!session?.editable && !busy],
    ['ext.importJson', () => importButton.click(), () => !!session?.editable && !busy],
    ['ext.exportText', () => exportData('csv'), () => !!session && !!selected && !busy],
    ['ext.exportJson', () => exportData('json'), () => !!session && !!selected && !busy],
    ['ext.exportHtml', () => exportData('html'), () => !!session && !!selected && !busy],
    ['ext.exportXml', () => exportData('xml'), () => !!session && !!selected && !busy],
    ['ext.exportSql', () => exportData('sql'), () => !!session && !busy],
    ['file.exportSqlScript', () => exportData('sql'), () => !!session && !busy],
    ['ext.exportSqlite', download, () => !!session && !busy],
    ['dbtools.relationships', openRelationships, () => !!session && !busy],
    ['table.relationships', openRelationships, () => !!session && !busy],
  ] as const) registry.bind(id, handler, enabled);
  if (recoveryStore) registry.bind('file.openRecent', () => { showWorkspace(); recovery.scrollIntoView?.({ block: 'start' }); recoveryHeading.focus(); }, () => recoveryEntries.length > 0 && !busy);
  grid.append(navigation, data);
  pane.append(title, message, actions, input, recovery, snapshotPanel, importHost, relationshipsHost, journalHost, editing, recordHistory, sqlPanel, tools, savedViewsPanel, grid, history, note);
  container.append(pane);
  render();
  void refreshRecovery();
  return { openFile, dispose: () => { disposed = true; snapshots?.dispose(); savedViews?.dispose(); window.removeEventListener('beforeunload', beforeUnload); session?.close(); session = undefined; autosave = undefined; } };
}
