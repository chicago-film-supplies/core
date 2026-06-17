/**
 * Organization aggregate events.
 */
import type { EventEnvelope } from "./common.ts";
import type { Organization } from "../organization.ts";

export type OrganizationCreated = EventEnvelope<Organization> & { event: "organization.created" };
export type OrganizationUpdated = EventEnvelope<Organization> & { event: "organization.updated" };
