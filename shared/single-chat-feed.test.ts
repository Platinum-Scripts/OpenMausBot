import { describe, expect, it } from "vitest";

import { orderFeed, singleChatFeedTarget, singleChatFeedThreads } from "./single-chat-feed.ts";

const task = (threadId: string, updatedAt: number, extra: { archivedAt?: number; routineRunId?: string } = {}) =>
  ({ threadId, createdAt: 1, updatedAt, ...extra });

describe("singleChatFeedThreads", () => {
  it("keeps every conversation but a routine's detached run and an archived one", () => {
    const tasks = [task("main", 30), task("topic", 20), task("run", 40, { routineRunId: "r1" }), task("old", 10, { archivedAt: 5 })];
    expect(singleChatFeedThreads(tasks, "main").map((t) => t.threadId)).toEqual(["main", "topic"]);
  });

  it("keeps the open conversation even when it is archived", () => {
    const tasks = [task("main", 30), task("old", 10, { archivedAt: 5 })];
    expect(singleChatFeedThreads(tasks, "old").map((t) => t.threadId)).toEqual(["main", "old"]);
  });
});

describe("singleChatFeedTarget", () => {
  it("is the conversation with the newest message", () => {
    expect(singleChatFeedTarget({ threadId: "main", tasks: [task("main", 10), task("topic", 20)] })).toBe("topic");
  });

  it("skips archived conversations and routine runs", () => {
    const tasks = [task("main", 10), task("run", 50, { routineRunId: "r1" }), task("old", 40, { archivedAt: 41 })];
    expect(singleChatFeedTarget({ threadId: "main", tasks })).toBe("main");
  });

  it("keeps the open conversation on a tie", () => {
    expect(singleChatFeedTarget({ threadId: "b", tasks: [task("a", 10), task("b", 10)] })).toBe("b");
  });

  it("falls back to createdAt, then to the open conversation", () => {
    expect(singleChatFeedTarget({ threadId: "a", tasks: [{ threadId: "a", createdAt: 1 }, { threadId: "b", createdAt: 2 }] })).toBe("b");
    expect(singleChatFeedTarget({ threadId: "a" })).toBe("a");
    expect(singleChatFeedTarget({ threadId: "a", tasks: [task("b", 5, { archivedAt: 6 })] })).toBe("a");
  });
});

describe("orderFeed", () => {
  it("merges conversations oldest first, tagging each message with its conversation", () => {
    const merged = orderFeed([
      { threadId: "a", messages: [{ id: "a1", at: 1 }, { id: "a2", at: 5 }] },
      { threadId: "b", messages: [{ id: "b1", at: 3 }, { id: "b2", at: 7 }] },
    ]);
    expect(merged.map((entry) => `${entry.threadId}:${entry.message.id}`)).toEqual(["a:a1", "b:b1", "a:a2", "b:b2"]);
  });

  it("breaks a tie by conversation id and keeps each conversation's own order", () => {
    const merged = orderFeed([
      { threadId: "b", messages: [{ id: "b1", at: 2 }, { id: "b2", at: 2 }] },
      { threadId: "a", messages: [{ id: "a1", at: 2 }] },
    ]);
    expect(merged.map((entry) => entry.message.id)).toEqual(["a1", "b1", "b2"]);
  });
});
