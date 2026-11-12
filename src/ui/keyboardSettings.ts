import type { CommandRegistry } from '../commands/registry';
import { effectiveBindings, shortcutFromEvent, shortcutsFor, type KeyOverrides } from '../keyboard';

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
  const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value;
};
function label(text: string, input: HTMLElement) { input.setAttribute('aria-label', text); const value = node('label', text); value.append(input); return value; }

/** Assign, remove and reset keyboard shortcuts for any registered command. */
export function mountKeyboardSettings(host: HTMLElement, registry: CommandRegistry, overrides: () => KeyOverrides, save: (next: KeyOverrides) => void) {
  host.className = 'keyboard-settings'; host.hidden = true; host.setAttribute('aria-label', 'Customize keyboard');
  const heading = node('h2', 'Customize keyboard'); heading.tabIndex = -1;
  const help = node('p', 'Find a command, then press the keys to assign. Shortcuts run only when their command is available; in text boxes, typing and editing keys such as Ctrl+C keep their usual meaning.');
  const find = node('input'); find.type = 'search'; find.placeholder = 'Find a command';
  const choice = node('select');
  const current = node('ul'); current.className = 'shortcut-list';
  const capture = node('input'); capture.readOnly = true; capture.placeholder = 'Press keys here';
  const conflict = node('p'); conflict.setAttribute('role', 'status');
  const assign = node('button', 'Assign shortcut'); assign.type = 'button';
  const reset = node('button', 'Reset all shortcuts'); reset.type = 'button';
  const close = node('button', 'Close keyboard settings'); close.type = 'button';
  const defaults = () => effectiveBindings(registry, {});
  const fill = () => {
    const previous = choice.value;
    const matches = registry.search(find.value).slice(0, 100);
    choice.replaceChildren(...matches.map(command => { const option = node('option', `${command.label} · ${command.id}`); option.value = command.id; return option; }));
    if (matches.some(command => command.id === previous)) choice.value = previous;
    render();
  };
  function render() {
    const bindings = effectiveBindings(registry, overrides());
    current.replaceChildren();
    const keys = choice.value ? shortcutsFor(bindings, choice.value) : [];
    for (const key of keys) {
      const item = node('li'); const remove = node('button', 'Remove'); remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${key}`);
      remove.addEventListener('click', () => {
        const next = { ...overrides() };
        if (defaults().get(key) === undefined) delete next[key]; else next[key] = null;
        save(next); render(); choice.focus();
      });
      item.append(node('kbd', key), remove); current.append(item);
    }
    if (!keys.length) current.append(node('li', choice.value ? 'No shortcut assigned.' : 'No matching commands.'));
    const pressed = capture.value;
    const owner = pressed ? bindings.get(pressed) : undefined;
    conflict.textContent = !pressed ? '' : owner === choice.value ? `${pressed} is already assigned to this command.`
      : owner ? `${pressed} is currently assigned to ${registry.get(owner)?.label ?? owner}; assigning moves it.` : `${pressed} is not assigned.`;
    assign.disabled = !pressed || !choice.value || owner === choice.value;
  }
  capture.addEventListener('keydown', event => {
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey) return;
    event.preventDefault(); event.stopPropagation();
    const shortcut = shortcutFromEvent(event);
    if (shortcut) { capture.value = shortcut; render(); }
  });
  find.addEventListener('input', fill);
  choice.addEventListener('change', render);
  assign.addEventListener('click', () => {
    if (!capture.value || !choice.value) return;
    const next = { ...overrides() };
    if (defaults().get(capture.value) === choice.value) delete next[capture.value]; else next[capture.value] = choice.value;
    save(next); conflict.textContent = `${capture.value} now runs ${registry.get(choice.value)?.label}.`; capture.value = ''; render();
    assign.disabled = true;
  });
  reset.addEventListener('click', () => { save({}); capture.value = ''; render(); conflict.textContent = 'All shortcuts use their defaults.'; });
  close.addEventListener('click', () => { host.hidden = true; });
  host.append(heading, help, label('Find a command to customize', find), label('Command to customize', choice), node('h3', 'Current shortcuts'), current, label('Press new shortcut', capture), assign, conflict, reset, close);
  fill();
  return {
    show(id?: string) {
      host.hidden = false;
      if (id) { find.value = id; fill(); choice.value = id; render(); }
      host.scrollIntoView?.({ block: 'start' }); heading.focus();
    },
    refresh: render,
  };
}
