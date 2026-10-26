// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), api: fixture.api }));

const { forgetSingleChatFeeds, heldSingleChatFeeds, primeSingleChatFeed, useMarkShownTopicsRead, useSingleChatFeed, useSingleChatFeedTarget } = await import("./use-single-chat-feed");
const { restoreComposerDraft } = await import("@/lib/drafts");
const { ApiError } = await import("@/state/api");

const said = (id: string, at: number): Message => ({ id, at, role: "user", kind: "text", text: id });
const page = (items: Array<[string, Message]>, hasMore = false) => ({ items: items.map(([threadId, message]) => ({ threadId, message })), hasMore });

const base: Bot = {
  id: "bot", threadId: "main", name: "Pepper", title: "", description: "", color: "green", notifications: true, unread: false,
  modelSelection: { instanceId: "test", model: "m" }, messages: [said("m2", 30)],
  tasks: [{ threadId: "main", title: "Main", createdAt: 1, updatedAt: 30 }, { threadId: "topic", title: "Topic", createdAt: 2, updatedAt: 20 }],
};

let seen: ReturnType<typeof useSingleChatFeed> | null = null;
function Harness({ bot, on }: { bot: Bot; on: boolean }) {
  seen = useSingleChatFeed(bot, on, bot.messages);
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const feedCalls = () => fixture.api.mock.calls.map(([path]) => String(path)).filter((path) => path.includes("/feed"));
const ids = () => seen?.rows?.map((row) => row.id);

describe("useSingleChatFeed", () => {
  let root: Root;
  let container: HTMLDivElement;
  const show = async (bot: Bot, on = true) => {
    await act(async () => { root.render(createElement(Harness, { bot, on })); });
  };

  beforeEach(() => {
    fixture.api.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    forgetSingleChatFeeds();
    seen = null;
  });

  it("does nothing while the switch is off", async () => {
    await show(base, false);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(seen?.rows).toBeNull();
  });

  it("loads the newest page and weaves the open conversation in", async () => {
    fixture.api.mockResolvedValue(page([["main", said("m1", 10)], ["topic", said("t1", 20)]], true));
    await show(base);
    expect(feedCalls()).toEqual(["/api/bots/bot/feed?limit=200"]);
    expect(ids()).toEqual(["main:m1", "topic:t1", "main:m2"]);
    expect(seen?.hasMore).toBe(true);
  });

  it("reloads the newest page when another topic changes, not on every message of the open one", async () => {
    fixture.api.mockResolvedValue(page([["topic", said("t1", 20)]]));
    await show(base);
    await show({ ...base, messages: [said("m2", 30), said("m3", 40)], tasks: [{ ...base.tasks![0]!, updatedAt: 40 }, base.tasks![1]!] });
    expect(feedCalls()).toHaveLength(1);
    fixture.api.mockResolvedValue(page([["topic", said("t1", 20)], ["topic", said("t2", 50)]]));
    await show({ ...base, tasks: [base.tasks![0]!, { ...base.tasks![1]!, updatedAt: 50 }] });
    expect(feedCalls()).toHaveLength(2);
    expect(ids()).toEqual(["topic:t1", "main:m2", "topic:t2"]);
  });

  it("pages older history from the oldest entry it holds", async () => {
    fixture.api.mockResolvedValueOnce(page([["topic", said("t1", 20)]], true));
    await show(base);
    fixture.api.mockResolvedValueOnce(page([["main", said("m0", 5)]], false));
    await act(async () => { seen!.loadOlder(); });
    expect(feedCalls()[1]).toBe("/api/bots/bot/feed?limit=200&threadId=topic&before=t1");
    expect(ids()).toEqual(["main:m0", "topic:t1", "main:m2"]);
    expect(seen?.hasMore).toBe(false);
    expect(seen?.pending).toBe(false);
  });

  it("says so when the history fails to load, and loads it on retry", async () => {
    fixture.api.mockRejectedValueOnce(new Error("offline"));
    await show(base);
    expect(seen?.failed).toEqual({ newest: true, older: false });
    expect(ids()).toEqual(["main:m2"]);
    fixture.api.mockResolvedValueOnce(page([["topic", said("t1", 20)]]));
    await act(async () => { seen!.retryNewest(); });
    expect(feedCalls()).toHaveLength(2);
    expect(seen?.failed).toEqual({ newest: false, older: false });
    expect(ids()).toEqual(["topic:t1", "main:m2"]);
  });

  it("retries a failed older page from the same place", async () => {
    fixture.api.mockResolvedValueOnce(page([["topic", said("t1", 20)]], true));
    await show(base);
    fixture.api.mockRejectedValueOnce(new ApiError("busy", 503));
    await act(async () => { seen!.loadOlder(); });
    expect(seen?.failed).toEqual({ newest: false, older: true });
    expect(seen?.pending).toBe(false);
    fixture.api.mockResolvedValueOnce(page([["main", said("m0", 5)]]));
    await act(async () => { seen!.retryOlder(); });
    expect(feedCalls()[2]).toBe("/api/bots/bot/feed?limit=200&threadId=topic&before=t1");
    expect(seen?.failed).toEqual({ newest: false, older: false });
    expect(ids()).toEqual(["main:m0", "topic:t1", "main:m2"]);
  });

  it("starts over from the newest page when the older page's place is gone", async () => {
    fixture.api.mockResolvedValueOnce(page([["topic", said("t1", 20)]], true));
    await show(base);
    fixture.api.mockRejectedValueOnce(new ApiError("no such message", 404));
    fixture.api.mockResolvedValueOnce(page([["topic", said("t9", 25)]], false));
    await act(async () => { seen!.loadOlder(); });
    expect(feedCalls()).toEqual([
      "/api/bots/bot/feed?limit=200",
      "/api/bots/bot/feed?limit=200&threadId=topic&before=t1",
      "/api/bots/bot/feed?limit=200",
    ]);
    expect(seen?.failed).toEqual({ newest: false, older: false });
    expect(ids()).toEqual(["topic:t9", "main:m2"]);
  });

  it("keeps a failed newest page failed when an older page then fails and is retried", async () => {
    fixture.api.mockResolvedValueOnce(page([["topic", said("t1", 20)]], true));
    await show(base);
    fixture.api.mockRejectedValueOnce(new Error("offline"));
    await show({ ...base, tasks: [base.tasks![0]!, { ...base.tasks![1]!, updatedAt: 50 }] });
    fixture.api.mockRejectedValueOnce(new ApiError("busy", 503));
    await act(async () => { seen!.loadOlder(); });
    expect(seen?.failed).toEqual({ newest: true, older: true });
    fixture.api.mockResolvedValueOnce(page([["main", said("m0", 5)]]));
    await act(async () => { seen!.retryOlder(); });
    expect(seen?.failed).toEqual({ newest: true, older: false });
    fixture.api.mockResolvedValueOnce(page([["topic", said("t1", 20)], ["topic", said("t2", 50)]]));
    await act(async () => { seen!.retryNewest(); });
    expect(seen?.failed).toEqual({ newest: false, older: false });
    expect(ids()).toEqual(["main:m0", "topic:t1", "main:m2", "topic:t2"]);
  });

  for (const order of ["older first", "newest first"] as const) {
    it(`keeps each direction's outcome when both are in flight and finish ${order}`, async () => {
      fixture.api.mockResolvedValueOnce(page([["topic", said("t1", 20)]], true));
      await show(base);
      const olderPage = deferred<ReturnType<typeof page>>(), newestPage = deferred<ReturnType<typeof page>>();
      fixture.api.mockReturnValueOnce(olderPage.promise);
      await act(async () => { seen!.loadOlder(); });
      fixture.api.mockReturnValueOnce(newestPage.promise);
      await show({ ...base, tasks: [base.tasks![0]!, { ...base.tasks![1]!, updatedAt: 50 }] });
      const settle = [
        () => olderPage.resolve(page([["main", said("m0", 5)]])),
        () => newestPage.reject(new Error("offline")),
      ];
      for (const step of order === "older first" ? settle : [...settle].reverse()) await act(async () => { step(); });
      expect(seen?.failed).toEqual({ newest: true, older: false });
      expect(seen?.pending).toBe(false);
      expect(ids()).toEqual(["main:m0", "topic:t1", "main:m2"]);
    });
  }

  it("ignores an older page that lands after its bot's feed was dropped from the hold", async () => {
    fixture.api.mockResolvedValueOnce(page([["topic", said("t1", 20)]], true));
    await show(base);
    const olderPage = deferred<ReturnType<typeof page>>();
    fixture.api.mockReturnValueOnce(olderPage.promise);
    await act(async () => { seen!.loadOlder(); });
    for (let i = 0; i < 20; i += 1) primeSingleChatFeed(`other-${i}`, page([["main", said("m", i)]]));
    expect(heldSingleChatFeeds()).not.toContain("bot");
    await act(async () => { olderPage.resolve(page([["main", said("m0", 5)]])); });
    expect(heldSingleChatFeeds()).not.toContain("bot");
  });

  it("ignores an older page asked for before the hold restarted, and can page again", async () => {
    fixture.api.mockResolvedValueOnce(page([["topic", said("t1", 20)]], true));
    await show(base);
    const stale = deferred<ReturnType<typeof page>>();
    fixture.api.mockReturnValueOnce(stale.promise);
    await act(async () => { seen!.loadOlder(); });
    // A newest page sharing nothing with the hold restarts it (it was edited away, or a burst outran a page).
    fixture.api.mockResolvedValueOnce(page([["topic", said("t5", 45)], ["topic", said("t6", 50)]], true));
    await show({ ...base, tasks: [base.tasks![0]!, { ...base.tasks![1]!, updatedAt: 50 }] });
    expect(seen?.pending).toBe(false);
    await act(async () => { stale.resolve(page([["main", said("m0", 5)]])); });
    expect(ids()).toEqual(["topic:t5", "topic:t6"]);
    fixture.api.mockResolvedValueOnce(page([["topic", said("t4", 40)]], false));
    await act(async () => { seen!.loadOlder(); });
    expect(feedCalls().at(-1)).toBe("/api/bots/bot/feed?limit=200&threadId=topic&before=t5");
    expect(ids()).toEqual(["main:m2", "topic:t4", "topic:t5", "topic:t6"]);
  });

  it("knows each shown topic's newest message from the history it holds", async () => {
    fixture.api.mockResolvedValueOnce(page([["topic", said("t1", 20)], ["topic", said("t2", 70)]]));
    await show(base);
    expect(Object.fromEntries(seen!.newestAts)).toEqual({ main: 30, topic: 70 });
  });

  it("holds the feeds of the most recently opened bots only", () => {
    for (let i = 0; i < 30; i += 1) primeSingleChatFeed(`bot-${i}`, page([["main", said("m", i)]]));
    expect(heldSingleChatFeeds()).toHaveLength(20);
    expect(heldSingleChatFeeds().at(-1)).toBe("bot-29");
    expect(heldSingleChatFeeds()).not.toContain("bot-0");
  });
});

describe("useMarkShownTopicsRead", () => {
  let root: Root;
  let container: HTMLDivElement;
  const unreadTopic: Bot = { ...base, tasks: [base.tasks![0]!, { ...base.tasks![1]!, unread: true }, { threadId: "far", title: "Far", createdAt: 3, updatedAt: 1, unread: true }] };
  function Reader({ shown }: { shown: Array<{ threadId: string }> }) {
    useMarkShownTopicsRead(unreadTopic, true, shown);
    return null;
  }
  const readCalls = () => fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/read")).map(([, init]) => JSON.parse(String(init.body)).threadId);

  beforeEach(() => {
    fixture.api.mockReset();
    fixture.api.mockResolvedValue({});
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("marks another topic read only once its lines are drawn", async () => {
    await act(async () => { root.render(createElement(Reader, { shown: [{ threadId: "main" }] })); });
    expect(readCalls()).toEqual([]);
    await act(async () => { root.render(createElement(Reader, { shown: [{ threadId: "topic" }, { threadId: "main" }] })); });
    expect(readCalls()).toEqual(["topic"]);
  });
});

describe("useSingleChatFeedTarget", () => {
  let root: Root;
  let container: HTMLDivElement;
  const dispatch = vi.fn();
  function Target({ bot, busy = false, newestAts }: { bot: Bot; busy?: boolean; newestAts?: ReadonlyMap<string, number> }) {
    useSingleChatFeedTarget(bot, true, busy, dispatch, newestAts);
    return null;
  }
  const show = (bot: Bot, busy = false) => act(() => { root.render(createElement(Target, { bot, busy })); });
  const newerTopic: Bot = { ...base, tasks: [base.tasks![0]!, { ...base.tasks![1]!, updatedAt: 40 }] };

  beforeEach(() => {
    dispatch.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreComposerDraft("bot:bot:main", { text: "", attachments: [] });
  });

  it("sends the composer to the topic with the newest message", () => {
    show(newerTopic);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "bot", threadId: "topic" });
  });

  it("stays put while a turn runs or a draft is half written, then moves", () => {
    show(newerTopic, true);
    restoreComposerDraft("bot:bot:main", { text: "half a thought", attachments: [] });
    show(newerTopic);
    expect(dispatch).not.toHaveBeenCalled();
    restoreComposerDraft("bot:bot:main", { text: "", attachments: [] });
    show({ ...newerTopic, messages: [said("m2", 30), said("sent", 31)] });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "bot", threadId: "topic" });
  });

  it("moves as soon as the draft is cleared, with nothing else changing", async () => {
    restoreComposerDraft("bot:bot:main", { text: "half a thought", attachments: [] });
    await act(async () => { root.render(createElement(Target, { bot: newerTopic })); });
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => { restoreComposerDraft("bot:bot:main", { text: "", attachments: [] }); });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "bot", threadId: "topic" });
  });

  it("goes by the messages it holds when a topic's activity stamp lags them", async () => {
    await act(async () => { root.render(createElement(Target, { bot: base, newestAts: new Map([["main", 30], ["topic", 50]]) })); });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "bot", threadId: "topic" });
  });

  it("leaves a topic the person picked until a newer message lands elsewhere", () => {
    show(base);
    show({ ...base, threadId: "topic" });
    expect(dispatch).not.toHaveBeenCalled();
    show({ ...base, threadId: "topic", tasks: [{ ...base.tasks![0]!, updatedAt: 60 }, base.tasks![1]!] });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "bot", threadId: "main" });
  });
});
