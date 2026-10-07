#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { access, chmod, cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const MARKER = '# swiftbar-openlogi managed launcher';
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: {
  'plugin-dir': { type: 'string' }, openlogi: { type: 'string' }, node: { type: 'string' },
  uninstall: { type: 'boolean' }, help: { type: 'boolean' },
}});
if (values.help) {
  console.log('node scripts/install.mjs --plugin-dir <SwiftBar folder> [--openlogi <absolute path>] [--node <absolute path>] [--uninstall]');
  process.exit(0);
}
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const expand = value => value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value;
async function readOptional(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function executable(value) {
  const file = expand(value);
  if (!path.isAbsolute(file)) throw new Error('Executable paths must be absolute');
  await access(file, constants.X_OK);
  if (!(await stat(file)).isFile()) throw new Error('Executable path is not a regular file');
  return file;
}
async function atomicWrite(file, contents, mode = 0o600) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, { mode }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or later is required');
  if (!values['plugin-dir']) throw new Error('Specify the folder selected in SwiftBar using --plugin-dir');
  const requested = path.resolve(expand(values['plugin-dir']));
  await mkdir(requested, { recursive: true });
  const pluginDir = await realpath(requested);
  const support = path.join(homedir(), 'Library/Application Support/swiftbar-openlogi', createHash('sha256').update(pluginDir).digest('hex').slice(0, 16));
  const launcher = path.join(pluginDir, 'openlogi.5m.sh');
  const current = await readOptional(launcher);
  if (current !== null && !current.includes(MARKER)) throw new Error('Refusing to overwrite an unrelated openlogi.5m.sh');
  if (values.uninstall) {
    if (current !== null) await rm(launcher);
    // This per-folder directory contains only this installer's generated files.
    await rm(support, { recursive: true, force: true });
    console.log('Removed OpenLogi plugin. SwiftBar, Node and OpenLogi were left installed.');
    return;
  }
  // Capture a conventional stable Node path when it points to this interpreter.
  let node = process.execPath;
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try { if (await realpath(candidate) === await realpath(process.execPath)) { node = candidate; break; } } catch { /* absent */ }
  }
  node = await executable(values.node ?? node);
  const major = Number(execFileSync(node, ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8' }).trim());
  if (!Number.isFinite(major) || major < 24) throw new Error('Selected Node runtime must be version 24 or later');
  const savedConfig = await readOptional(path.join(support, 'config.json'));
  const config = savedConfig ? JSON.parse(savedConfig) : {};
  if (values.openlogi) config.openlogiPath = await executable(values.openlogi);
  const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], { stdio: 'inherit' });
  await mkdir(support, { recursive: true, mode: 0o700 });
  await chmod(support, 0o700);
  // Versioned code directories make the launcher switch atomic during updates.
  const digest = createHash('sha256');
  for (const file of (await readdir(path.join(root, 'dist'))).sort()) {
    digest.update(file).update(await readFile(path.join(root, 'dist', file)));
  }
  const release = path.join(support, `app-${digest.digest('hex').slice(0, 16)}`);
  if (!(await stat(release).catch(() => null))) {
    const staging = `${release}.${randomUUID()}.tmp`;
    try {
      await mkdir(staging);
      await cp(path.join(root, 'dist'), path.join(staging, 'dist'), { recursive: true });
      await writeFile(path.join(staging, 'package.json'), '{"type":"module"}\n');
      await rename(staging, release);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  await atomicWrite(path.join(support, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const script = [
    '#!/bin/sh', MARKER,
    '# <xbar.title>OpenLogi Batteries</xbar.title>',
    `# <xbar.version>${pkg.version}</xbar.version>`,
    '# <xbar.author>mwz</xbar.author>',
    '# <xbar.desc>Read-only local device battery levels from OpenLogi.</xbar.desc>',
    '# <xbar.dependencies>node,openlogi</xbar.dependencies>',
    '# <xbar.var>string(OPENLOGI_PATH=""): Optional absolute OpenLogi CLI path.</xbar.var>',
    '# <swiftbar.refreshOnOpen>true</swiftbar.refreshOnOpen>',
    '# <swiftbar.runInBash>false</swiftbar.runInBash>',
    // Node must not inherit interpreter injection settings from a login shell.
    'unset NODE_OPTIONS NODE_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH LD_PRELOAD',
    `if [ ! -x ${shellQuote(node)} ]; then`,
    "  printf '%s\\n' '? | sfimage=exclamationmark.triangle' '---' 'Node runtime missing; reinstall the OpenLogi plugin' '---' 'Refresh | refresh=true'",
    '  exit 0', 'fi',
    `exec ${shellQuote(node)} ${shellQuote(path.join(release, 'dist/cli.js'))} ${shellQuote(path.join(support, 'config.json'))}`,
    '',
  ].join('\n');
  await atomicWrite(launcher, script, 0o755);
  console.log(`Installed ${launcher}\nChoose Refresh All in SwiftBar. Enable launch at login in SwiftBar if desired.`);
  // Older generated releases are kept until uninstall, so an in-flight invocation
  // cannot lose its guard module halfway through an update. They contain no readings.
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
