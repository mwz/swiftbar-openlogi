import { describe, it, expect } from 'vitest';
import { parseList, LIMITS } from '../src/model.js';
import { interpret } from '../src/runner.js';
import { plain, render } from '../src/render.js';

const row = (name = 'Mouse', battery = '72%', slot = '1', marker = '●') =>
  `  └─ slot ${slot} ${marker} ${name} (mouse, wpid=0000, battery=${battery})`;
const result = (output: string) => interpret({ stdout: output, stderr: '', exitCode: 0 });

describe('Omarchy input limits', () => {
  it('enforces total, line and line-count bounds', () => {
    expect(parseList('x'.repeat(LIMITS.line)).ok).toBe(true);
    expect(parseList('x'.repeat(LIMITS.line + 1)).ok).toBe(false);
    expect(parseList('\n'.repeat(LIMITS.lines - 1)).ok).toBe(true);
    expect(parseList('\n'.repeat(LIMITS.lines)).ok).toBe(false);
    const exact = ('x'.repeat(2047) + '\n').repeat(32);
    expect(exact.length).toBe(LIMITS.output);
    expect(parseList(exact).ok).toBe(true);
    expect(parseList(exact + 'x').ok).toBe(false);
  });
  it('counts offline devices towards the device limit', () => {
    const rows = Array.from({ length: 24 }, () => row('Mouse', '50%', '1', '○'));
    expect(parseList(rows.join('\n')).ok).toBe(true);
    expect(parseList([...rows, row()].join('\n'))).toMatchObject({ ok: false, devices: [] });
  });
  it('bounds names in UTF-16 code units and rejects excessive parent names', () => {
    expect(parseList(row('😀'.repeat(128))).ok).toBe(true);
    expect(parseList(row('😀'.repeat(129))).ok).toBe(false);
    expect(parseList(`${'x'.repeat(257)} (—, vid=046d pid=c548)\n${row()}`).ok).toBe(false);
  });
  it.each(['256', '9999', '-1', 'x'])('rejects malformed slot %s without partial results', slot => {
    expect(parseList(row() + '\n' + row('Bad', '50%', slot))).toMatchObject({ ok: false, devices: [] });
  });
  it('accepts slots 0 and 255', () => {
    expect(parseList(row('Zero', '0%', '0') + '\n' + row('Direct', '100%', '255')).devices).toHaveLength(2);
  });
  it.each([
    ['kind', 'x'.repeat(64), 'x'.repeat(65)],
    ['wpid', 'a'.repeat(64), 'a'.repeat(65)],
    ['battery', 'x'.repeat(256), 'x'.repeat(257)],
  ])('bounds %s', (field, good, bad) => {
    const replace = (value: string) => field === 'kind' ? row().replace('(mouse,', `(${value},`) :
      field === 'wpid' ? row().replace('wpid=0000', `wpid=${value}`) : row('Mouse', value);
    expect(parseList(replace(good)).ok).toBe(true);
    expect(parseList(replace(bad)).ok).toBe(false);
  });
});

describe('menu behaviour', () => {
  it('shows the lowest readable device, sorted rows and unavailable batteries', () => {
    const menu = render(result([row('Zulu', '80%'), row('Alpha', '40% (charging)'), row('Unknown', '—'), row('Offline', '1%', '2', '○')].join('\n')));
    expect(menu).toMatch(/^40% \| sfimage=battery.100.bolt/);
    expect(menu).toContain('3 connected devices');
    expect(menu).toContain('Unknown (Logitech receiver) — Battery unavailable');
    expect(menu.indexOf('Alpha (')).toBeLessThan(menu.indexOf('Zulu ('));
    expect(menu).not.toContain('Offline');
    expect(menu).toContain('Refresh | refresh=true');
  });
  it('hides an empty inventory and one with no readable batteries', () => {
    expect(render(result(''))).toBe('');
    expect(render(result(row('Unknown', '—')))).toBe('');
  });
  it('displays failure instead of partial readings and limits errors', () => {
    const state = interpret({ stdout: row(), stderr: 'x'.repeat(300), exitCode: 1 });
    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.error.length).toBeLessThanOrEqual(180);
    expect(render(state)).toMatch(/^\?/);
    expect(render(state)).not.toContain('72%');
  });
  it('only accepts exit 2 with the expected no-hardware message', () => {
    expect(interpret({ stdout: '', stderr: '', exitCode: 2 }).ok).toBe(false);
    expect(render(interpret({ stdout: 'No Logitech HID++ devices or webcams found.', stderr: '', exitCode: 2 }))).toBe('');
    expect(interpret({ stdout: 'No Logitech HID++ devices or webcams found.\n' + row('Bad', '101%'), stderr: '', exitCode: 2 }).ok).toBe(false);
  });
  it('neutralises SwiftBar syntax in titles, errors and quoted tooltips', () => {
    const malicious = 'Mouse | bash=/tmp/evil param1=x " \\ :smile:';
    const menu = render(result(row(malicious)));
    for (const line of menu.split('\n')) {
      expect(line.split('|').length).toBeLessThanOrEqual(2);
    }
    expect(menu).not.toContain('| bash=');
    expect(menu).toContain('emojize=false symbolize=false md=false');
    expect(render({ ok: false, error: 'Oops\n---\nRun | bash=/tmp/evil' })).not.toContain('\nRun');
    expect(plain('x\u001b\u2028\u202ey')).toBe('x  y');
  });
});
