import crypto from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";

import { createLogger } from "../logger.ts";
import type {
  BambuPrinterConfig,
  LifecycleEvent,
  PrinterEventHandlers,
  PrinterRuntime,
  SpoolUpdate
} from "../types.ts";

function now(): string {
  return new Date().toISOString();
}

function correctRemainPercent(remainOn1kgBasis: unknown, trayWeight: unknown): number | null {
  const remain = Number(remainOn1kgBasis);
  const weight = Number(trayWeight);

  if (!Number.isFinite(remain)) {
    return null;
  }

  if (!Number.isFinite(weight) || weight <= 0) {
    return Math.max(0, Math.min(100, Math.round(remain)));
  }

  if (weight < 1000) {
    const gramsOn1kgBasis = (remain / 100) * 1000;
    const percent = (gramsOn1kgBasis / weight) * 100;
    return Math.max(0, Math.min(100, Math.round(percent)));
  }

  return Math.max(0, Math.min(100, Math.round(remain)));
}

function isUsableTrayUuid(trayUuid: string | undefined): trayUuid is string {
  return Boolean(trayUuid && !/^0+$/.test(trayUuid));
}

const logger = createLogger("BambuPrinterRuntime");

export class BambuPrinterRuntime implements PrinterRuntime {
  private readonly state = new Map<string, number>();
  private readonly reportTopic: string;
  private readonly requestTopic: string;
  private readonly clientId: string;
  private readonly config: BambuPrinterConfig;
  private readonly handlers: PrinterEventHandlers;
  private client: MqttClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private running = false;
  private connected = false;

  constructor(config: BambuPrinterConfig, handlers: PrinterEventHandlers) {
    this.config = config;
    this.handlers = handlers;
    this.reportTopic = `device/${config.serial}/report`;
    this.requestTopic = `device/${config.serial}/request`;
    this.clientId = `spoolman-tracker-${this.config.id}-${crypto.randomUUID()}`;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.openClient();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.connected = false;
    this.clearReconnectTimer();
    this.clearSessionTimer();

    if (!this.client) {
      return;
    }

    await this.disconnectClient();

    this.emitLifecycle("stopped", "info");
  }

  getStatus() {
    return {
      printerId: this.config.id,
      platform: this.config.platform,
      connected: this.connected,
      trackedSpools: this.state.size
    };
  }

  private openClient() {
    if (!this.running || this.client) {
      return;
    }

    this.emitLifecycle("connecting", "info", {
      host: this.config.host,
      port: this.config.mqttPort ?? 8883
    });

    this.client = mqtt.connect(`mqtts://${this.config.host}:${this.config.mqttPort ?? 8883}`, {
      username: this.config.username ?? "bblp",
      password: this.config.accessCode,
      clientId: this.clientId,
      protocolVersion: 4,
      clean: true,
      keepalive: 5,
      connectTimeout: this.config.mqttConnectTimeoutMs ?? 10_000,
      reconnectPeriod: this.usesPersistentSession() ? this.config.mqttReconnectMs ?? 5_000 : 0,
      resubscribe: false,
      rejectUnauthorized: false
    });

    this.client.on("connect", () => {
      this.connected = true;
      this.clearReconnectTimer();
      this.emitLifecycle("connected", "info", {
        reportTopic: this.reportTopic,
        requestTopic: this.requestTopic
      });
      this.scheduleSessionClose();

      this.client?.subscribe(this.reportTopic, { qos: 0 }, (error) => {
        if (error) {
          this.emitLifecycle("subscribe_error", "error", { message: error.message });
          return;
        }

        this.emitLifecycle("subscribed", "info", { topic: this.reportTopic });
        if (this.config.pushAllOnConnect !== false) {
          this.requestPushAll();
        }
      });
    });

    this.client.on("reconnect", () => {
      this.emitLifecycle("reconnecting", "info");
    });

    this.client.on("close", () => {
      this.client = null;
      this.connected = false;
      this.clearSessionTimer();
      this.emitLifecycle("closed", "info");
      if (!this.usesPersistentSession()) {
        this.scheduleReconnect();
      }
    });

    this.client.on("error", (error) => {
      this.emitLifecycle("mqtt_error", "error", {
        message: error.message,
        name: error.name
      });
    });

    this.client.on("message", (topic, payload) => {
      this.handleMessage(topic, payload.toString("utf8")).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Failed to process Bambu payload", {
          printerId: this.config.id,
          topic,
          message
        });
      });
    });
  }

  private usesPersistentSession() {
    return (this.config.mqttSessionDurationMs ?? 0) <= 0;
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearSessionTimer() {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  private scheduleReconnect() {
    if (!this.running || this.client || this.reconnectTimer) {
      return;
    }

    const delayMs = this.config.mqttReconnectMs ?? 5_000;
    this.emitLifecycle("reconnect_scheduled", "info", { delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openClient();
    }, delayMs);
  }

  private scheduleSessionClose() {
    if (this.usesPersistentSession()) {
      return;
    }

    const durationMs = this.config.mqttSessionDurationMs ?? 0;
    this.clearSessionTimer();
    this.sessionTimer = setTimeout(() => {
      const client = this.client;
      this.sessionTimer = null;
      if (!this.running || !client) {
        return;
      }

      this.emitLifecycle("session_expired", "info", { durationMs });
      void this.disconnectClient();
    }, durationMs);
  }

  private async disconnectClient() {
    const client = this.client;
    this.client = null;
    if (!client) {
      return;
    }

    await new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) {
          return;
        }
        resolved = true;
        resolve();
      };

      const fallback = setTimeout(() => {
        client.end(true, {}, finish);
      }, 2_000);

      client.end(false, {}, () => {
        clearTimeout(fallback);
        finish();
      });
    });
  }

  private requestPushAll() {
    const payload = JSON.stringify({
      pushing: {
        command: "pushall",
        sequence_id: "0",
        version: 1
      }
    });

    this.client?.publish(this.requestTopic, payload, { qos: 0 }, (error) => {
      if (error) {
        this.emitLifecycle("pushall_error", "error", { message: error.message });
        return;
      }

      this.emitLifecycle("pushall_requested", "info", { topic: this.requestTopic });
    });
  }

  private async handleMessage(topic: string, raw: string): Promise<void> {
    const payload = JSON.parse(raw) as {
      print?: {
        ams?: {
          ams?: Array<{
            id?: string | number;
            tray?: Array<Record<string, unknown>>;
          }>;
        };
      };
    };

    const amsEntries = payload.print?.ams?.ams;
    if (!Array.isArray(amsEntries)) {
      return;
    }

    for (const ams of amsEntries) {
      if (!Array.isArray(ams.tray)) {
        continue;
      }

      for (const tray of ams.tray) {
        if (tray.state !== 3) {
          continue;
        }

        const trayUuid = typeof tray.tray_uuid === "string" ? tray.tray_uuid : "";
        if (!isUsableTrayUuid(trayUuid)) {
          this.emitLifecycle("missing_tray_uuid", "warn", {
            amsId: ams.id ?? "unknown",
            trayId: tray.id ?? "unknown"
          });
          continue;
        }

        const trayWeight = Number(tray.tray_weight);
        const remainPercent = correctRemainPercent(tray.remain, trayWeight);
        if (remainPercent === null || !Number.isFinite(trayWeight) || trayWeight <= 0) {
          continue;
        }

        const remainingWeightG = Math.round((remainPercent / 100) * trayWeight);
        const spoolKey = `${ams.id ?? "unknown"}:${tray.id ?? "unknown"}:${trayUuid}`;
        const previousWeightG = this.state.get(spoolKey);

        if (previousWeightG === remainingWeightG) {
          continue;
        }

        this.state.set(spoolKey, remainingWeightG);

        const update: SpoolUpdate = {
          printerId: this.config.id,
          spoolTag: trayUuid,
          remainingWeight: remainingWeightG,
          previousWeight: previousWeightG ?? null
        };

        logger.debug("Detected spool weight change", {
          printerId: this.config.id,
          serial: this.config.serial,
          spoolTag: trayUuid,
          remainingWeight: remainingWeightG,
          previousWeight: previousWeightG ?? null,
          delta: previousWeightG === undefined ? 0 : remainingWeightG - previousWeightG,
          topic
        });

        await this.handlers.onSpoolUpdate(update);
      }
    }
  }

  private emitLifecycle(
    event: string,
    level: LifecycleEvent["level"],
    details?: Record<string, unknown>
  ) {
    this.handlers.onLifecycle({
      printerId: this.config.id,
      platform: "bambulab",
      event,
      level,
      timestamp: now(),
      details
    });
  }
}
