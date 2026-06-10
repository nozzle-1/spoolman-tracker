import fs from "node:fs";
import path from "node:path";

import { logger, setLogLevel } from "./logger.ts";
import type {
  AppConfig,
  BambuPrinterConfig,
  LogLevel,
  LoggingConfig,
  PrinterConfig,
  SpoolmanConfig,
  SupervisionConfig
} from "./types.ts";

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), "config.json");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid config: "${field}" must be a non-empty string`);
  }

  return value;
}

function ensureOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return ensureString(value, field);
}

function ensureOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Invalid config: "${field}" must be a boolean`);
  }

  return value;
}

function ensureOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid config: "${field}" must be a non-negative number`);
  }

  return value;
}

function ensureOptionalLogLevel(value: unknown, field: string): LogLevel | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== "debug" && value !== "info" && value !== "warn" && value !== "error") {
    throw new Error(`Invalid config: "${field}" must be one of debug, info, warn, error`);
  }

  return value;
}

function parseSpoolmanConfig(raw: unknown): SpoolmanConfig {
  if (!isObject(raw)) {
    throw new Error('Invalid config: "spoolman" section is required');
  }

  return {
    baseUrl: ensureString(raw.baseUrl, "spoolman.baseUrl").replace(/\/+$/, ""),
    apiKey: ensureOptionalString(raw.apiKey, "spoolman.apiKey"),
    timeoutMs: ensureOptionalNumber(raw.timeoutMs, "spoolman.timeoutMs")
  };
}

function parseSupervisionConfig(raw: unknown): SupervisionConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!isObject(raw)) {
    throw new Error('Invalid config: "supervision" must be an object');
  }

  return {
    probeIntervalMs: ensureOptionalNumber(raw.probeIntervalMs, "supervision.probeIntervalMs"),
    offlineBackoffMs: ensureOptionalNumber(raw.offlineBackoffMs, "supervision.offlineBackoffMs"),
    connectTimeoutMs: ensureOptionalNumber(raw.connectTimeoutMs, "supervision.connectTimeoutMs")
  };
}

function parseLoggingConfig(raw: unknown): LoggingConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }

  if (!isObject(raw)) {
    throw new Error('Invalid config: "logging" must be an object');
  }

  return {
    level: ensureOptionalLogLevel(raw.level, "logging.level")
  };
}

function parsePrinterConfig(raw: unknown, index: number): PrinterConfig {
  if (!isObject(raw)) {
    throw new Error(`Invalid config: "printers[${index}]" must be an object`);
  }

  const platform = ensureString(raw.platform, `printers[${index}].platform`);
  if (platform !== "bambulab") {
    throw new Error(`Invalid config: unsupported platform "${platform}" for printers[${index}]`);
  }

  const printer: BambuPrinterConfig = {
    id: ensureString(raw.id, `printers[${index}].id`),
    platform: "bambulab",
    enabled: ensureOptionalBoolean(raw.enabled, `printers[${index}].enabled`) ?? true,
    host: ensureString(raw.host, `printers[${index}].host`),
    serial: ensureString(raw.serial, `printers[${index}].serial`).toUpperCase(),
    accessCode: ensureString(raw.accessCode, `printers[${index}].accessCode`),
    username: ensureOptionalString(raw.username, `printers[${index}].username`),
    mqttPort: ensureOptionalNumber(raw.mqttPort, `printers[${index}].mqttPort`),
    mqttConnectTimeoutMs: ensureOptionalNumber(
      raw.mqttConnectTimeoutMs,
      `printers[${index}].mqttConnectTimeoutMs`
    ),
    mqttReconnectMs: ensureOptionalNumber(raw.mqttReconnectMs, `printers[${index}].mqttReconnectMs`),
    pushAllOnConnect: ensureOptionalBoolean(raw.pushAllOnConnect, `printers[${index}].pushAllOnConnect`)
  };

  return printer;
}

export function loadConfig(): AppConfig {
  const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  const absolutePath = path.resolve(configPath);
  logger.info("Loading configuration", { configPath: absolutePath });

  const raw = fs.readFileSync(absolutePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!isObject(parsed)) {
    throw new Error("Invalid config: root must be an object");
  }

  const logging = parseLoggingConfig(parsed.logging);
  if (logging?.level) {
    setLogLevel(logging.level);
  }

  const printersRaw = parsed.printers;
  if (!Array.isArray(printersRaw) || printersRaw.length === 0) {
    throw new Error('Invalid config: "printers" must be a non-empty array');
  }

  const config: AppConfig = {
    logging,
    spoolman: parseSpoolmanConfig(parsed.spoolman),
    supervision: parseSupervisionConfig(parsed.supervision),
    printers: printersRaw.map((printer, index) => parsePrinterConfig(printer, index))
  };

  const enabledCount = config.printers.filter((printer) => printer.enabled !== false).length;
  logger.info("Configuration loaded", {
    printerCount: config.printers.length,
    enabledPrinterCount: enabledCount
  });

  return config;
}
