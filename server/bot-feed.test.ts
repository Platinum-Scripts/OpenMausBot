import { describe, expect, it } from "vitest";

import { botFeedPage, type FeedSource } from "./bot-feed.ts";
import type { Message } from "./store.ts";

const line = (id: string, at: number): Message => ({ id, at, role: "user", kind: "text", text: id });

function sources(threads: Record<string, number[]>, loads: string[] = []): FeedSource[] {
  return Object.entries(threads).map(([threadId, ats]) => ({
    threadId,
    newestAt: Math.max(0, ...ats),
    messages: () => {
      loads.push(threadId);
      return ats.map((at, index) => line(`${threadId}${index}`, at));
    },
  }));
}

const ids = (page: ReturnType<typeof botFeedPage>) => page?.items.map((item) => `${item.threadId}:${item.message.id}`);

describe("botFeedPage", () => {
  it("merges every conversation by time, newest at the end", () => {
    const page = botFeedPage(sources({ main: [1, 4, 6], topic: [2, 3, 7] }), 50);
    expect(ids(page)).toEqual(["main:main0", "topic:topic0", "topic:topic1", "main:main1", "main:main2", "topic:topic2"]);
    expect(page?.hasMore).toBe(false);
  });

  it("pages backwards from a cursor with no gap and no repeat", () => {
    const threads = { main: [1, 4, 6, 9, 12], topic: [2, 3, 7, 10], routine: [5, 8, 11] };
    const whole = ids(botFeedPage(sources(threads), 50))!;
    const seen: string[] = [];
    let page = botFeedPage(sources(threads), 4)!;
    expect(page.hasMore).toBe(true);
    seen.unshift(...ids(page)!);
    while (page.hasMore) {
      const oldest = page.items[0]!;
      page = botFeedPage(sources(threads), 4, { threadId: oldest.threadId, messageId: oldest.message.id })!;
      seen.unshift(...ids(page)!);
    }
    expect(seen).toEqual(whole);
    expect(whole).toHaveLength(12);
  });

  it("orders messages written at the same moment the same way on every page", () => {
    const threads = { b: [5, 5], a: [5, 5] };
    const whole = ids(botFeedPage(sources(threads), 50));
    expect(whole).toEqual(["a:a0", "a:a1", "b:b0", "b:b1"]);
    const newest = botFeedPage(sources(threads), 2)!;
    const older = botFeedPage(sources(threads), 2, { threadId: newest.items[0]!.threadId, messageId: newest.items[0]!.message.id });
    expect([...ids(older)!, ...ids(newest)!]).toEqual(whole);
  });

  it("answers null for a cursor no conversation holds", () => {
    expect(botFeedPage(sources({ main: [1] }), 10, { threadId: "gone", messageId: "main0" })).toBeNull();
    expect(botFeedPage(sources({ main: [1] }), 10, { threadId: "main", messageId: "nope" })).toBeNull();
  });

  it("does not read a conversation whose newest message is older than the page", () => {
    const loads: string[] = [];
    const page = botFeedPage(sources({ fresh: [10, 11, 12], stale: [1, 2] }, loads), 2);
    expect(ids(page)).toEqual(["fresh:fresh1", "fresh:fresh2"]);
    expect(page?.hasMore).toBe(true);
    expect(loads).toEqual(["fresh"]);
  });

  it("answers an empty page for a limit of 0", () => {
    expect(botFeedPage(sources({ main: [1] }), 0)).toEqual({ items: [], hasMore: true });
  });
});
