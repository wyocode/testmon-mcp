import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./util/logger.js";
import { TestMonitorClient } from "./client/testmonitor.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    // Config errors must go to stderr — stdout is reserved for MCP framing.
    process.stderr.write(
      `[testmon-mcp] fatal: invalid configuration\n${
        e instanceof Error ? e.message : String(e)
      }\n\nRequired environment variables:\n` +
        `  TESTMONITOR_DOMAIN   e.g. acme.testmonitor.com\n` +
        `  TESTMONITOR_TOKEN    Personal Access Token (Bearer)\n` +
        `Optional:\n` +
        `  TESTMONITOR_DEFAULT_PROJECT_ID, TESTMONITOR_TIMEOUT_MS,\n` +
        `  TESTMONITOR_READONLY (=true to hide write tools), LOG_LEVEL\n`,
    );
    process.exit(2);
  }

  const logger = createLogger(config);
  logger.info(
    `Starting testmon-mcp for ${config.domain} (readOnly=${config.readOnly})`,
  );

  const client = new TestMonitorClient({ config, logger });
  const server = buildServer({ client, config, logger });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = (signal: string) => {
    logger.info(`Received ${signal}; shutting down.`);
    server
      .close()
      .catch((e) => logger.error("Error during shutdown", e))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  process.stderr.write(
    `[testmon-mcp] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`,
  );
  process.exit(1);
});
