import "dotenv/config";

import { loadConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { SpoolmanClient } from "./services/spoolman.ts";
import { PrinterSupervisor } from "./supervisor.ts";
import { printStartupBanner } from "./banner.ts";

const logger = createLogger("App");

async function main() {
  printStartupBanner();
  const config = loadConfig();
  const spoolman = new SpoolmanClient(config.spoolman);
  const supervisor = new PrinterSupervisor(config.printers, spoolman, config.supervision);

  const shutdown = async (signal: string) => {
    logger.info("Shutdown requested", { signal });
    await supervisor.stop();
    await spoolman.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await spoolman.start();
  await supervisor.start();
}

main().catch((error: unknown) => {
  logger.error("Fatal startup error", {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
