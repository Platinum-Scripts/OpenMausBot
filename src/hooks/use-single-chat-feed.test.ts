// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({ ...await importOriginal<typeof import("@/state/store")>(), api: fixture.api }));

const { forgetSingleChatFeeds, useSingleChatFeed, useSingleChatFeedTarget } = await import("./use-single-chat-feed");
const { restoreComposerDraft } = await import("@/lib/drafts");

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

  it("marks another topic read once its messages are on screen", async () => {
    fixture.api.mockResolvedValue(page([["topic", said("t1", 20)]]));
    await show({ ...base, tasks: [base.tasks![0]!, { ...base.tasks![1]!, unread: true }] });
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/bot/read", { method: "POST", body: JSON.stringify({ threadId: "topic" }) });
  });
});

describe("useSingleChatFeedTarget", () => {
  let root: Root;
  let container: HTMLDivElement;
  const dispatch = vi.fn();
  function Target({ bot, busy = false }: { bot: Bot; busy?: boolean }) {
    useSingleChatFeedTarget(bot, true, busy, dispatch);
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

  it("leaves a topic the person picked until a newer message lands elsewhere", () => {
    show(base);
    show({ ...base, threadId: "topic" });
    expect(dispatch).not.toHaveBeenCalled();
    show({ ...base, threadId: "topic", tasks: [{ ...base.tasks![0]!, updatedAt: 60 }, base.tasks![1]!] });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "bot", threadId: "main" });
  });
});
