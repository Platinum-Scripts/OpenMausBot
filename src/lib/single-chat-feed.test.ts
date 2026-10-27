import { afterEach, describe, expect, it } from "vitest";

import { botOpensTo } from "@/state/thread-navigation";
import type { Message } from "@/state/store";
import { feedRows, feedSegments, mergeFeedPage, setSingleChatFeedMode } from "./single-chat-feed";

const said = (id: string, at: number, role: Message["role"] = "user"): Message => ({ id, at, role, kind: "text", text: id });
const entry = (threadId: string, message: Message) => ({ threadId, message });
const keys = (rows: ReturnType<typeof feedRows>) => rows.map((row) => row.id);

afterEach(() => setSingleChatFeedMode(false));

describe("feedRows", () => {
  it("weaves the open conversation's live messages into the fetched history by time", () => {
    const rows = feedRows({
      fetched: [entry("main", said("m1", 10)), entry("topic", said("t1", 20)), entry("main", said("m2", 30))],
      live: { threadId: "main", all: [said("m1", 10), said("m2", 30), said("m3", 40)], visible: [said("m1", 10), said("m2", 30), said("m3", 40)] },
      threadIds: new Set(["main", "topic"]),
    });
    expect(keys(rows)).toEqual(["main:m1", "topic:t1", "main:m2", "main:m3"]);
  });

  it("drops a fetched message of the open conversation that is off its active branch", () => {
    const rows = feedRows({
      fetched: [entry("main", said("old-branch", 10)), entry("main", said("kept-older", 5))],
      live: { threadId: "main", all: [said("old-branch", 10), said("edited", 11)], visible: [said("edited", 11)] },
      threadIds: new Set(["main"]),
    });
    expect(keys(rows)).toEqual(["main:kept-older", "main:edited"]);
  });

  it("starts at the oldest fetched line while older history is unfetched, so no other topic seems missing", () => {
    const live = [said("m0", 5), said("m1", 10), said("m2", 30)];
    const partial = { fetched: [entry("topic", said("t1", 20)), entry("main", said("m2", 30))], live: { threadId: "main", all: live, visible: live }, threadIds: new Set(["main", "topic"]) };
    expect(keys(feedRows({ ...partial, hasMore: true }))).toEqual(["topic:t1", "main:m2"]);
    expect(keys(feedRows({ ...partial, hasMore: false }))).toEqual(["main:m0", "main:m1", "topic:t1", "main:m2"]);
    expect(keys(feedRows({ ...partial, fetched: [], hasMore: true }))).toEqual(["main:m0", "main:m1", "main:m2"]);
  });

  it("renders a large retained topic without mutating its messages", () => {
    const fetched = Array.from({ length: 20_000 }, (_, i) => entry("topic", said(String(i), i)));
    const durations: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const rows = feedRows({ fetched, live: { threadId: "main", all: [], visible: [] }, threadIds: new Set(["topic", "main"]) });
      durations.push(performance.now() - start);
      expect(rows).toHaveLength(20_000);
      expect(rows[0]?.id).toBe("topic:0");
      expect(rows.at(-1)?.id).toBe("topic:19999");
    }
    expect(fetched).toHaveLength(20_000);
    console.log(`client feedRows 20k retained messages median ${durations.sort((a, b) => a - b)[1]!.toFixed(2)} ms`);
  });

  it("leaves out a conversation that is no longer in the feed", () => {
    const rows = feedRows({
      fetched: [entry("gone", said("g1", 1)), entry("main", said("m1", 2))],
      live: { threadId: "main", all: [], visible: [] },
      threadIds: new Set(["main"]),
    });
    expect(keys(rows)).toEqual(["main:m1"]);
  });
});

describe("feedSegments", () => {
  it("starts a segment wherever the conversation changes", () => {
    const rows = feedRows({
      fetched: [entry("a", said("a1", 1)), entry("a", said("a2", 2)), entry("b", said("b1", 3)), entry("a", said("a3", 4))],
      live: { threadId: "a", all: [], visible: [] },
      threadIds: new Set(["a", "b"]),
    });
    expect(feedSegments(rows).map((segment) => [segment.threadId, segment.rows.map((row) => row.message.id)])).toEqual([
      ["a", ["a1", "a2"]], ["b", ["b1"]], ["a", ["a3"]],
    ]);
  });
});

describe("mergeFeedPage", () => {
  const held = [entry("a", said("a1", 1)), entry("a", said("a2", 2))];

  it("adds a newer page to what is held, the page's copy winning", () => {
    const merged = mergeFeedPage({ entries: held, hasMore: true }, { items: [entry("a", { ...said("a2", 2), text: "patched" }), entry("b", said("b1", 3))], hasMore: true }, "newest");
    expect(merged.entries.map((e) => e.message.text)).toEqual(["a1", "patched", "b1"]);
    expect(merged.hasMore).toBe(true);
  });

  it("keeps how far back the history reaches when a newest page overlaps it", () => {
    expect(mergeFeedPage({ entries: held, hasMore: false }, { items: [entry("a", said("a2", 2))], hasMore: true }, "newest").hasMore).toBe(false);
  });

  it("starts over when a newest page leaves a gap after what is held", () => {
    const merged = mergeFeedPage({ entries: held, hasMore: false }, { items: [entry("b", said("b9", 90))], hasMore: true }, "newest");
    expect(merged.entries.map((e) => e.message.id)).toEqual(["b9"]);
    expect(merged.hasMore).toBe(true);
  });

  it("drops a held line in the newest page's span that the page no longer has (edited away)", () => {
    const merged = mergeFeedPage({ entries: [...held, entry("b", said("b1", 3))], hasMore: true }, { items: [entry("a", said("a2", 2)), entry("b", said("b2", 4))], hasMore: true }, "newest");
    expect(merged.entries.map((e) => e.message.id)).toEqual(["a1", "a2", "b2"]);
  });

  it("refetches an ambiguous boundary timestamp instead of retaining deleted tied messages", () => {
    const old = [entry("a", said("earlier-tie", 10)), entry("b", said("keep", 10)), entry("c", said("deleted", 10)), entry("c", said("latest", 20))];
    const newest = [entry("b", said("keep", 10)), entry("c", said("new", 11)), entry("c", said("latest", 20))];
    const merged = mergeFeedPage({ entries: old, hasMore: false }, { items: newest, hasMore: true }, "newest");
    expect(merged).toEqual({ entries: newest, hasMore: true });
    const older = mergeFeedPage(merged, { items: [entry("a", said("earlier-tie", 10))], hasMore: false }, "older");
    expect(older.entries.map(e => e.message.id)).toEqual(["earlier-tie", "keep", "new", "latest"]);
  });

  it("takes a complete newest page as the whole history", () => {
    const merged = mergeFeedPage({ entries: [...held, entry("b", said("b1", 3))], hasMore: false }, { items: [entry("a", said("a2", 2)), entry("b", said("b2", 4))], hasMore: false }, "newest");
    expect(merged.entries.map((e) => e.message.id)).toEqual(["a2", "b2"]);
    expect(merged.hasMore).toBe(false);
  });

  it("takes the first page after a failed load as a fresh start, with its hasMore", () => {
    const merged = mergeFeedPage({ entries: [], hasMore: false }, { items: [entry("b", said("b9", 90))], hasMore: true }, "newest");
    expect(merged).toEqual({ entries: [entry("b", said("b9", 90))], hasMore: true });
  });

  it("takes an older page's hasMore", () => {
    const merged = mergeFeedPage({ entries: held, hasMore: true }, { items: [entry("b", said("b0", 0))], hasMore: false }, "older");
    expect(merged.entries.map((e) => e.message.id)).toEqual(["b0", "a1", "a2"]);
    expect(merged.hasMore).toBe(false);
  });
});

describe("opening a bot with the single chat feed on", () => {
  const bot = { threadId: "main", mainThreadId: "main", tasks: [
    { threadId: "main", createdAt: 1, updatedAt: 10 },
    { threadId: "topic", createdAt: 2, updatedAt: 20 },
  ] };

  it("opens its newest conversation, which is where the composer sends", () => {
    expect(botOpensTo(bot, false)).toBe("main");
    setSingleChatFeedMode(true);
    expect(botOpensTo(bot, false)).toBe("topic");
    expect(botOpensTo(bot, true)).toBe("topic");
  });
});
