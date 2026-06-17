import { assertEquals } from "@std/assert";
import {
  CommentSchema,
  CreateCommentInput,
  UpdateCommentInput,
  CommentReactionInput,
} from "../src/schemas/comment.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const tiptapBody = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const validComment = {
  uid: "comment1000000000000",
  uid_thread: "thread10000000000000",
  sources: [{ collection: "orders", uid: "order100000000000000" }],
  body: tiptapBody,
  body_text: "Hello",
  reactions: {},
  created_by: { uid: "user1000000000000000", name: "Alex" },
  deleted_at: null,
  deleted_by: null,
  updated_by: { uid: "user1000000000000000", name: "Alex" },
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("CommentSchema validates a complete comment", () => {
  assertEquals(CommentSchema.safeParse(validComment).success, true);
});

Deno.test("CommentSchema accepts reactions map", () => {
  const doc = {
    ...validComment,
    reactions: {
      "👍": {
        "user1000000000000000": { uid: "user1000000000000000", name: "Alex" },
        "user2000000000000000": { uid: "user2000000000000000", name: "Bob" },
      },
    },
  };
  assertEquals(CommentSchema.safeParse(doc).success, true);
});

Deno.test("CommentSchema rejects legacy uid-array reactions", () => {
  const doc = { ...validComment, reactions: { "👍": ["user1000000000000000", "user2000000000000000"] } };
  assertEquals(CommentSchema.safeParse(doc).success, false);
});

Deno.test("CommentSchema rejects empty sources array", () => {
  const doc = { ...validComment, sources: [] };
  assertEquals(CommentSchema.safeParse(doc).success, false);
});

Deno.test("CommentSchema accepts soft-deleted comment", () => {
  const doc = {
    ...validComment,
    deleted_at: null,
    deleted_by: { uid: "user2000000000000000", name: "Bob" },
  };
  assertEquals(CommentSchema.safeParse(doc).success, true);
});

const gitMirror = {
  comment_id: 123456,
  node_id: "IC_node",
  html_url: "https://github.com/chicago-film-supplies/templates/issues/1#issuecomment-123456",
  synced_at: mockTimestamp,
};

Deno.test("CommentSchema accepts git mirror on a templates-versions comment", () => {
  const doc = {
    ...validComment,
    sources: [{ collection: "templates-versions", uid: "version1000000000000" }],
    git: gitMirror,
  };
  assertEquals(CommentSchema.safeParse(doc).success, true);
});

Deno.test("CommentSchema accepts git mirror on a template-components comment", () => {
  const doc = {
    ...validComment,
    sources: [{ collection: "template-components", uid: "component10000000000" }],
    git: gitMirror,
  };
  assertEquals(CommentSchema.safeParse(doc).success, true);
});

Deno.test("CommentSchema rejects git mirror on a non-template comment", () => {
  const doc = { ...validComment, git: gitMirror }; // sources: orders
  assertEquals(CommentSchema.safeParse(doc).success, false);
});

Deno.test("CommentSchema rejects a git mirror missing comment_id", () => {
  const { comment_id: _omit, ...partial } = gitMirror;
  const doc = {
    ...validComment,
    sources: [{ collection: "templates", uid: "family10000000000000" }],
    git: partial,
  };
  assertEquals(CommentSchema.safeParse(doc).success, false);
});

Deno.test("CreateCommentInput requires body_text", () => {
  assertEquals(
    CreateCommentInput.safeParse({
      uid_thread: "thread10000000000000",
      body: tiptapBody,
      body_text: "",
    }).success,
    false,
  );
});

Deno.test("CreateCommentInput accepts valid input", () => {
  assertEquals(
    CreateCommentInput.safeParse({
      uid_thread: "thread10000000000000",
      body: tiptapBody,
      body_text: "Hello",
    }).success,
    true,
  );
});

Deno.test("UpdateCommentInput accepts body edit", () => {
  assertEquals(
    UpdateCommentInput.safeParse({ body: tiptapBody, body_text: "Edited", version: 1 }).success,
    true,
  );
});

Deno.test("UpdateCommentInput rejects missing version", () => {
  assertEquals(
    UpdateCommentInput.safeParse({ body: tiptapBody, body_text: "Edited" }).success,
    false,
  );
});

Deno.test("CommentReactionInput accepts add/remove actions", () => {
  assertEquals(
    CommentReactionInput.safeParse({ emoji: "👍", action: "add" }).success,
    true,
  );
  assertEquals(
    CommentReactionInput.safeParse({ emoji: "❤️", action: "remove" }).success,
    true,
  );
});

Deno.test("CommentReactionInput rejects unknown action", () => {
  assertEquals(
    CommentReactionInput.safeParse({ emoji: "👍", action: "toggle" }).success,
    false,
  );
});
