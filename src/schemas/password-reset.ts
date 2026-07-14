/**
 * Password reset token schema — Firestore collection: password-resets
 * Tokens are single-use with a 1-hour expiry.
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** Full Firestore document for a single-use password reset token. */
export interface PasswordReset {
  user_id: string;
  email: string;
  expiresAt: FirestoreTimestampType;
  created_at: number;
}

/** Zod schema for PasswordReset. */
export const PasswordResetSchema: z.ZodType<PasswordReset> = z.strictObject({
  // Internal Firestore uid, not customer data — same call as `log/base.ts`.
  user_id: z.string().min(1).meta({ pii: "none" }),
  // Tagged in place rather than swapped for the `Email` primitive from
  // `common.ts`: `Email` adds `.max(254)`, and tightening validation on a live
  // document schema is a breaking change this PII fix has no business making.
  // Consolidating onto the primitive is worth doing — as its own commit.
  email: z.email().meta({ pii: "mask" }),
  expiresAt: FirestoreTimestamp,
  created_at: z.number(),
}).meta({
  title: "Password Reset",
  collection: "password-resets",
  displayDefaults: {
    columns: ["email"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
