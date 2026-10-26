import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch } from "react";

import { orderFeed, type FeedEntry, type WireFeedPage } from "../../shared/single-chat-feed";
import { useHasComposerDraft } from "@/lib/drafts";
import { singleChatFeedEnabled, type FeatureFlagConfig } from "@/lib/feature-flags";
import { feedRows, mergeFeedPage, replacesHold, singleChatFeedTarget, singleChatFeedThreads, type FeedRow, type HeldFeed } from "@/lib/single-chat-feed";
import { api, ApiError, MESSAGE_PAGE_SIZE, type Action, type Bot, type Message } from "@/state/store";

/** Each direction loads and fails on its own. `olderRequest`: the older page in flight; a reply to any other request
 * (asked before the hold restarted or was dropped) is ignored. */
type Held = HeldFeed & { olderRequest?: number; newestFailed: boolean; olderFailed: boolean };

/** The feeds of the bots opened most recently; a bot opened again after dropping out reloads its newest page. */
const HELD_BOTS = 20;
const feeds = new Map<string, Held>();
let requests = 0;
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
export function primeSingleChatFeed(botId: string, page: WireFeedPage, { failed = {} }: { failed?: { newest?: boolean; older?: boolean } } = {}): void {
  hold(botId, { ...mergeFeedPage(undefined, page, "newest"), newestFailed: Boolean(failed.newest), olderFailed: Boolean(failed.older) });
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
  /** Which pages did not load: the newest (lines below are missing), an older one (lines above are), or both. */
  failed: { newest: boolean; older: boolean };
  retryNewest(): void;
  retryOlder(): void;
  loadOlder(): void;
  /** Each shown topic's newest message time in what is held: the topic with the newest message overall is always in
   * the newest page, so the composer's target can go by messages rather than by activity stamps that may lag. */
  newestAts: ReadonlyMap<string, number>;
  /** For the transcript viewport: older history comes from the feed, not the open conversation. */
  older?: { pending: boolean; load: () => void };
}

const NOT_FAILED = { newest: false, older: false } as const;

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
        const merged = mergeFeedPage(before, page, "newest");
        // A replaced hold has a new oldest line (or none to page from), so an older page asked for before no longer fits.
        const keep = before && !replacesHold(before, page) ? before : undefined;
        hold(bot.id, { ...merged, olderRequest: keep?.olderRequest, olderFailed: keep?.olderFailed ?? false, newestFailed: false });
      })
      .catch(() => {
        if (!current) return;
        const before = feeds.get(bot.id);
        hold(bot.id, { entries: [], hasMore: false, olderFailed: false, ...before, newestFailed: true });
      });
    return () => { current = false; };
  }, [on, bot.id, bot.threadId, elsewhere, reload]);

  const loadOlder = useCallback(() => {
    const state = feeds.get(bot.id);
    const oldest = state && state.olderRequest === undefined && state.hasMore ? oldestHeld(state.entries) : undefined;
    if (!state || !oldest) return;
    const request = ++requests;
    hold(bot.id, { ...state, olderRequest: request, olderFailed: false });
    const mine = () => {
      const now = feeds.get(bot.id);
      return now?.olderRequest === request ? now : undefined;
    };
    api<WireFeedPage>(`${feedPath(bot.id)}&threadId=${encodeURIComponent(oldest.threadId)}&before=${encodeURIComponent(oldest.message.id)}`, { background: true })
      .then((page) => {
        const now = mine();
        if (now) hold(bot.id, { ...now, ...mergeFeedPage(now, page, "older"), olderRequest: undefined });
      })
      .catch((error: unknown) => {
        const now = mine();
        if (!now) return;
        // The cursor's message is gone (its branch was edited away, its topic archived): start over from the newest.
        if (error instanceof ApiError && error.status === 404) {
          drop(bot.id);
          setReload((n) => n + 1);
          return;
        }
        hold(bot.id, { ...now, olderRequest: undefined, olderFailed: true });
      });
  }, [bot.id]);

  const retryNewest = useCallback(() => setReload((n) => n + 1), []);

  const rows = useMemo(
    () => on ? feedRows({ fetched: held?.entries ?? [], live: { threadId: bot.threadId, all: bot.messages, visible: live }, threadIds, hasMore: held?.hasMore }) : null,
    [on, held, bot.threadId, bot.messages, live, threadIds],
  );
  const newestAts = useMemo(() => {
    const at = new Map<string, number>();
    for (const { threadId, message } of held?.entries ?? []) at.set(threadId, Math.max(at.get(threadId) ?? message.at, message.at));
    const open = bot.messages.at(-1)?.at;
    if (open !== undefined) at.set(bot.threadId, Math.max(at.get(bot.threadId) ?? open, open));
    return at;
  }, [held, bot.messages, bot.threadId]);
  const shown = rows !== null, pending = shown && held?.olderRequest !== undefined;
  const older = useMemo(() => shown ? { pending, load: loadOlder } : undefined, [shown, pending, loadOlder]);
  const failed = useMemo(
    () => shown && held ? { newest: held.newestFailed, older: held.olderFailed } : NOT_FAILED,
    [shown, held],
  );
  return {
    rows, hasMore: Boolean(rows && held?.hasMore && !held.olderFailed), pending, failed,
    retryNewest, retryOlder: loadOlder, loadOlder, newestAts, older,
  };
}

/** Points the composer at the conversation with the newest message whenever that changes, once nothing would be
 * lost by moving: no turn running and no draft. A conversation the person picked stays until a newer message lands. */
export function useSingleChatFeedTarget(
  bot: Bot, on: boolean, busy: boolean, dispatch: Dispatch<Action>, newestAts?: ReadonlyMap<string, number>,
): void {
  const target = on ? singleChatFeedTarget(bot, newestAts) : null;
  const targetTask = target ? bot.tasks?.find((task) => task.threadId === target) : undefined;
  const targetAt = Math.max(targetTask?.updatedAt ?? targetTask?.createdAt ?? 0, (target && newestAts?.get(target)) || 0);
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
  useSingleChatFeedTarget(bot, on, busy, dispatch, feed.newestAts);
  const { rows } = feed;
  const viewport = {
    messages: rows ?? live as ReadonlyArray<Message | FeedRow>,
    hasMore: rows ? feed.hasMore : Boolean(hasMore),
    windowKey: rows ? `${bot.id}:feed` : undefined,
    older: feed.older,
  };
  return { on, rows, viewport, failed: feed.failed, retryNewest: feed.retryNewest, retryOlder: feed.retryOlder };
}

export { useMarkShownTopicsRead, useShownSegments } from "./use-feed-segments";
