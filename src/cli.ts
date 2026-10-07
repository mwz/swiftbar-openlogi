import { readFile } from "node:fs/promises";
import { readDevices, conciseError } from "./runner.js";
import { render } from "./render.js";
import { singleFlight, socketPath } from "./single-flight.js";

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => controller.abort());

async function main(): Promise<string> {
  let configuredPath: string | undefined;
  if (process.argv[2]) {
    const config = JSON.parse(await readFile(process.argv[2], "utf8"));
    if (config.openlogiPath !== undefined && typeof config.openlogiPath !== "string") throw new Error("Invalid OpenLogi configuration");
    configuredPath = config.openlogiPath;
  }
  configuredPath = process.env.OPENLOGI_PATH?.trim() || configuredPath;
  const socket = await socketPath(configuredPath ?? "default");
  return singleFlight(socket, async () => render(await readDevices(configuredPath, controller.signal)));
}

try {
  const menu = await main();
  if (!controller.signal.aborted) process.stdout.write(menu);
} catch (error) {
  process.stdout.write(render({ ok: false, error: conciseError(error instanceof Error ? error.message : "OpenLogi plugin failed") }));
}
