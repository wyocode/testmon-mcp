import { z } from "zod";

const ConfigSchema = z.object({
  domain: z
    .string()
    .min(1, "TESTMONITOR_DOMAIN is required (e.g. acme.testmonitor.com)")
    .regex(
      /^[a-z0-9.-]+\.[a-z]{2,}$/i,
      "TESTMONITOR_DOMAIN must be a bare host like 'acme.testmonitor.com' (no scheme, no path)",
    ),
  token: z.string().min(10, "TESTMONITOR_TOKEN is required"),
  defaultProjectId: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().default(15_000),
  readOnly: z.boolean().default(false),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

function parseBool(v: string | undefined, fallback = false): boolean {
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function parseInteger(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    domain: env.TESTMONITOR_DOMAIN ?? "",
    token: env.TESTMONITOR_TOKEN ?? "",
    defaultProjectId: parseInteger(env.TESTMONITOR_DEFAULT_PROJECT_ID),
    timeoutMs: parseInteger(env.TESTMONITOR_TIMEOUT_MS) ?? 15_000,
    readOnly: parseBool(env.TESTMONITOR_READONLY, false),
    logLevel: (env.LOG_LEVEL as Config["logLevel"]) ?? "info",
  });
}

export function baseUrl(config: Config): string {
  return `https://${config.domain}/api/v1`;
}
