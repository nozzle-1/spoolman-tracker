export type PlatformName = "bambulab";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface SpoolmanConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  autoArchiveEmptySpool?: {
    enabled?: boolean;
    intervalSeconds?: number;
  };
}

export interface LoggingConfig {
  level?: LogLevel;
}

export interface SupervisionConfig {
  probeIntervalMs?: number;
  offlineBackoffMs?: number;
  connectTimeoutMs?: number;
}

export interface BasePrinterConfig {
  id: string;
  platform: PlatformName;
  enabled?: boolean;
}

export interface BambuPrinterConfig extends BasePrinterConfig {
  platform: "bambulab";
  host: string;
  serial: string;
  accessCode: string;
  username?: string;
  mqttPort?: number;
  mqttConnectTimeoutMs?: number;
  mqttReconnectMs?: number;
  mqttSessionDurationMs?: number;
  pushAllOnConnect?: boolean;
}

export type PrinterConfig = BambuPrinterConfig;

export interface AppConfig {
  logging?: LoggingConfig;
  spoolman: SpoolmanConfig;
  supervision?: SupervisionConfig;
  printers: PrinterConfig[];
}

export interface SpoolUpdate {
  printerId: string;
  spoolTag: string;
  remainingWeight: number;
  previousWeight: number | null;
}

export type LifecycleLevel = "info" | "warn" | "error";

export interface LifecycleEvent {
  printerId: string;
  platform: PlatformName;
  event: string;
  level: LifecycleLevel;
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface PrinterEventHandlers {
  onLifecycle(event: LifecycleEvent): void;
  onSpoolUpdate(update: SpoolUpdate): Promise<void>;
}

export interface PrinterRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): {
    printerId: string;
    platform: PlatformName;
    connected: boolean;
    trackedSpools: number;
  };
}
