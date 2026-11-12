import type { CommandRegistry } from './commands/registry';

/** Overrides keyed by shortcut: a command id assigns it, null removes the catalog default. */
export type KeyOverrides = Record<string, string | null>;
const MODIFIERS = ['Ctrl', 'Alt', 'Shift'] as const;
const NAMED = new Set(['Enter', 'Esc', 'Tab', 'Space', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right', 'Break',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)]);
const KEY_ALIASES: Record<string, string> = {
  Escape: 'Esc', ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Pause: 'Break', Cancel: 'Break', Del: 'Delete',
};
const CODE_KEYS: Record<string, string> = {
  Semicolon: ';', Equal: '=', Minus: '-', Quote: "'", Slash: '/', Backslash: '\\', Comma: ',', Period: '.', BracketLeft: '[', BracketRight: ']', Backquote: '`', NumpadAdd: '+', NumpadSubtract: '-',
};

/** Canonical form such as Ctrl+Shift+E; returns undefined for text that is not a single shortcut. */
export function normalizeShortcut(text: string): string | undefined {
  if (typeof text !== 'string' || !text || text.length > 40) return undefined;
  // A trailing "+" key is written as "Ctrl++".
  const parts = text.endsWith('++') ? [...text.slice(0, -2).split('+'), '+'] : text.split('+');
  const key = parts.pop()!;
  const modifiers = new Set<string>();
  for (const part of parts) {
    const name = part.trim().toLowerCase();
    const modifier = name === 'control' || name === 'cmd' || name === 'meta' ? 'Ctrl' : MODIFIERS.find(value => value.toLowerCase() === name);
    if (!modifier || modifiers.has(modifier)) return undefined;
    modifiers.add(modifier);
  }
  let base = KEY_ALIASES[key] ?? key;
  if (/^[a-z]$/i.test(base)) base = base.toUpperCase();
  else if (/^f([1-9]|1[0-2])$/i.test(base)) base = base.toUpperCase();
  else { const named = [...NAMED].find(value => value.toLowerCase() === base.toLowerCase()); if (named) base = named; }
  if (!(base.length === 1 && base !== ' ' || NAMED.has(base))) return undefined;
  return [...MODIFIERS.filter(modifier => modifiers.has(modifier)), base].join('+');
}

export function shortcutFromEvent(event: KeyboardEvent): string | undefined {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified', 'Process'].includes(event.key)) return undefined;
  let key = KEY_ALIASES[event.key] ?? event.key;
  let shift = event.shiftKey;
  // Shifted keys report their shifted character; use the physical key so Ctrl+Shift+; stays recognizable.
  // A typed "+" is the plus key itself (Ctrl++), whichever keyboard row produced it.
  if (event.key === '+') shift = false;
  else if (event.code?.startsWith('Key')) key = event.code.slice(3);
  else if (event.code?.startsWith('Digit')) key = event.code.slice(5);
  else if (event.code && CODE_KEYS[event.code]) key = CODE_KEYS[event.code];
  const parts = [event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', shift ? 'Shift' : ''].filter(Boolean);
  return normalizeShortcut([...parts, key].join('+'));
}

export function normalizeOverrides(value: unknown, registry: CommandRegistry): KeyOverrides {
  const result: KeyOverrides = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [shortcut, command] of Object.entries(value)) {
    const key = normalizeShortcut(shortcut);
    if (!key || Object.keys(result).length >= 500) continue;
    if (command === null || typeof command === 'string' && registry.get(command)) result[key] = command;
  }
  return result;
}

/** Catalog shortcuts (first command wins on a shared key) with the user's overrides applied. */
export function effectiveBindings(registry: CommandRegistry, overrides: KeyOverrides): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const command of registry.all()) {
    for (const shortcut of command.shortcuts) {
      const key = normalizeShortcut(shortcut);
      if (key && !bindings.has(key)) bindings.set(key, command.id);
    }
  }
  for (const [key, command] of Object.entries(overrides)) {
    if (command === null) bindings.delete(key); else bindings.set(key, command);
  }
  return bindings;
}

export function shortcutsFor(bindings: Map<string, string>, id: string): string[] {
  return [...bindings].filter(([, command]) => command === id).map(([key]) => key);
}

/** Text fields keep native editing keys; only modified shortcuts and function keys reach commands there. */
const TEXT_EDITING = new Set(['Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+Left', 'Ctrl+Right', 'Ctrl+Home', 'Ctrl+End', 'Ctrl+Backspace', 'Ctrl+Delete']);
export function shouldDispatch(shortcut: string, target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const editable = !!element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName));
  if (!editable) return true;
  if (TEXT_EDITING.has(shortcut)) return false;
  return shortcut.startsWith('Ctrl+') || shortcut.startsWith('Alt+') || /(^|\+)F\d+$/.test(shortcut);
}

/** Installs one document-level dispatcher; returns its remover. */
export function installShortcuts(target: Document, registry: CommandRegistry, bindings: () => Map<string, string>): () => void {
  const listener = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const shortcut = shortcutFromEvent(event);
    if (!shortcut || !shouldDispatch(shortcut, event.target)) return;
    const id = bindings().get(shortcut);
    if (!id) return;
    // Unavailable commands leave the browser's own behavior for the key untouched.
    if (!registry.isAvailable(id)) return;
    event.preventDefault();
    registry.execute(id);
  };
  target.addEventListener('keydown', listener);
  return () => target.removeEventListener('keydown', listener);
}
