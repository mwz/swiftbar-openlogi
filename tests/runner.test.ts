import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
// Exercise the same compiled guard and Node IPC path that the installed plugin uses.
import { execute, interpret, resolveExecutable, commandEnvironment } from '../dist/runner.js';

const directories: string[] = [];
async function temp() { const dir = await mkdtemp(path.join(tmpdir(), 'openlogi-test-')); directories.push(dir); return dir; }
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const run = (code: string, timeoutMs = 1500) => execute({ executable: process.execPath, args: ['-e', code], timeoutMs });

describe('bounded command execution', () => {
  it('accepts exact independent stream limits', async () => {
    const result = await run('process.stdout.write("x".repeat(65536)); process.stderr.write("e".repeat(8192))');
    expect(result.error).toBeUndefined();
    expect(result.stdout.length).toBe(65536);
    expect(result.stderr.length).toBe(8192);
  });
  it.each([['stdout', 65537], ['stderr', 8193]])('rejects excessive %s and discards partial output', async (stream, size) => {
    const result = await run(`process.stdout.write('partial'); process.${stream}.write('x'.repeat(${size})); setInterval(()=>{},1000)`);
    expect(result.error).toContain(`${stream} limit`);
    expect(result.stdout).toBe(''); expect(result.stderr).toBe('');
  });
  it('drains both streams concurrently', async () => {
    const result = await run("setInterval(()=>{process.stdout.write('x'.repeat(4096));process.stderr.write('e'.repeat(4096))},1)");
    expect(result.error).toContain('limit');
  });
  it('times out after stdout/stderr close too', async () => {
    const result = await run('process.stdout.end();process.stderr.end();setInterval(()=>{},1000)', 200);
    expect(result.error).toContain('timed out');
  });
  it('handles an exited leader whose descendant still owns the pipes', async () => {
    const code = `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}).unref();process.exit(0)`;
    const result = await run(code, 300);
    expect(result.error).toContain('timed out');
    expect(result.stdout).toBe('');
  });
  it('handles missing executable and non-zero producer status distinctly', async () => {
    expect((await execute({ executable: '/nonexistent/openlogi', args: [] })).error).toContain('Could not start');
    const result = await run('process.stderr.write("device busy");process.exit(122)');
    expect(result.error).toBeUndefined();
    expect(interpret(result)).toEqual({ ok: false, error: 'device busy' });
  });
  it('cancels a running command', async () => {
    const controller = new AbortController();
    const pending = execute({ executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, controller.signal);
    setTimeout(() => controller.abort(), 150);
    expect((await pending).error).toContain('cancelled');
  });
  it('kills the producer when its plugin parent is SIGKILLed', async () => {
    const dir = await temp();
    const marker = path.join(dir, 'heartbeat');
    const fixture = path.join(dir, 'owner.mjs');
    const runnerUrl = new URL('../dist/runner.js', import.meta.url).href;
    const producer = `setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'.'),20)`;
    await writeFile(fixture, `import {execute} from ${JSON.stringify(runnerUrl)};await execute({executable:process.execPath,args:['-e',${JSON.stringify(producer)}]});`);
    const { spawn } = await import('node:child_process');
    const owner = spawn(process.execPath, [fixture], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 100 && !(await readFile(marker).catch(() => null)); i++) await delay(20);
      expect((await readFile(marker)).length).toBeGreaterThan(0);
      const exited = new Promise(resolve => owner.once('close', resolve));
      owner.kill('SIGKILL'); await exited;
      await delay(150);
      const bytes = (await readFile(marker)).length;
      await delay(150);
      expect((await readFile(marker)).length).toBe(bytes);
    } finally { owner.kill('SIGKILL'); }
  });
});

describe('macOS executable discovery', () => {
  it('supports user-local executables and Homebrew-style symlinks', async () => {
    const dir = await temp(); const binary = path.join(dir, 'openlogi'); const link = path.join(dir, 'link');
    await writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); await symlink(binary, link);
    expect(resolveExecutable(link)).toBe(binary);
    expect(() => resolveExecutable('relative/openlogi')).toThrow();
    expect(() => resolveExecutable(path.join(dir, 'missing'))).toThrow();
  });
  it('does not inherit interpreter, shell or dynamic-loader injection variables', () => {
    process.env.NODE_OPTIONS = '--require=/tmp/evil';
    try { expect(commandEnvironment()).not.toHaveProperty('NODE_OPTIONS'); }
    finally { delete process.env.NODE_OPTIONS; }
    expect(commandEnvironment().LC_ALL).toBe('C');
    expect(commandEnvironment().HOME).toBeTruthy();
  });
});
