import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { STDERR_LIMIT, STDOUT_LIMIT, TIMEOUT_MS } from "./runner.js";
import type { Command, RawResult } from "./runner.js";

let child: ChildProcessWithoutNullStreams | undefined;
let cancelled = false;
let timer: NodeJS.Timeout | undefined;
let failure: string | undefined;

function killGroup() {
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* Group has already exited. */ }
  }
}
function cancel() {
  cancelled = true;
  failure = "OpenLogi query cancelled";
  killGroup();
  if (!child) process.exit(1);
}
process.on("disconnect", cancel);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, cancel);

process.once("message", (message: Command) => {
  if (cancelled || !process.connected) return;
  const out: Buffer[] = [], err: Buffer[] = [];
  let stdoutSize = 0, stderrSize = 0;
  child = spawn(message.executable, message.args, {
    detached: true, cwd: "/", env: message.env, stdio: "pipe",
  });
  child.stdin.end();
  timer = setTimeout(() => { failure = "openlogi list timed out"; killGroup(); }, message.timeoutMs ?? TIMEOUT_MS);
  const collect = (chunk: Buffer, isOut: boolean) => {
    if (failure) return;
    if (isOut) stdoutSize += chunk.length; else stderrSize += chunk.length;
    if (stdoutSize > STDOUT_LIMIT || stderrSize > STDERR_LIMIT) {
      failure = stdoutSize > STDOUT_LIMIT ? "openlogi list exceeded the stdout limit" : "openlogi list exceeded the stderr limit";
      out.length = err.length = 0;
      killGroup();
    } else (isOut ? out : err).push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
  child.on("error", () => { failure = "Could not start OpenLogi CLI"; });
  // 'close', rather than 'exit', also waits for descendants holding the pipes.
  child.on("close", exitCode => {
    clearTimeout(timer);
    killGroup();
    const result: RawResult = failure
      ? { stdout: "", stderr: "", exitCode: null, error: failure }
      : { stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), exitCode };
    if (process.connected && !cancelled) {
      process.send!(result, () => { process.removeListener("disconnect", cancel); if (process.connected) process.disconnect(); });
    }
  });
});
