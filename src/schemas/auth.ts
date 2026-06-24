/**
 * Auth endpoint input schemas — used by /auth routes.
 */
import { z } from "zod";
import { Email, NamePartsFields, type NameParts } from "./common.ts";

/**
 * Input schema for POST /auth/login.
 */
export interface LoginInputType {
  email: string;
  password: string;
}

export const LoginInput: z.ZodType<LoginInputType> = z.object({
  email: Email,
  password: z.string().min(1, "Password is required").meta({ pii: "redact" }),
});

/**
 * Input schema for POST /auth/register.
 *
 * Carries the split-name parts (`first_name` required, the rest optional) the
 * register route derives the denormalized `name` from via `deriveName()`. No
 * `name` field — inputs send parts; the server derives `name` at write time.
 */
export interface RegisterInputType extends NameParts {
  email: string;
  password: string;
}

export const RegisterInput: z.ZodType<RegisterInputType> = z.object({
  email: Email,
  ...NamePartsFields,
  password: z.string().min(8, "Password must be at least 8 characters").meta({ pii: "redact" }),
});

/**
 * Input schema for POST /auth/reset-password.
 */
export interface ResetPasswordInputType {
  token: string;
  password: string;
}

export const ResetPasswordInput: z.ZodType<ResetPasswordInputType> = z.object({
  token: z.string().min(1, "Token is required").meta({ pii: "redact" }),
  password: z.string().min(8, "Password must be at least 8 characters").meta({ pii: "redact" }),
});

/**
 * Input schema for POST /auth/forgot-password and POST /auth/resend-verification.
 */
export interface EmailInputType {
  email: string;
}

export const EmailInput: z.ZodType<EmailInputType> = z.object({
  email: Email,
});
