import { createLogger } from "./logger.ts";
import { createPrinterRuntime } from "./platforms/index.ts";
import { probeTcpHost } from "./services/tcp-probe.ts";
import type { PrinterConfig, PrinterRuntime, SpoolUpdate, SupervisionConfig } from "./types.ts";
import { SpoolmanClient } from "./services/spoolman.ts";

const INFO_LIFECYCLE_EVENTS = new Set(["connected", "closed", "stopped"]);
const logger = createLogger("PrinterSupervisor");

interface RuntimeEntry {
  config: PrinterConfig;
  runtime: PrinterRuntime | null;
  stopping: boolean;
  nextProbeAt: number;
  consecutiveProbeFailures: number;
}

export class PrinterSupervisor {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly probeIntervalMs: number;
  private readonly offlineBackoffMs: number;
  private readonly connectTimeoutMs: number;
  private readonly spoolman: SpoolmanClient;
  private poller: NodeJS.Timeout | null = null;

  constructor(printers: PrinterConfig[], spoolman: SpoolmanClient, supervision: SupervisionConfig | undefined) {
    this.spoolman = spoolman;
    this.probeIntervalMs = supervision?.probeIntervalMs ?? 15_000;
    this.offlineBackoffMs = supervision?.offlineBackoffMs ?? 30_000;
    this.connectTimeoutMs = supervision?.connectTimeoutMs ?? 5_000;

    for (const printer of printers) {
      if (printer.enabled === false) {
        logger.info("Skipping disabled printer", { printerId: printer.id, platform: printer.platform });
        continue;
      }

      this.entries.set(printer.id, {
        config: printer,
        runtime: null,
        stopping: false,
        nextProbeAt: 0,
        consecutiveProbeFailures: 0
      });
    }
  }

  async start(): Promise<void> {
    logger.debug("Starting printer supervisor", {
      printerCount: this.entries.size,
      probeIntervalMs: this.probeIntervalMs,
      offlineBackoffMs: this.offlineBackoffMs
    });

    await this.tick();
    this.poller = setInterval(() => {
      this.tick().catch((error: unknown) => {
        logger.error("Supervisor tick failed", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, this.probeIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }

    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        if (entry.runtime) {
          entry.stopping = true;
          await entry.runtime.stop();
          entry.runtime = null;
        }
      })
    );

    logger.info("Printer supervisor stopped");
  }

  private async tick(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => this.reconcilePrinter(entry)));
  }

  private async reconcilePrinter(entry: RuntimeEntry): Promise<void> {
    const now = Date.now();
    if (now < entry.nextProbeAt) {
      return;
    }

    if (entry.runtime) {
      const status = entry.runtime.getStatus();
      entry.nextProbeAt = now + this.probeIntervalMs;

      if (status.connected) {
        entry.consecutiveProbeFailures = 0;
        return;
      }
    }

    const { config } = entry;
    const port = config.platform === "bambulab" ? config.mqttPort ?? 8883 : 0;

    const reachable = await probeTcpHost(config.host, port, this.connectTimeoutMs);
    if (!reachable) {
      entry.nextProbeAt = now + this.offlineBackoffMs;
      entry.consecutiveProbeFailures += 1;

      if (entry.runtime && !entry.stopping) {
        logger.warn("Printer probe failed while runtime is disconnected, stopping runtime", {
          printerId: config.id,
          host: config.host,
          port,
          consecutiveProbeFailures: entry.consecutiveProbeFailures
        });
        entry.stopping = true;
        await entry.runtime.stop();
        entry.runtime = null;
        entry.stopping = false;
      } else {
        logger.debug("Printer still unreachable", {
          printerId: config.id,
          host: config.host,
          port
        });
      }
      return;
    }

    entry.nextProbeAt = now + this.probeIntervalMs;
    entry.consecutiveProbeFailures = 0;

    if (entry.runtime) {
      return;
    }

    logger.debug("Printer reachable, starting runtime", {
      printerId: config.id,
      host: config.host,
      port
    });

    entry.runtime = createPrinterRuntime(config, {
      onLifecycle: (event) => {
        const method =
          event.level === "error"
            ? "error"
            : INFO_LIFECYCLE_EVENTS.has(event.event)
              ? "info"
              : "debug";
        logger[method](`Printer lifecycle: ${event.event}`, {
          printerId: event.printerId,
          platform: event.platform,
          ...event.details
        });
      },
      onSpoolUpdate: async (update: SpoolUpdate) => {
        await this.spoolman.updateRemainingWeight(update);
      }
    });

    await entry.runtime.start();
  }
}
