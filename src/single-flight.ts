import { createHash } from "node:crypto";
import { lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const MAX_REPLY = 64 * 1024;
const uid = process.getuid?.() ?? 0;

export async function socketPath(key: string): Promise<string> {
  // Darwin sockaddr_un paths are short; the usual per-user TMPDIR can be too long.
  const directory = `/tmp/swiftbar-openlogi-${uid}`;
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077)) {
    throw new Error("OpenLogi refresh directory must be private and owned by the current user");
  }
  return `${directory}/${createHash("sha256").update(key).digest("hex").slice(0, 16)}.sock`;
}

function join(socket: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socket);
    const chunks: Buffer[] = [];
    let size = 0;
    client.setTimeout(10_000, () => client.destroy(new Error("OpenLogi refresh coordinator timed out")));
    client.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REPLY) client.destroy(new Error("OpenLogi refresh reply exceeded its limit"));
      else chunks.push(chunk);
    });
    client.on("error", reject);
    client.on("end", () => {
      // An explicit envelope distinguishes a genuinely empty inventory from a crashed leader.
      try { const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof data.menu !== "string") throw new Error();
        resolve(data.menu);
      } catch { reject(new Error("OpenLogi refresh coordinator stopped before completing")); }
    });
  });
}

function unavailable(error: unknown): boolean {
  return ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");
}

/** Share a single in-flight query between simultaneous SwiftBar invocations.
 * The completed menu lives only in memory. No daemon or battery cache is left behind.
 */
export async function singleFlight(socket: string, run: () => Promise<string>): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const clients = new Set<Socket>();
    const server = createServer(client => {
      clients.add(client);
      client.on("error", () => client.destroy());
      client.on("close", () => clients.delete(client));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, () => { server.removeListener("error", reject); resolve(); });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      try { return await join(socket); } catch (joinError) {
        if (!unavailable(joinError)) throw joinError;
        // Recover a socket left by SIGKILL, without deleting a newer leader's socket.
        const old = await lstat(socket).catch(() => null);
        await delay(50);
        try { return await join(socket); } catch (retryError) {
          if (!unavailable(retryError)) throw retryError;
          const current = await lstat(socket).catch(() => null);
          if (old && current && old.ino === current.ino && old.dev === current.dev && current.isSocket()) {
            await unlink(socket).catch(error => { if (error.code !== "ENOENT") throw error; });
          }
          continue;
        }
      }
    }
    try {
      const menu = await run();
      const reply = JSON.stringify({ menu });
      for (const client of clients) client.end(reply);
      return menu;
    } finally {
      // close stops accepting connections synchronously; clients already have their reply.
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        for (const client of clients) {
          if (!client.writableEnded) client.destroy();
          else client.setTimeout(1000, () => client.destroy());
        }
      });
    }
  }
  throw new Error("Could not coordinate the OpenLogi refresh; try Refresh again");
}
