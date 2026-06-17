/**
 * Card aggregate events.
 */
import type { EventEnvelope } from "./common.ts";
import type { Card } from "../card.ts";
import type { List } from "../list.ts";

export type CardCreated = EventEnvelope<Card> & { event: "card.created" };
export type CardUpdated = EventEnvelope<Card> & { event: "card.updated" };
export type CardDeleted = EventEnvelope<Card> & { event: "card.deleted" };

export type ListCreated = EventEnvelope<List> & { event: "list.created" };
export type ListUpdated = EventEnvelope<List> & { event: "list.updated" };
export type ListDeleted = EventEnvelope<List> & { event: "list.deleted" };
