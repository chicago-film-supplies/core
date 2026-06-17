/**
 * Contact aggregate events.
 */
import type { EventEnvelope } from "./common.ts";
import type { Contact } from "../contact.ts";

export type ContactCreated = EventEnvelope<Contact> & { event: "contact.created" };
export type ContactUpdated = EventEnvelope<Contact> & { event: "contact.updated" };
