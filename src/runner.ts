import { fork } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { lowestBatteryDevice, NO_HARDWARE_MESSAGE, onlineDevices, parseList } from "./model.js";
import type { OpenLogiDevice } from "./model.js";

export const STDOUT_LIMIT = 64 * 1024;
export const STDERR_LIMIT = 8 * 1024;
export const TIMEOUT_MS = 5000;
export type Result = { ok: true; devices: OpenLogiDevice[]; lowestDevice: OpenLogiDevice | null } | { ok: false; error: string };
export type RawResult = { stdout: string; stderr: string; exitCode: number | null; error?: string };
export type Command = { executable: string; args: string[]; timeoutMs?: number; env?: NodeJS.ProcessEnv };

export function conciseError(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > 180 ? `${clean.slice(0, 177)}…` : clean;
}

export function resolveExecutable(override?: string, home = homedir()): string {
  const expand = (p: string) => p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
  // Deliberately do not search the inherited GUI/shell PATH.
  const candidates = override ? [expand(override.trim())] : [
    "/opt/homebrew/bin/openlogi", "/usr/local/bin/openlogi", path.join(home, ".cargo/bin/openlogi"),
  ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const resolved = realpathSync(candidate);
      accessSync(resolved, constants.X_OK);
      if (statSync(resolved).isFile()) return resolved;
    } catch { /* Try the next conventional location. */ }
  }
  throw new Error(override ? "Configured OpenLogi CLI is not an executable absolute path" : "OpenLogi CLI not found; configure OPENLOGI_PATH or reinstall with --openlogi");
}

export function commandEnvironment(): NodeJS.ProcessEnv {
  // HOME/TMPDIR are needed for macOS user-local configuration/agent discovery.
  // Do not propagate Node, dynamic-loader or interactive-shell injection variables.
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", HOME: homedir() };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  return env;
}

export function interpret(raw: RawResult): Result {
  if (raw.error) return { ok: false, error: conciseError(raw.error) };
  if (raw.exitCode !== 0 && !(raw.exitCode === 2 && raw.stdout.includes(NO_HARDWARE_MESSAGE))) {
    return { ok: false, error: conciseError(raw.stderr || raw.stdout || `openlogi list failed with exit code ${raw.exitCode}`) };
  }
  const parsed = parseList(raw.stdout);
  if (!parsed.ok) return { ok: false, error: parsed.error! };
  const devices = onlineDevices(parsed.devices);
  return { ok: true, devices, lowestDevice: lowestBatteryDevice(devices) };
}

// The separate guard survives SIGKILL of the plugin. Losing its IPC parent
// triggers process-group cleanup, unlike a timeout in the parent alone.
export function execute(command: Command, signal?: AbortSignal): Promise<RawResult> {
  if (signal?.aborted) return Promise.resolve({ stdout: "", stderr: "", exitCode: null, error: "OpenLogi query cancelled" });
  return new Promise(resolve => {
    const guard = fork(new URL("./runner-worker.js", import.meta.url), [], {
      execArgv: [], env: commandEnvironment(), stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let result: RawResult | undefined;
    const cancel = () => { if (guard.connected) guard.disconnect(); };
    signal?.addEventListener("abort", cancel, { once: true });
    guard.on("message", message => { result = message as RawResult; });
    const finish = () => {
      signal?.removeEventListener("abort", cancel);
      resolve(result ?? { stdout: "", stderr: "", exitCode: null, error: signal?.aborted ? "OpenLogi query cancelled" : "OpenLogi command guard failed" });
    };
    guard.on("error", () => { result = { stdout: "", stderr: "", exitCode: null, error: "Could not start OpenLogi command guard" }; finish(); });
    // A parent-initiated IPC disconnect need not emit 'close'; the guard only
    // exits after its producer's streams close and the producer is reaped.
    guard.on("exit", finish);
    guard.send({ ...command, env: command.env ?? commandEnvironment() }, error => {
      if (error) cancel();
    });
  });
}

export async function readDevices(override?: string, signal?: AbortSignal): Promise<Result> {
  try {
    const executable = resolveExecutable(override);
    return interpret(await execute({ executable, args: ["list"] }, signal));
  } catch (error) {
    return { ok: false, error: conciseError(error instanceof Error ? error.message : "OpenLogi query failed") };
  }
}
