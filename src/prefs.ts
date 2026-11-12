import { catalog, type CommandRegistry } from './commands/registry';
import { normalizeOverrides, type KeyOverrides } from './keyboard';

export const PREFS_KEY = 'annesbase.preferences.v1';
export interface Preferences {
  version: 1;
  qat: string[];
  menuLayout: string;
  /** Keyboard customizations; omitted when every shortcut uses its default. */
  keys?: KeyOverrides;
}
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export const QAT_STANDARD = [
  'file.new', 'file.open', 'file.save', 'file.email', 'file.quickPrint', 'file.printPreview',
  'file.print', 'edit.undo', 'edit.redo', 'view.touchMode', 'file.openRecent',
] as const;
export const QAT_EXTRAS = [
  'record.refreshAll', 'record.spelling', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.formatPainter',
  'sort.ascending', 'sort.descending', 'filter.bySelection', 'filter.byForm', 'filter.toggle',
  'edit.find', 'record.new', 'record.delete', 'record.undoDelete', 'view.datasheet', 'view.design',
  'form.propertySheet', 'dbtools.relationships', 'dbtools.codeEditor', 'query.run', 'query.explain',
  'query.commit', 'query.rollback', 'dbtools.compactRepair', 'file.backup', 'view.navPane',
  'xbase.dotPrompt', 'view.browseMode', 'view.findMode', 'view.layoutMode', 'view.previewMode',
  'ai.ask', 'view.cmdSearch',
] as const;
export const defaultPreferences = (): Preferences => ({
  version: 1, qat: ['file.save', 'edit.undo', 'edit.redo', 'record.refreshAll', 'view.cmdSearch'], menuLayout: 'access2003',
});

export function normalizePreferences(value: unknown, registry: CommandRegistry): Preferences {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) return defaultPreferences();
  const candidate = value as Partial<Preferences>;
  const keys = normalizeOverrides(candidate.keys, registry);
  return {
    ...(Object.keys(keys).length ? { keys } : {}),
    version: 1,
    qat: Array.isArray(candidate.qat)
      ? [...new Set(candidate.qat.filter((id): id is string => typeof id === 'string' && !!registry.get(id)))]
      : defaultPreferences().qat,
    menuLayout: typeof candidate.menuLayout === 'string' && Object.hasOwn(catalog.menuLayouts, candidate.menuLayout)
      ? candidate.menuLayout : 'access2003',
  };
}

export function loadPreferences(storage: PreferenceStorage, registry: CommandRegistry): Preferences {
  try { return normalizePreferences(JSON.parse(storage.getItem(PREFS_KEY) ?? 'null'), registry); }
  catch { return defaultPreferences(); }
}

export function savePreferences(storage: PreferenceStorage, prefs: Preferences): boolean {
  try { storage.setItem(PREFS_KEY, JSON.stringify(prefs)); return true; }
  catch { return false; }
}

export function addAllQatChoices(prefs: Preferences, registry: CommandRegistry): Preferences {
  const first = ['file.save', 'file.print'];
  const choices = [...new Set<string>([...QAT_STANDARD, ...QAT_EXTRAS])];
  for (const id of choices) if (!registry.get(id)) throw new Error(`Unknown Quick Access choice: ${id}`);
  const alphabetical = choices.filter(id => !first.includes(id)).sort((a, b) =>
    registry.get(a)!.label.toLocaleLowerCase('en-US').localeCompare(registry.get(b)!.label.toLocaleLowerCase('en-US'), 'en-US'));
  return { ...prefs, qat: [...new Set([...first, ...alphabetical, ...prefs.qat])] };
}

export const SETTINGS_FILE_KIND = 'annes-base-settings';
/** A portable settings file: Quick Access pins, menu layout and keyboard shortcuts. */
export function exportSettings(prefs: Preferences): string {
  return JSON.stringify({ kind: SETTINGS_FILE_KIND, version: 1, exportedAt: new Date().toISOString(), preferences: prefs }, null, 2) + '\n';
}
export function importSettings(text: string, registry: CommandRegistry): Preferences {
  let value: any;
  try { value = JSON.parse(text); } catch { throw new Error('This is not a settings file; it is not valid JSON.'); }
  if (!value || value.kind !== SETTINGS_FILE_KIND || value.version !== 1 || !value.preferences || value.preferences.version !== 1) {
    throw new Error("This is not an Anne's Base settings file, or it was made by a newer version.");
  }
  return normalizePreferences(value.preferences, registry);
}
