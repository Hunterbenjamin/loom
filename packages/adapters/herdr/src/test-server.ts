import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export interface Request {
  id: string;
  method: string;
  params: Record<string, unknown>;
}
export type Handler = (
  req: Request,
  socket: Socket,
) => unknown | Promise<unknown>;
export async function fakeServer(handler: Handler) {
  const directory = await mkdtemp(join(tmpdir(), "lh-"));
  const path = join(directory, "s");
  const clients = new Set<Socket>();
  const requests: Request[] = [];
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf("\n");
      while (end >= 0) {
        const req = JSON.parse(buffer.slice(0, end)) as Request;
        buffer = buffer.slice(end + 1);
        requests.push(req);
        void Promise.resolve(handler(req, socket))
          .then((response) => {
            if (response !== undefined && !socket.destroyed)
              socket.write(
                `${JSON.stringify({ ...(response as object), id: req.id })}\n`,
              );
          })
          .catch(() => socket.destroy());
        end = buffer.indexOf("\n");
      }
    });
  });
  server.listen(path);
  await once(server, "listening");
  return {
    path,
    directory,
    requests,
    clients,
    async close() {
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function fixture(name: string, cwd: string): Promise<unknown> {
  return JSON.parse(
    (
      await readFile(
        new URL(`./fixtures/${name}.json`, import.meta.url),
        "utf8",
      )
    ).replaceAll("/fixture/work", cwd),
  );
}
// Executes only the generated function definition + local marker handshake, never a provider.
export async function acknowledgePrelude(req: Request) {
  await promisify(execFile)("/bin/bash", [
    "--noprofile",
    "--norc",
    "-c",
    String(req.params.text),
  ]);
  return { result: { type: "ok" } };
}
