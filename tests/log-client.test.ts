/**
 * `app_version` on client logs (core#108).
 *
 * Both schemas are non-strict `z.object`s, so an undeclared key does not fail
 * a parse — it is STRIPPED. A client stamping `app_version` without these
 * declarations would pass manager's `accepts()` check and lose the field
 * before it reached VictoriaLogs, with nothing erroring. So the assertion is
 * that the value SURVIVES the parse, not merely that the parse succeeds.
 */

import { assertEquals } from "@std/assert";
import { ClientLogEntrySchema, ClientLogRecordSchema } from "../src/schemas/log/client.ts";

const APP_VERSION = "26.4.0+43ef172";

Deno.test("ClientLogEntrySchema: app_version survives the parse", () => {
  const parsed = ClientLogEntrySchema.parse({
    level: "info",
    msg: "page_view",
    ts: "2026-09-13T12:00:00.000Z",
    app: "manager",
    app_version: APP_VERSION,
  });
  assertEquals(parsed.app_version, APP_VERSION);
});

Deno.test("ClientLogEntrySchema: app_version is optional and bounded", () => {
  const base = { level: "info", msg: "page_view", ts: "2026-09-13T12:00:00.000Z", app: "manager" };
  assertEquals(ClientLogEntrySchema.safeParse(base).success, true);
  assertEquals(ClientLogEntrySchema.safeParse({ ...base, app_version: "x".repeat(101) }).success, false);
});

Deno.test("ClientLogRecordSchema: app_version is declared, not passthrough", () => {
  const record = {
    level: "info",
    msg: "client_log",
    ts: "2026-09-13T12:00:00.000Z",
    source: "browser",
    app: "manager",
    client_msg: "page_view",
    client_ts: "2026-09-13T12:00:00.000Z",
    client_level: "info",
    app_version: APP_VERSION,
  };
  assertEquals(ClientLogRecordSchema.parse(record).app_version, APP_VERSION);
  // Passthrough would also keep an unknown string; the declaration is what bounds it.
  assertEquals(ClientLogRecordSchema.safeParse({ ...record, app_version: "x".repeat(101) }).success, false);
});
