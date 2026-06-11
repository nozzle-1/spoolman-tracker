import { createLogger } from "../logger.ts";
import type { SpoolmanConfig, SpoolUpdate } from "../types.ts";

const logger = createLogger("SpoolmanClient");

interface SpoolmanSpool {
  id: number;
  remaining_weight: string | number | null;
  archived?: boolean;
  filament?: {
    material?: string | null;
    name?: string | null;
  };
  extra?: {
    tag?: string;
    [key: string]: unknown;
  };
}

function toNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeSpoolTag(tag: string | null | undefined): string | null {
  if (typeof tag !== "string") {
    return null;
  }

  const normalizedTag = tag.trim().replace(/^"+|"+$/g, "");
  return normalizedTag || null;
}

function isSameRemainingWeight(currentWeight: number | null, nextWeight: number): boolean {
  return currentWeight !== null && Math.round(currentWeight) === nextWeight;
}

function wouldIncreaseRemainingWeight(currentWeight: number | null, nextWeight: number): boolean {
  return currentWeight !== null && nextWeight >= currentWeight;
}

function isUnconfirmedEmptySpoolReading(currentWeight: number | null, update: SpoolUpdate): boolean {
  return currentWeight !== null && currentWeight > 0 && update.remainingWeight === 0 && update.previousWeight === null;
}

function extractSpoolInfoForLog(spool: SpoolmanSpool) {
  return {
    spoolId: spool.id,
    filament: [spool.filament?.material ?? '', spool.filament?.name ?? ''].join(' - ').trim() || null,
    tag: normalizeSpoolTag(spool.extra?.tag)
  };
}

export class SpoolmanClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly autoArchiveZeroWeightEnabled: boolean;
  private readonly autoArchiveZeroWeightIntervalMs: number;
  private readonly spoolIdByTag = new Map<string, number>();
  private autoArchiveTimer: NodeJS.Timeout | null = null;
  private autoArchiveRunning = false;

  constructor(config: SpoolmanConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.autoArchiveZeroWeightEnabled = config.autoArchiveEmptySpool?.enabled ?? false;
    this.autoArchiveZeroWeightIntervalMs = (config.autoArchiveEmptySpool?.intervalSeconds ?? 3600) * 1000;
  }

  async start(): Promise<void> {
    if (!this.autoArchiveZeroWeightEnabled || this.autoArchiveZeroWeightIntervalMs <= 0) {
      return;
    }

    logger.info("Starting automatic Spoolman archival task", {
      intervalMs: this.autoArchiveZeroWeightIntervalMs
    });

    await this.runAutoArchivePass();
    this.autoArchiveTimer = setInterval(() => {
      void this.runAutoArchivePass();
    }, this.autoArchiveZeroWeightIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.autoArchiveTimer) {
      clearInterval(this.autoArchiveTimer);
      this.autoArchiveTimer = null;
    }
  }

  async updateRemainingWeight(update: SpoolUpdate): Promise<void> {
    const normalizedTag = normalizeSpoolTag(update.spoolTag);
    
    if (!normalizedTag) {
      logger.warn("Skipping Spoolman update because spool tag is invalid", {
        printerId: update.printerId,
        tag: update.spoolTag
      });
      return;
    }

    const spool = await this.findSpoolByTag(normalizedTag);
    if (!spool) {
      logger.warn("Spoolman spool not found for tag", {
        printerId: update.printerId,
        tag: normalizedTag
      });
      return;
    }

    if (spool.archived) {
      logger.debug("Skipping Spoolman update because spool is archived", {
        ...extractSpoolInfoForLog(spool),
        printerId: update.printerId,
      });
      return;
    }

    const currentWeight = toNumber(spool.remaining_weight);
    const newWeight = update.remainingWeight;

    const logDetail = {
      ...extractSpoolInfoForLog(spool),
      previousWeight: currentWeight,
      remainingWeight: newWeight,
      printerId: update.printerId
    };

    if (isSameRemainingWeight(currentWeight, update.remainingWeight)) {
      logger.debug("Skipping Spoolman update because weight is unchanged", logDetail);
      return;
    }

    if (wouldIncreaseRemainingWeight(currentWeight, update.remainingWeight)) {
      logger.debug("Skipping Spoolman update because weight is not lower than current value", logDetail);
      return;
    }

    if (isUnconfirmedEmptySpoolReading(currentWeight, update)) {
      logger.warn("Skipping unconfirmed empty-spool reading", logDetail);
      return;
    }

    await this.request(`/spool/${spool.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        remaining_weight: String(update.remainingWeight)
      })
    });

    logger.info("Updated Spoolman remaining weight", logDetail);
  }

  async archiveZeroWeightSpools(): Promise<void> {
    const spools = await this.request<SpoolmanSpool[]>("/spool?allow_archived=false", { method: "GET" });
    const emptySpools = spools.filter((spool) => toNumber(spool.remaining_weight) === 0);

    if (emptySpools.length === 0) {
      logger.debug("No Spoolman spools to archive");
      return;
    }

    for (const spool of emptySpools) {
      await this.request(`/spool/${spool.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          archived: true
        })
      });
    }

    for (const [tag, spoolId] of this.spoolIdByTag.entries()) {
      if (emptySpools.some((spool) => spool.id === spoolId)) {
        this.spoolIdByTag.delete(tag);
      }
    }

    logger.info("Archived empty Spoolman spools", {
      archivedCount: emptySpools.length,
      spools: emptySpools.map((spool) => ({
        ...extractSpoolInfoForLog(spool),
      }))
    });
  }

  private async runAutoArchivePass(): Promise<void> {
    if (this.autoArchiveRunning) {
      logger.debug("Skipping Spoolman archival pass because the previous run is still active");
      return;
    }

    this.autoArchiveRunning = true;
    try {
      await this.archiveZeroWeightSpools();
    } catch (error: unknown) {
      logger.error("Automatic Spoolman archival task failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.autoArchiveRunning = false;
    }
  }

  private async findSpoolByTag(tag: string): Promise<SpoolmanSpool | null> {
    const cachedId = this.spoolIdByTag.get(tag);
    if (cachedId !== undefined) {
      const spool = await this.request<SpoolmanSpool | null>(`/spool/${cachedId}`, { method: "GET" }, true);
      if (normalizeSpoolTag(spool?.extra?.tag) === tag) {
        return spool;
      }

      this.spoolIdByTag.delete(tag);
    }

    const spools = await this.request<SpoolmanSpool[]>("/spool?allow_archived=true", { method: "GET" });
    const spool = spools.find((item) => normalizeSpoolTag(item.extra?.tag) === tag) ?? null;

    if (spool) {
      this.spoolIdByTag.set(tag, spool.id);
    }

    return spool;
  }

  private async request<T>(path: string, init: RequestInit, allow404 = false): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      if (init.body) {
        headers.set("Content-Type", "application/json");
      }
      if (this.apiKey) {
        headers.set("X-API-Key", this.apiKey);
      }

      const response = await fetch(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`, {
        ...init,
        headers,
        signal: controller.signal
      });

      if (allow404 && response.status === 404) {
        return null as T;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Spoolman request failed (${response.status}): ${body}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
