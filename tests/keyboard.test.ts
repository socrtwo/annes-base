// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRegistry } from '../src/commands/registry';
import { effectiveBindings, normalizeOverrides, normalizeShortcut, shortcutFromEvent, shouldDispatch } from '../src/keyboard';
import { defaultPreferences, exportSettings, importSettings, normalizePreferences, PREFS_KEY } from '../src/prefs';
import { mountShell } from '../src/ui/shell';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); window.localStorage.clear(); });
const key = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }); target.dispatchEvent(event); return event;
};

describe('shortcut parsing', () => {
  it('normalizes catalog text and keyboard events', () => {
    expect(normalizeShortcut('shift+ctrl+e')).toBe('Ctrl+Shift+E');
    expect(normalizeShortcut('Ctrl++')).toBe('Ctrl++');
    expect(normalizeShortcut('Ctrl+Shift+;')).toBe('Ctrl+Shift+;');
    expect(normalizeShortcut('Esc')).toBe('Esc');
    expect(normalizeShortcut('f12')).toBe('F12');
    expect(normalizeShortcut('Ctrl+Ctrl+S')).toBeUndefined();
    expect(normalizeShortcut('Hyper+S')).toBeUndefined();
    expect(shortcutFromEvent(new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+E');
    expect(shortcutFromEvent(new KeyboardEvent('keydown', { key: ':', code: 'Semicolon', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+;');
    expect(shortcutFromEvent(new KeyboardEvent('keydown', { key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }))).toBe('Ctrl++');
    expect(shortcutFromEvent(new KeyboardEvent('keydown', { key: 's', code: 'KeyS', metaKey: true }))).toBe('Ctrl+S');
    expect(shortcutFromEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }))).toBeUndefined();
  });

  it('applies overrides, removals and text-field protection', () => {
    const registry = createRegistry();
    const defaults = effectiveBindings(registry, {});
    expect(defaults.get('Ctrl+S')).toBe('file.save');
    expect(defaults.get('Esc')).toBe('record.undoField');
    const custom = effectiveBindings(registry, normalizeOverrides({ 'ctrl+s': 'edit.find', 'Ctrl+Z': null, 'Bad+Key': 'file.new', 'Ctrl+K': 'missing.command' }, registry));
    expect(custom.get('Ctrl+S')).toBe('edit.find'); expect(custom.has('Ctrl+Z')).toBe(false); expect(custom.has('Ctrl+K')).toBe(false);
    const input = document.createElement('input');
    expect(shouldDispatch('Ctrl+C', input)).toBe(false);
    expect(shouldDispatch('Esc', input)).toBe(false);
    expect(shouldDispatch('Ctrl+S', input)).toBe(true);
    expect(shouldDispatch('F12', input)).toBe(true);
    expect(shouldDispatch('Esc', document.body)).toBe(true);
  });
});

describe('shell keyboard and settings', () => {
  function mount() {
    const root = document.createElement('div'); document.body.append(root);
    const download = vi.fn();
    cleanups.push(mountShell(root, undefined, { download }).dispose);
    return { root, download };
  }
  it('runs available commands from shortcuts and leaves unavailable ones to the browser', () => {
    const { root } = mount();
    const search = root.querySelector<HTMLInputElement>('#command-search')!;
    const event = key({ key: 'q', code: 'KeyQ', altKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(search);
    expect(key({ key: 's', code: 'KeyS', ctrlKey: true }).defaultPrevented).toBe(false);
    search.value = 'view.cmdSearch'; search.dispatchEvent(new Event('input'));
    expect(root.querySelector('.results')?.textContent).toContain('Alt+Q');
  });

  it('assigns, persists and resets custom shortcuts', () => {
    let { root } = mount();
    root.querySelector<HTMLButtonElement>('.file-tab')!.click();
    [...root.querySelectorAll<HTMLButtonElement>('.backstage-nav button')].find(button => button.textContent === 'Options')!.click();
    root.querySelector<HTMLButtonElement>('.options-actions button[data-command="view.customizeKeyboard"]')!.click();
    const panel = root.querySelector<HTMLElement>('.keyboard-settings')!;
    expect(panel.hidden).toBe(false);
    const find = panel.querySelector<HTMLInputElement>('[aria-label="Find a command to customize"]')!;
    find.value = 'view.menuLayout'; find.dispatchEvent(new Event('input'));
    const capture = panel.querySelector<HTMLInputElement>('[aria-label="Press new shortcut"]')!;
    key({ key: 'm', code: 'KeyM', ctrlKey: true, altKey: true }, capture);
    expect(capture.value).toBe('Ctrl+Alt+M');
    expect(panel.textContent).toContain('Ctrl+Alt+M is not assigned');
    [...panel.querySelectorAll('button')].find(button => button.textContent === 'Assign shortcut')!.click();
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY)!).keys).toEqual({ 'Ctrl+Alt+M': 'view.menuLayout' });
    cleanups.splice(0).forEach(dispose => dispose()); document.body.replaceChildren();
    ({ root } = mount());
    key({ key: 'm', code: 'KeyM', ctrlKey: true, altKey: true });
    expect(root.querySelector<HTMLDetailsElement>('.classic-options')!.open).toBe(true);
    const panel2 = root.querySelector<HTMLElement>('.keyboard-settings')!;
    const find2 = panel2.querySelector<HTMLInputElement>('[aria-label="Find a command to customize"]')!;
    find2.value = 'view.menuLayout'; find2.dispatchEvent(new Event('input'));
    panel2.querySelector<HTMLButtonElement>('[aria-label="Remove Ctrl+Alt+M"]')!.click();
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY)!).keys).toBeUndefined();
    find2.value = 'file.save'; find2.dispatchEvent(new Event('input'));
    panel2.querySelector<HTMLSelectElement>('[aria-label="Command to customize"]')!.value = 'file.save';
    panel2.querySelector<HTMLSelectElement>('[aria-label="Command to customize"]')!.dispatchEvent(new Event('change'));
    panel2.querySelector<HTMLButtonElement>('[aria-label="Remove Ctrl+S"]')!.click();
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY)!).keys).toEqual({ 'Ctrl+S': null });
    [...panel2.querySelectorAll('button')].find(button => button.textContent === 'Reset all shortcuts')!.click();
    expect(JSON.parse(window.localStorage.getItem(PREFS_KEY)!).keys).toBeUndefined();
  });

  it('exports settings and imports them with validation', async () => {
    const { root, download } = mount();
    const search = root.querySelector<HTMLInputElement>('#command-search')!;
    search.value = 'file.exportSettings'; search.dispatchEvent(new Event('input'));
    root.querySelector<HTMLButtonElement>('.results button[data-command="file.exportSettings"]')!.click();
    const [bytes, name, type] = download.mock.calls[0];
    expect([name, type]).toEqual(['AnnesBase-settings.json', 'application/json']);
    const file = JSON.parse(new TextDecoder().decode(bytes));
    file.preferences.menuLayout = 'complete'; file.preferences.qat = ['file.new']; file.preferences.keys = { 'Ctrl+Alt+N': 'file.new' };
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Import settings file"]')!;
    Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(file)], 'settings.json')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(root.querySelector('.notice')?.textContent).toContain('Settings imported'));
    expect(root.querySelector<HTMLSelectElement>('.classic-options select')!.value).toBe('complete');
    expect(root.querySelector('.pins')?.textContent).toContain('New Blank Database');
    Object.defineProperty(input, 'files', { value: [new File(['{"kind":"other"}'], 'x.json')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(root.querySelector('.notice')?.textContent).toContain('not an Anne'));
    expect(root.querySelector<HTMLSelectElement>('.classic-options select')!.value).toBe('complete');
  });

  it('round-trips settings files through normalization', () => {
    const registry = createRegistry();
    const prefs = normalizePreferences({ version: 1, qat: ['file.new'], menuLayout: 'complete', keys: { 'ctrl+alt+n': 'file.new' } }, registry);
    expect(prefs.keys).toEqual({ 'Ctrl+Alt+N': 'file.new' });
    expect(importSettings(exportSettings(prefs), registry)).toEqual(prefs);
    expect(() => importSettings('{', registry)).toThrow('not valid JSON');
    expect(normalizePreferences({ version: 1, qat: [], menuLayout: 'access2003', keys: { a: 'missing' } }, registry)).toEqual({ ...defaultPreferences(), qat: [] });
  });
});
