import { z } from "zod";

export const connectionConfig = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("fixtures") }),
  z.strictObject({ mode: z.literal("unconfigured"), message: z.string() }),
  z.strictObject({
    mode: z.literal("live"),
    instance: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    dataRoot: z.string().min(1),
    url: z.url({ protocol: /^ws$/ }),
    token: z.string().min(16).max(512),
  }),
]);
export type ConnectionConfig = z.output<typeof connectionConfig>;

/** Only main calls this: never expose the environment wholesale, or read a database. */
export function connectionFromEnvironment(
  env: Record<string, string | undefined>,
  fixtures: boolean,
): ConnectionConfig {
  if (fixtures) return { mode: "fixtures" };
  const bind = env.LOOM_BIND || "127.0.0.1:47800";
  if (!/^(\[[^\]]+\]|[^:/?#@]+):\d+$/.test(bind))
    return { mode: "unconfigured", message: "LOOM_BIND must be host:port" };
  const result = connectionConfig.safeParse({
    mode: "live",
    instance: env.LOOM_INSTANCE,
    dataRoot: env.LOOM_DATA_ROOT,
    url: `ws://${bind}`,
    token: env.LOOM_TOKEN,
  });
  return result.success
    ? result.data
    : {
        mode: "unconfigured",
        message:
          "Set LOOM_INSTANCE, LOOM_DATA_ROOT, LOOM_TOKEN and optionally LOOM_BIND, or use --fixtures",
      };
}
