/**
 * OAuth 2.1 storage schemas for the MCP authorization server.
 *
 * Four Firestore collections, all keyed by opaque random ids (hashed at rest
 * where the id is also the bearer credential):
 *
 *   mcp-oauth-clients/{client_id}              — registered MCP clients (DCR)
 *   mcp-oauth-authorize-requests/{staging_id}  — short-lived handshake state
 *   mcp-oauth-codes/{sha256(code)}             — single-use authorization codes
 *   mcp-oauth-tokens/{sha256(token)}           — opaque access tokens
 *
 * `created_at` is epoch milliseconds (`Date.now()`), not a Firestore Timestamp.
 * `expiresAt` is a real Firestore Timestamp (drives TTL + sliding-window
 * extension), validated structurally via the shared `FirestoreTimestamp`.
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** A registered MCP client (dynamic client registration). */
export interface McpOAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: number;
}

/** Zod schema for McpOAuthClient. */
export const McpOAuthClientSchema: z.ZodType<McpOAuthClient> = z.strictObject({
  client_id: z.string().meta({ column: true, label: "Client ID" }),
  client_name: z.string().meta({ column: true, label: "Client" }),
  redirect_uris: z.array(z.url()).min(1),
  created_at: z.number(),
}).meta({
  title: "MCP OAuth Client",
  collection: "mcp-oauth-clients",
  // The doc id is `client_id` — an OAuth 2.1 / RFC 7591 wire name, on the one
  // surface whose job is to mirror an external spec. Renaming it to `uid` would
  // make our storage disagree with the protocol it implements.
  idField: "client_id",
  displayDefaults: {
    columns: ["client_name", "client_id"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});

/**
 * Short-lived staging state for an in-flight authorization request.
 *
 * `uid` is the Firestore document id. It was called `id` until core#58; see
 * `core/CLAUDE.md` § *UID property naming*.
 *
 * ⚠️ **Note the deliberate asymmetry with `client_id` two interfaces above**,
 * which does NOT get renamed. That one is an OAuth 2.1 / RFC 7591 wire name on
 * the one surface whose job is to mirror an external spec, so it is a sanctioned
 * carve-out. This field was only ever our own doc id under a non-conforming
 * name.
 *
 * Cheap to rename: a 10-minute TTL, and the read PARSES, so an unmigrated
 * document fails closed as a consent-page 404 rather than yielding `undefined`.
 * The blast radius is any handshake in flight across the deploy.
 */
export interface McpOAuthAuthorizeRequest {
  /** Firestore document id. */
  uid: string;
  user_uid: string;
  client_id: string;
  scope: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: "S256";
  created_at: number;
  expiresAt: FirestoreTimestampType;
}

/** Zod schema for McpOAuthAuthorizeRequest. */
export const McpOAuthAuthorizeRequestSchema: z.ZodType<McpOAuthAuthorizeRequest> = z.strictObject({
  uid: z.string(),
  user_uid: z.string().meta({ column: true, label: "User" }),
  client_id: z.string().meta({ column: true, label: "Client ID" }),
  scope: z.string(),
  redirect_uri: z.url(),
  state: z.string().optional(),
  code_challenge: z.string(),
  code_challenge_method: z.literal("S256"),
  created_at: z.number(),
  expiresAt: FirestoreTimestamp,
}).meta({
  title: "MCP OAuth Authorize Request",
  collection: "mcp-oauth-authorize-requests",
  displayDefaults: {
    columns: ["client_id", "user_uid"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});

/** A single-use authorization code (stored under sha256(code)). */
export interface McpOAuthCode {
  user_uid: string;
  client_id: string;
  scope: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  created_at: number;
  expiresAt: FirestoreTimestampType;
}

/** Zod schema for McpOAuthCode. */
export const McpOAuthCodeSchema: z.ZodType<McpOAuthCode> = z.strictObject({
  user_uid: z.string().meta({ column: true, label: "User" }),
  client_id: z.string().meta({ column: true, label: "Client ID" }),
  scope: z.string(),
  redirect_uri: z.url(),
  code_challenge: z.string(),
  code_challenge_method: z.literal("S256"),
  created_at: z.number(),
  expiresAt: FirestoreTimestamp,
}).meta({
  title: "MCP OAuth Code",
  collection: "mcp-oauth-codes",
  displayDefaults: {
    columns: ["client_id", "user_uid"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});

/** An opaque access token (stored under sha256(token)). */
export interface McpOAuthToken {
  user_uid: string;
  client_id: string;
  scope: string;
  created_at: number;
  expiresAt: FirestoreTimestampType;
}

/** Zod schema for McpOAuthToken. */
export const McpOAuthTokenSchema: z.ZodType<McpOAuthToken> = z.strictObject({
  user_uid: z.string().meta({ column: true, label: "User" }),
  client_id: z.string().meta({ column: true, label: "Client ID" }),
  scope: z.string(),
  created_at: z.number(),
  expiresAt: FirestoreTimestamp,
}).meta({
  title: "MCP OAuth Token",
  collection: "mcp-oauth-tokens",
  displayDefaults: {
    columns: ["client_id", "user_uid"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
