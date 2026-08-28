import { createHash } from "node:crypto";

export type SafeLogValue = string | number | boolean | null;

export interface SanitizedLogger {
  info(event: string, fields?: Readonly<Record<string, SafeLogValue>>): void;
  warn(event: string, fields?: Readonly<Record<string, SafeLogValue>>): void;
  error(event: string, fields?: Readonly<Record<string, SafeLogValue>>): void;
}

export function safeReference(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function write(
  level: "info" | "warn" | "error",
  event: string,
  fields: Readonly<Record<string, SafeLogValue>> = {},
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export class ConsoleSanitizedLogger implements SanitizedLogger {
  info(event: string, fields?: Readonly<Record<string, SafeLogValue>>): void {
    write("info", event, fields);
  }

  warn(event: string, fields?: Readonly<Record<string, SafeLogValue>>): void {
    write("warn", event, fields);
  }

  error(event: string, fields?: Readonly<Record<string, SafeLogValue>>): void {
    write("error", event, fields);
  }
}

export class NoopSanitizedLogger implements SanitizedLogger {
  info(_event: string, _fields?: Readonly<Record<string, SafeLogValue>>): void {}
  warn(_event: string, _fields?: Readonly<Record<string, SafeLogValue>>): void {}
  error(_event: string, _fields?: Readonly<Record<string, SafeLogValue>>): void {}
}
