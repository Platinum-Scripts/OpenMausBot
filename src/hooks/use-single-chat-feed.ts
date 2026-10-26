import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type Dispatch } from "react";

import { orderFeed, type FeedEntry, type WireFeedPage } from "../../shared/single-chat-feed";
import { hasComposerDraft } from "@/lib/drafts";
import { singleChatFeedEnabled, type FeatureFlagConfig } from "@/lib/feature-flags";
import { feedRows, mergeFeedPage, singleChatFeedTarget, singleChatFeedThreads, type FeedRow, type HeldFeed } from "@/lib/single-chat-feed";
import { api, MESSAGE_PAGE_SIZE, type Action, type Bot, type Message } from "@/state/store";

type Held = HeldFeed & { pending: boolean };

const feeds = new Map<string, Held>();
const listeners = new Set<() => void>();

function hold(botId: string, next: Held): void {
  feeds.set(botId, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only. */
export function primeSingleChatFeed(botId: string, page: WireFeedPage): void {
  hold(botId, { ...mergeFeedPage(undefined, page, "newest"), pending: false });
}

/** Tests only. */
export function forgetSingleChatFeeds(): void {
  feeds.clear();
  for (const listener of listeners) listener();
}

function oldestHeld(entries: readonly FeedEntry<Message>[]): FeedEntry<Message> | undefined {
  const byThread = new Map<string, Message[]>();
  for (const { threadId, message } of entries) byThread.set(threadId, [...byThread.get(threadId) ?? [], message]);
  return orderFeed([...byThread].map(([threadId, messages]) => ({ threadId, messages })))[0];
}

const feedPath = (botId: string) => `/api/bots/${encodeURIComponent(botId)}/feed?limit=${MESSAGE_PAGE_SIZE}`;

export interface SingleChatFeed {
  /** null while the switch is off. */
  rows: FeedRow[] | null;
  hasMore: boolean;
  pending: boolean;
  loadOlder(): void;
  /** For the transcript viewport: older history comes from the feed, not the open conversation. */
  older?: { pending: boolean; load: () => void };
}

/** The bot's conversations as one history. The open one stays live from the store; the rest reload whenever another
 * conversation's newest message changes, and older history pages in on demand. */
export function useSingleChatFeed(bot: Bot, on: boolean, live: readonly Message[]): SingleChatFeed {
  const held = useSyncExternalStore(subscribe, () => feeds.get(bot.id), () => feeds.get(bot.id));
  const threads = useMemo(() => singleChatFeedThreads(bot.tasks ?? [], bot.threadId), [bot.tasks, bot.threadId]);
  const threadIds = useMemo(() => new Set([bot.threadId, ...threads.map((task) => task.threadId)]), [threads, bot.threadId]);
  const elsewhere = threads.filter((task) => task.threadId !== bot.threadId)
    .map((task) => `${task.threadId}@${task.updatedAt ?? task.createdAt}`).join(",");

  useEffect(() => {
    if (!on) return;
    let current = true;
    api<WireFeedPage>(feedPath(bot.id), { background: true })
      .then((page) => {
        if (!current) return;
        const before = feeds.get(bot.id);
        hold(bot.id, { ...mergeFeedPage(before, page, "newest"), pending: before?.pending ?? false });
      })
      .catch(() => {});
    return () => { current = false; };
  }, [on, bot.id, bot.threadId, elsewhere]);

  const unreadElsewhere = on && held
    ? threads.filter((task) => task.threadId !== bot.threadId && task.unread).map((task) => task.threadId).join(",")
    : "";
  useEffect(() => {
    if (!unreadElsewhere) return;
    for (const threadId of unreadElsewhere.split(",")) {
      api(`/api/bots/${bot.id}/read`, { method: "POST", body: JSON.stringify({ threadId }) }).catch(() => {});
    }
  }, [bot.id, unreadElsewhere]);

  const loadOlder = useCallback(() => {
    const state = feeds.get(bot.id);
    const oldest = state && !state.pending && state.hasMore ? oldestHeld(state.entries) : undefined;
    if (!state || !oldest) return;
    hold(bot.id, { ...state, pending: true });
    api<WireFeedPage>(`${feedPath(bot.id)}&threadId=${encodeURIComponent(oldest.threadId)}&before=${encodeURIComponent(oldest.message.id)}`, { background: true })
      .then((page) => hold(bot.id, { ...mergeFeedPage(feeds.get(bot.id), page, "older"), pending: false }))
      .catch(() => {
        const now = feeds.get(bot.id);
        if (now) hold(bot.id, { ...now, pending: false });
      });
  }, [bot.id]);

  const rows = useMemo(
    () => on ? feedRows({ fetched: held?.entries ?? [], live: { threadId: bot.threadId, all: bot.messages, visible: live }, threadIds, hasMore: held?.hasMore }) : null,
    [on, held, bot.threadId, bot.messages, live, threadIds],
  );
  const shown = rows !== null, pending = shown && Boolean(held?.pending);
  const older = useMemo(() => shown ? { pending, load: loadOlder } : undefined, [shown, pending, loadOlder]);
  return { rows, hasMore: Boolean(rows && held?.hasMore), pending, loadOlder, older };
}

/** Points the composer at the conversation with the newest message whenever that changes, once nothing would be
 * lost by moving: no turn running and no draft. A conversation the person picked stays until a newer message lands. */
export function useSingleChatFeedTarget(bot: Bot, on: boolean, busy: boolean, dispatch: Dispatch<Action>): void {
  const target = on ? singleChatFeedTarget(bot) : null;
  const targetTask = target ? bot.tasks?.find((task) => task.threadId === target) : undefined;
  const targetAt = targetTask?.updatedAt ?? targetTask?.createdAt ?? 0;
  const settled = useRef<string | null>(null);
  const lastMessageId = bot.messages.at(-1)?.id;
  useEffect(() => {
    if (!target) {
      settled.current = null;
      return;
    }
    const key = `${bot.id}:${target}@${targetAt}`;
    if (settled.current === key) return;
    if (target === bot.threadId) {
      settled.current = key;
      return;
    }
    if (bot.switchingTo || bot.awaitingThreadSnapshot || busy || hasComposerDraft(`bot:${bot.id}:${bot.threadId}`)) return;
    settled.current = key;
    dispatch({ type: "switchTask", botId: bot.id, threadId: target });
  }, [target, targetAt, bot.id, bot.threadId, bot.switchingTo, bot.awaitingThreadSnapshot, busy, lastMessageId, dispatch]);
}

/** ChatView's whole hold on features.singleChatFeed: whether it is on, the merged history, the composer's target, and
 * what the transcript viewport pages through. Off, the viewport reads the open conversation exactly as before. */
export function useChatFeed({ bot, config, live, busy, hasMore, dispatch }: {
  bot: Bot;
  config: FeatureFlagConfig | null | undefined;
  live: readonly Message[];
  busy: boolean;
  hasMore?: boolean;
  dispatch: Dispatch<Action>;
}) {
  const on = singleChatFeedEnabled(config);
  const feed = useSingleChatFeed(bot, on, live);
  useSingleChatFeedTarget(bot, on, busy, dispatch);
  const { rows } = feed;
  const viewport = {
    messages: rows ?? live as ReadonlyArray<Message | FeedRow>,
    hasMore: rows ? feed.hasMore : Boolean(hasMore),
    windowKey: rows ? `${bot.id}:feed` : undefined,
    older: feed.older,
  };
  return { on, rows, viewport };
}

export { useShownSegments } from "./use-feed-segments";
