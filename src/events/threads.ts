/**
 * Threads & comments aggregate events.
 */
import type { EventEnvelope } from "./common.ts";
import type { Thread } from "../thread.ts";
import type { Comment } from "../comment.ts";

export type ThreadCreated = EventEnvelope<Thread> & { event: "thread.created" };
export type ThreadUpdated = EventEnvelope<Thread> & { event: "thread.updated" };

export type CommentCreated = EventEnvelope<Comment> & { event: "comment.created" };
export type CommentUpdated = EventEnvelope<Comment> & { event: "comment.updated" };
export type CommentDeleted = EventEnvelope<Comment> & { event: "comment.deleted" };
