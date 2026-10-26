import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return { feed: true, advanced: false, dispatch: vi.fn(), menus: new Map<string, { regenerate: boolean; pin: boolean; edit?: boolean }>() };
});
vi.mock("@/components/message-menu", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/message-menu")>();
  return {
    ...original,
    useBotMessageMenu: (input: Parameters<typeof original.useBotMessageMenu>[0]) => {
      fixture.menus.set(input.messageId, { regenerate: Boolean(input.onRegenerate), pin: Boolean(input.pin) });
      return original.useBotMessageMenu(input);
    },
    userMessageMenu: (input: Parameters<typeof original.userMessageMenu>[0]) => {
      fixture.menus.set(input.messageId, { regenerate: false, pin: Boolean(input.pin), edit: Boolean(input.onEdit) });
      return original.userMessageMenu(input);
    },
  };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: { features: { singleChatFeed: fixture.feed } },
      instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true, platform: "other" }, localComputer: { available: false, reasonCode: "cua-driver-unavailable", message: "" } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => null, useReactor: () => "user" }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));

const { ChatView } = await import("./ChatView");
const { forgetSingleChatFeeds, primeSingleChatFeed } = await import("@/hooks/use-single-chat-feed");
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  forgetSingleChatFeeds();
  fixture.feed = true;
  fixture.advanced = false;
});

const said = (id: string, at: number, text: string, role: Message["role"] = "user"): Message => ({ id, at, role, kind: "text", text });
const hello = said("m1", 1_000, "Morning, Pepper");
const status = said("m3", 3_000, "Hourly factory status: all green", "bot");
const pricing = said("t1", 2_000, "What should the price be?");

const bot: Bot = {
  id: "bot", threadId: "main", mainThreadId: "main", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [hello, status],
  modelSelection: { instanceId: "test", model: "m" },
  tasks: [
    { threadId: "main", title: "Main chat", createdAt: 1, updatedAt: 3_000 },
    { threadId: "pricing", title: "Pricing", createdAt: 2, updatedAt: 2_000 },
  ],
};

function render(of: Bot = bot) {
  forgetSingleChatFeeds();
  primeSingleChatFeed(of.id, {
    items: [{ threadId: "main", message: hello }, { threadId: "pricing", message: pricing }, { threadId: "main", message: status }],
    hasMore: false,
  });
  return renderToStaticMarkup(createElement(ChatView, { bot: of }));
}

const position = (markup: string, text: string, from = 0) => {
  const at = markup.indexOf(text, from);
  expect(at, text).toBeGreaterThan(-1);
  return at;
};

describe("ChatView with the single chat feed on", () => {
  it("shows every topic in one history by time, with a label where the topic changes", () => {
    const markup = render();
    let from = 0;
    for (const text of ["Morning, Pepper", 'aria-label="Topic: Pricing"', "What should the price be?",
      'aria-label="Topic: Main chat"', "Hourly factory status: all green"]) from = position(markup, text, from) + 1;
    expect(markup.match(/data-feed-topic=/g)).toHaveLength(2);
  });

  it("puts no topic label above the first line, where the day label already sits", () => {
    const markup = render();
    expect(markup.indexOf("data-feed-topic=")).toBeGreaterThan(markup.indexOf("Morning, Pepper"));
  });

  it("offers no regenerate, pin or edit on another topic's lines, which would act on the open one", () => {
    fixture.menus.clear();
    const answer = said("t2", 2_500, "Price it at ten", "bot");
    primeSingleChatFeed(bot.id, {
      items: [{ threadId: "main", message: hello }, { threadId: "pricing", message: pricing }, { threadId: "pricing", message: answer }, { threadId: "main", message: status }],
      hasMore: false,
    });
    renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(fixture.menus.get("t2")).toEqual({ regenerate: false, pin: false });
    expect(fixture.menus.get("t1")).toEqual({ regenerate: false, pin: false, edit: false });
    expect(fixture.menus.get("m3")).toEqual({ regenerate: true, pin: true });
    expect(fixture.menus.get("m1")).toMatchObject({ pin: true, edit: true });
  });

  it("offers a retry below the history when its newest lines failed to load", () => {
    primeSingleChatFeed(bot.id, { items: [{ threadId: "main", message: status }], hasMore: true }, { failed: { newest: true } });
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup.match(/data-feed-failed/g)).toHaveLength(1);
    expect(position(markup, "data-feed-failed")).toBeGreaterThan(position(markup, "Hourly factory status: all green"));
    expect(markup).toContain("Couldn&#x27;t load the rest of this history.");
    expect(markup).toContain(">Retry<");
  });

  it("offers a retry above the history when older lines failed to load", () => {
    primeSingleChatFeed(bot.id, { items: [{ threadId: "main", message: status }], hasMore: true }, { failed: { older: true } });
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup.match(/data-feed-failed/g)).toHaveLength(1);
    expect(position(markup, "data-feed-failed")).toBeLessThan(position(markup, "Hourly factory status: all green"));
  });

  it("offers both retries when the newest and an older page both failed", () => {
    primeSingleChatFeed(bot.id, { items: [{ threadId: "main", message: status }], hasMore: true }, { failed: { newest: true, older: true } });
    const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
    expect(markup.match(/data-feed-failed=/g)).toHaveLength(2);
  });

  it("hides the topic dropdown, the way back and the background activity picker", () => {
    expect(render()).not.toContain("data-chathead-conversation");
    fixture.advanced = true;
    const advanced = render({ ...bot, threadId: "pricing" });
    expect(advanced).not.toContain("data-chathead-back");
    expect(advanced).not.toContain("data-background-activity");
  });

  it("leaves a single-topic history without labels", () => {
    const only: Bot = { ...bot, tasks: [bot.tasks![0]!] };
    primeSingleChatFeed(only.id, { items: [{ threadId: "main", message: hello }, { threadId: "main", message: status }], hasMore: false });
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: only }));
    expect(markup).not.toContain("data-feed-topic=");
    expect(markup).toContain("Hourly factory status: all green");
  });
});

describe("ChatView with the single chat feed off", () => {
  it("shows only the open topic, with its dropdown, exactly as before", () => {
    fixture.feed = false;
    const markup = render();
    expect(markup).toContain("data-chathead-conversation");
    expect(markup).not.toContain("What should the price be?");
    expect(markup).not.toContain("data-feed-topic=");
    expect(markup).toContain("Hourly factory status: all green");
  });
});
