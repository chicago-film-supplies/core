/**
 * Availability input schemas for stock summary lookups.
 */
import { z } from "zod";
import { chicagoInstant } from "./_datetime.ts";

export interface GetAvailabilityInputType {
  productUid: string;
  type: "rental" | "sale";
  start?: string;
  end?: string;
  date?: string;
}

export const GetAvailabilityInput: z.ZodType<GetAvailabilityInputType> = z.object({
  productUid: z.string().min(1),
  type: z.enum(["rental", "sale"]),
  start: chicagoInstant().optional(),
  end: chicagoInstant().optional(),
  date: z.iso.date().optional(),
});
