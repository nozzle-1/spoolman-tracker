import { inspect } from "node:util";

import type { LogLevel } from "./types.ts";

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

let minimumLevel = LOG_LEVELS.info;
const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";

const LEVEL_STYLES: Record<LogLevel, { color: string; label: string }> = {
  debug: { color: "\u001b[32m", label: "DEBUG" },
  info: { color: "\u001b[36m", label: "INFO " },
  warn: { color: "\u001b[33m", label: "WARN " },
  error: { color: "\u001b[31m", label: "ERROR" }
};

function style(text: string, ...codes: string[]) {
  if (!useColor || codes.length === 0) {
    return text;
  }

  return `${codes.join("")}${text}${RESET}`;
}

function formatContext(context?: Record<string, unknown>) {
  if (!context) {
    return "";
  }

  return inspect(context, {
    depth: null,
    colors: useColor,
    compact: true,
    breakLength: Number.POSITIVE_INFINITY
  }).replace(/\s*\n\s*/g, " ");
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>) {
  if (LOG_LEVELS[level] < minimumLevel) {
    return;
  }

  const timestamp = style(new Date().toISOString(), DIM);
  const levelTag = style(LEVEL_STYLES[level].label, BOLD, LEVEL_STYLES[level].color);
  const renderedContext = formatContext(context);
  const line = renderedContext
    ? `${timestamp} ${levelTag} ${message} ${style(renderedContext, DIM)}`
    : `${timestamp} ${levelTag} ${message}`;

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

function createScopedLogger(scope: string): Logger {
  return {
    debug(message: string, context?: Record<string, unknown>) {
      emit("debug", `[${scope}] ${message}`, context);
    },
    info(message: string, context?: Record<string, unknown>) {
      emit("info", `[${scope}] ${message}`, context);
    },
    warn(message: string, context?: Record<string, unknown>) {
      emit("warn", `[${scope}] ${message}`, context);
    },
    error(message: string, context?: Record<string, unknown>) {
      emit("error", `[${scope}] ${message}`, context);
    }
  };
}

export function setLogLevel(level: LogLevel) {
  minimumLevel = LOG_LEVELS[level];
}

const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
if (envLevel && envLevel in LOG_LEVELS) {
  setLogLevel(envLevel);
}

export function createLogger(scope: string): Logger {
  return createScopedLogger(scope);
}
