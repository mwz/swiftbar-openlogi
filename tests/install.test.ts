import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

it('installs and updates paths with shell metacharacters, preserves config and uninstalls only its files', async () => {
  const home = await mkdtemp('/tmp/ol-install-');
  const plugins = path.join(home, "plugins ' $d `nope`");
  const cli = path.join(home, "openlogi ' $x `nope`");
  const installer = path.join(root, 'scripts/install.mjs');
  const env = { ...process.env, HOME: home };
  const invoke = (...args: string[]) => execFileSync(process.execPath, [installer, '--plugin-dir', plugins, ...args], { env, encoding: 'utf8' });
  try {
    await writeFile(cli, '#!/bin/sh\nprintf "%s\\n" "  └─ slot 1 ● Mouse (mouse, wpid=0000, battery=72%)"\n', { mode: 0o755 });
    invoke('--openlogi', cli);
    const launcher = path.join(plugins, 'openlogi.5m.sh');
    const script = await readFile(launcher, 'utf8');
    execFileSync('/bin/sh', ['-n', launcher]);
    expect(script).toContain('swiftbar.refreshOnOpen');
    expect(script).toContain('unset NODE_OPTIONS');
    expect(script).not.toContain('npm');
    expect(await readdir(plugins)).toEqual(['openlogi.5m.sh']);
    const base = path.join(home, 'Library/Application Support/swiftbar-openlogi');
    const support = path.join(base, (await readdir(base))[0]);
    expect(JSON.parse(await readFile(path.join(support, 'config.json'), 'utf8')).openlogiPath).toBe(cli);
    invoke();
    expect(JSON.parse(await readFile(path.join(support, 'config.json'), 'utf8')).openlogiPath).toBe(cli);
    await writeFile(path.join(plugins, 'unrelated.1m.sh'), '#!/bin/sh\n');
    invoke('--uninstall'); invoke('--uninstall');
    expect(await readdir(plugins)).toEqual(['unrelated.1m.sh']);
    expect(await readFile(cli, 'utf8')).toContain('72%');
  } finally { await rm(home, { recursive: true, force: true }); }
}, 15000);

it('refuses to overwrite an unrelated plugin', async () => {
  const home = await mkdtemp('/tmp/ol-install-');
  try {
    const plugins = path.join(home, 'plugins'); await mkdir(plugins);
    const launcher = path.join(plugins, 'openlogi.5m.sh'); await writeFile(launcher, 'unrelated');
    expect(() => execFileSync(process.execPath, [path.join(root, 'scripts/install.mjs'), '--plugin-dir', plugins], { env: { ...process.env, HOME: home }, stdio: 'pipe' })).toThrow();
    expect(await readFile(launcher, 'utf8')).toBe('unrelated');
  } finally { await rm(home, { recursive: true, force: true }); }
});

const socketIt = process.env.SWIFTBAR_SKIP_SOCKET_TESTS === '1' ? it.skip : it;
socketIt('runs the installed launcher without an interactive shell or build dependencies', async () => {
  const home = await mkdtemp('/tmp/ol-e2e-');
  const plugins = path.join(home, "plugins ' $x");
  const cli = path.join(home, "openlogi ' $x");
  const env = { HOME: home, PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require=/this-must-not-load' };
  try {
    await writeFile(cli, '#!/bin/sh\nprintf "%s\\n" "  └─ slot 1 ● Mouse (mouse, wpid=0000, battery=72%)"\n', { mode: 0o755 });
    execFileSync(process.execPath, [path.join(root, 'scripts/install.mjs'), '--plugin-dir', plugins, '--openlogi', cli], { env: { ...process.env, HOME: home } });
    const output = execFileSync('/bin/sh', [path.join(plugins, 'openlogi.5m.sh')], { env, encoding: 'utf8' });
    expect(output).toMatch(/^72%/);
    expect(output).toContain('Mouse (Logitech receiver) — 72%');
  } finally { await rm(home, { recursive: true, force: true }); }
}, 15000);
