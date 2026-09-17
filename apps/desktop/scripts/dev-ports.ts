import { createServer } from "node:net";
import { z } from "zod";

function port(value: string, name: string): number {
  return z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(value, {
      error: () => `${name} must be a port from 1 to 65535`,
    });
}

export function rendererServer(env: NodeJS.ProcessEnv) {
  return {
    host: "127.0.0.1",
    port: port(env.LOOM_RENDERER_PORT ?? "5173", "LOOM_RENDERER_PORT"),
    strictPort: true,
  };
}

// Chromium logs a debugging bind error but keeps running. Check before electron-vite launches
// it, so a conflicting LOOM_DEBUG_PORT fails the desktop command instead of hiding the failure.
export async function assertDevPortsAvailable(
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await assertAvailable(rendererServer(env).port, "LOOM_RENDERER_PORT");
  if (env.LOOM_DEBUG_PORT)
    await assertAvailable(
      port(env.LOOM_DEBUG_PORT, "LOOM_DEBUG_PORT"),
      "LOOM_DEBUG_PORT",
    );
}

async function assertAvailable(selected: number, name: string): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) =>
      reject(
        new Error(`Cannot listen on ${name}=${selected}: ${error.message}`, {
          cause: error,
        }),
      ),
    );
    server.listen(selected, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}
