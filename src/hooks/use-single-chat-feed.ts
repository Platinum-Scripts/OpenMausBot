import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch } from "react";

import { orderFeed, type FeedEntry, type WireFeedPage } from "../../shared/single-chat-feed";
import { useHasComposerDraft } from "@/lib/drafts";
import { singleChatFeedEnabled, type FeatureFlagConfig } from "@/lib/feature-flags";
import { feedRows, mergeFeedPage, singleChatFeedTarget, singleChatFeedThreads, type FeedRow, type HeldFeed } from "@/lib/single-chat-feed";
import { api, ApiError, MESSAGE_PAGE_SIZE, type Action, type Bot, type Message } from "@/state/store";

/** `failed`: the newest page or the next older one did not load; the chat offers a retry. */
type Held = HeldFeed & { pending: boolean; failed?: "newest" | "older" };

/** The feeds of the bots opened most recently; a bot opened again after dropping out reloads its newest page. */
const HELD_BOTS = 20;
const feeds = new Map<string, Held>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function hold(botId: string, next: Held): void {
  feeds.delete(botId);
  feeds.set(botId, next);
  for (const stale of feeds.keys()) {
    if (feeds.size <= HELD_BOTS) break;
    feeds.delete(stale);
  }
  notify();
}

function drop(botId: string): void {
  if (feeds.delete(botId)) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only. */
export function primeSingleChatFeed(botId: string, page: WireFeedPage, { failed }: { failed?: Held["failed"] } = {}): void {
  hold(botId, { ...mergeFeedPage(undefined, page, "newest"), pending: false, failed });
}

/** Tests only. */
export function forgetSingleChatFeeds(): void {
  feeds.clear();
  notify();
}

/** Tests only: the bots whose feed is held, least recently loaded first. */
export function heldSingleChatFeeds(): string[] {
  return [...feeds.keys()];
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
  /** Which page did not load: the newest (lines below are missing) or an older one (lines above are). */
  failed: "newest" | "older" | null;
  retry(): void;
  loadOlder(): void;
  /** For the transcript viewport: older history comes from the feed, not the open conversation. */
  older?: { pending: boolean; load: () => void };
}

/** The bot's conversations as one history. The open one stays live from the store; the rest reload whenever another
 * conversation's newest message changes, and older history pages in on demand. */
export function useSingleChatFeed(bot: Bot, on: boolean, live: readonly Message[]): SingleChatFeed {
  const held = useSyncExternalStore(subscribe, () => feeds.get(bot.id), () => feeds.get(bot.id));
  const [reload, setReload] = useState(0);
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
        const failed = before?.failed === "older" ? "older" : undefined;
        hold(bot.id, { ...mergeFeedPage(before, page, "newest"), pending: before?.pending ?? false, failed });
      })
      .catch(() => {
        if (!current) return;
        const before = feeds.get(bot.id);
        hold(bot.id, { entries: before?.entries ?? [], hasMore: before?.hasMore ?? false, pending: before?.pending ?? false, failed: "newest" });
      });
    return () => { current = false; };
  }, [on, bot.id, bot.threadId, elsewhere, reload]);

  const loadOlder = useCallback(() => {
    const state = feeds.get(bot.id);
    const oldest = state && !state.pending && state.hasMore ? oldestHeld(state.entries) : undefined;
    if (!state || !oldest) return;
    hold(bot.id, { ...state, pending: true, failed: state.failed === "older" ? undefined : state.failed });
    api<WireFeedPage>(`${feedPath(bot.id)}&threadId=${encodeURIComponent(oldest.threadId)}&before=${encodeURIComponent(oldest.message.id)}`, { background: true })
      .then((page) => {
        const now = feeds.get(bot.id);
        hold(bot.id, { ...mergeFeedPage(now, page, "older"), pending: false, failed: now?.failed });
      })
      .catch((error: unknown) => {
        // The cursor's message is gone (its branch was edited away, its topic archived): start over from the newest.
        if (error instanceof ApiError && error.status === 404) {
          drop(bot.id);
          setReload((n) => n + 1);
          return;
        }
        const now = feeds.get(bot.id);
        if (now) hold(bot.id, { ...now, pending: false, failed: "older" });
      });
  }, [bot.id]);

  const retry = useCallback(() => {
    const state = feeds.get(bot.id);
    if (state?.failed === "older") loadOlder();
    else setReload((n) => n + 1);
  }, [bot.id, loadOlder]);

  const rows = useMemo(
    () => on ? feedRows({ fetched: held?.entries ?? [], live: { threadId: bot.threadId, all: bot.messages, visible: live }, threadIds, hasMore: held?.hasMore }) : null,
    [on, held, bot.threadId, bot.messages, live, threadIds],
  );
  const shown = rows !== null, pending = shown && Boolean(held?.pending);
  const older = useMemo(() => shown ? { pending, load: loadOlder } : undefined, [shown, pending, loadOlder]);
  return { rows, hasMore: Boolean(rows && held?.hasMore && held.failed !== "older"), pending, failed: shown ? held?.failed ?? null : null, retry, loadOlder, older };
}

/** Points the composer at the conversation with the newest message whenever that changes, once nothing would be
 * lost by moving: no turn running and no draft. A conversation the person picked stays until a newer message lands. */
export function useSingleChatFeedTarget(bot: Bot, on: boolean, busy: boolean, dispatch: Dispatch<Action>): void {
  const target = on ? singleChatFeedTarget(bot) : null;
  const targetTask = target ? bot.tasks?.find((task) => task.threadId === target) : undefined;
  const targetAt = targetTask?.updatedAt ?? targetTask?.createdAt ?? 0;
  const settled = useRef<string | null>(null);
  const lastMessageId = bot.messages.at(-1)?.id;
  const drafting = useHasComposerDraft(`bot:${bot.id}:${bot.threadId}`);
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
    if (bot.switchingTo || bot.awaitingThreadSnapshot || busy || drafting) return;
    settled.current = key;
    dispatch({ type: "switchTask", botId: bot.id, threadId: target });
  }, [target, targetAt, bot.id, bot.threadId, bot.switchingTo, bot.awaitingThreadSnapshot, busy, drafting, lastMessageId, dispatch]);
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
  return { on, rows, viewport, failed: feed.failed, retry: feed.retry };
}

export { useMarkShownTopicsRead, useShownSegments } from "./use-feed-segments";
