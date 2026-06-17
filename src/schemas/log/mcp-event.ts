/**
 * MCP (Model Context Protocol) tool / bearer-auth archetype — MCP server
 * lifecycle and request-auth events that are NOT OAuth flows (which live
 * in `./oauth-event.ts`).
 *
 * **PII posture**: none today. The `mcp_legacy_bearer_used` msg includes
 * the bearer-token presence but never the raw token (denylist defends).
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Msg literals this archetype absorbs. */
export const MCP_EVENT_MSGS = [
  "mcp_autogen_tool_error",
  "mcp_autogen_tools_registered",
  "mcp_bearer_invalid",
  "mcp_bearer_unconfigured",
  "mcp_legacy_bearer_used",
  "mcp_template_tool_error",
  "mcp_template_tools_registered",
] as const;

/** Discriminated msg union for MCP-archetype log records. */
export type McpEventMsg = (typeof MCP_EVENT_MSGS)[number];

/** Structured log entry for any MCP tool / bearer-auth event. */
export interface McpEventLogRecord {
  level: LogLevelType;
  msg: McpEventMsg;
  ts: string;
  tool?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link McpEventLogRecord}. */
export const McpEventLogRecordSchema: z.ZodType<McpEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(MCP_EVENT_MSGS),
  tool: z.string().optional(),
}).passthrough().meta({ title: "McpEventLogRecord" });
