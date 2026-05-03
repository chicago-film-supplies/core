/**
 * Email verification token schema — Firestore collection: email-verifications
 * Tokens are single-use with a 24-hour expiry.
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** Full Firestore document for a single-use email verification token. */
export interface EmailVerification {
  user_id: string;
  email: string;
  expiresAt: FirestoreTimestampType;
  created_at: number;
}

/** Zod schema for EmailVerification. */
export const EmailVerificationSchema: z.ZodType<EmailVerification> = z.strictObject({
  user_id: z.string().min(1),
  email: z.email(),
  expiresAt: FirestoreTimestamp,
  created_at: z.number(),
}).meta({
  title: "Email Verification",
  collection: "email-verifications",
  displayDefaults: {
    columns: ["email", "expiresAt"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
