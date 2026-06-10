import { BambuPrinterRuntime } from "./bambulab.ts";
import type { PrinterConfig, PrinterEventHandlers, PrinterRuntime } from "../types.ts";

export function createPrinterRuntime(
  config: PrinterConfig,
  handlers: PrinterEventHandlers
): PrinterRuntime {
  switch (config.platform) {
    case "bambulab":
      return new BambuPrinterRuntime(config, handlers);
    default:
      throw new Error(`Unsupported printer platform: ${(config as PrinterConfig).platform}`);
  }
}
