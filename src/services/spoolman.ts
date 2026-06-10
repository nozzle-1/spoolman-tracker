import { logger } from "../logger.ts";
import type { SpoolmanConfig, SpoolUpdate } from "../types.ts";

interface SpoolmanSpool {
  id: number;
  remaining_weight: string | number | null;
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

export class SpoolmanClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly spoolIdByTag = new Map<string, number>();

  constructor(config: SpoolmanConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async updateRemainingWeight(update: SpoolUpdate): Promise<void> {
    const spool = await this.findSpoolByTag(update.spoolTag);

    if (!spool) {
      logger.warn("Spoolman spool not found for tag", {
        printerId: update.printerId,
        tag: update.spoolTag
      });
      return;
    }

    const currentWeight = toNumber(spool.remaining_weight);
    if (currentWeight !== null && Math.round(currentWeight) === update.remainingWeight) {
      logger.debug("Skipping Spoolman update because weight is unchanged", {
        spoolId: spool.id,
        tag: update.spoolTag,
        remainingWeightG: update.remainingWeight
      });
      return;
    }

    if (currentWeight !== null && update.remainingWeight >= currentWeight) {
      logger.debug("Skipping Spoolman update because weight is not lower than current value", {
        spoolId: spool.id,
        tag: update.spoolTag,
        currentWeightG: currentWeight,
        remainingWeightG: update.remainingWeight
      });
      return;
    }

    await this.request(`/spool/${spool.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        remaining_weight: String(update.remainingWeight)
      })
    });

    logger.info("Updated Spoolman remaining weight", {
      printerId: update.printerId,
      spoolId: spool.id,
      tag: update.spoolTag,
      currentWeightG: currentWeight,
      remainingWeightG: update.remainingWeight,
      previousWeightG: update.previousWeight
    });
  }

  private async findSpoolByTag(tag: string): Promise<SpoolmanSpool | null> {
    const cachedId = this.spoolIdByTag.get(tag);
    if (cachedId !== undefined) {
      const spool = await this.request<SpoolmanSpool | null>(`/spool/${cachedId}`, { method: "GET" }, true);
      if (spool?.extra?.tag?.includes(tag)) {
        return spool;
      }

      this.spoolIdByTag.delete(tag);
    }

    const spools = await this.request<SpoolmanSpool[]>("/spool?allow_archived=false", { method: "GET" });
    const spool = spools.find((item) => item.extra?.tag?.includes(tag)) ?? null;

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
