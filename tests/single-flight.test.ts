import { it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { singleFlight } from '../src/single-flight.js';

const dirs: string[] = [];
// Only for execution environments that prohibit AF_UNIX listening. CI never sets this.
const socketIt = process.env.SWIFTBAR_SKIP_SOCKET_TESTS === '1' ? it.skip : it;
async function socket() { const dir = await mkdtemp('/tmp/ol-flight-'); dirs.push(dir); return dir + '/query.sock'; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

socketIt('coalesces simultaneous refreshes without writing readings to disk', async () => {
  const file = await socket(); let calls = 0;
  const run = async () => { calls++; await delay(100); return '72%\n---\nMouse'; };
  const results = await Promise.all(Array.from({ length: 20 }, () => singleFlight(file, run)));
  expect(calls).toBe(1); expect(new Set(results).size).toBe(1);
  await singleFlight(file, run); expect(calls).toBe(2);
});
socketIt('shares an intentionally empty menu', async () => {
  const file = await socket();
  expect(await Promise.all([singleFlight(file, async () => { await delay(100); return ''; }), singleFlight(file, async () => 'unexpected')])).toEqual(['', '']);
});
socketIt('recovers a socket left after abrupt termination', async () => {
  const file = await socket();
  const owner = spawn(process.execPath, ['-e', `const s=require('node:net').createServer();s.listen(${JSON.stringify(file)},()=>process.stdout.write('ready'));`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve, reject) => { owner.stdout.once('data', resolve); owner.once('error', reject); owner.once('exit', () => reject(new Error('Socket fixture failed to start'))); });
  const exited = new Promise(resolve => owner.once('close', resolve));
  owner.kill('SIGKILL'); await exited;
  expect(await singleFlight(file, async () => 'recovered')).toBe('recovered');
});
it('does not remove an unexpected non-socket file', async () => {
  const file = await socket(); await writeFile(file, 'keep me');
  await expect(singleFlight(file, async () => '')).rejects.toThrow();
});
