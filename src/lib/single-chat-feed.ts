import { useSyncExternalStore } from "react";

import { orderFeed, type FeedEntry, type WireFeedPage } from "../../shared/single-chat-feed";
import type { Message } from "@/state/store";

export { singleChatFeedTarget, singleChatFeedThreads, type SingleChatFeedTask } from "../../shared/single-chat-feed";

/** One line of the merged history; `id` is unique across the bot's conversations. */
export interface FeedRow {
  id: string;
  role: Message["role"];
  threadId: string;
  message: Message;
}

export interface FeedSegment {
  threadId: string;
  rows: FeedRow[];
}

export interface HeldFeed {
  entries: FeedEntry<Message>[];
  hasMore: boolean;
}

const entryKey = (entry: FeedEntry<Message>) => `${entry.threadId}:${entry.message.id}`;

/** The fetched history with the open conversation's live messages woven in: those replace what was fetched of it,
 * and a fetched message of it the client holds off its active branch is dropped. While older history is unfetched
 * (`hasMore`), nothing older than the oldest fetched line is shown: the other topics' lines from then are not held. */
export function feedRows({ fetched, live, threadIds, hasMore = false }: {
  fetched: readonly FeedEntry<Message>[];
  live: { threadId: string; all: readonly Message[]; visible: readonly Message[] };
  threadIds: ReadonlySet<string>;
  hasMore?: boolean;
}): FeedRow[] {
  const liveIds = new Set(live.all.map((message) => message.id));
  const byThread = new Map<string, Message[]>();
  for (const { threadId, message } of fetched) {
    if (!threadIds.has(threadId) || (threadId === live.threadId && liveIds.has(message.id))) continue;
    byThread.set(threadId, [...byThread.get(threadId) ?? [], message]);
  }
  if (threadIds.has(live.threadId)) byThread.set(live.threadId, [...byThread.get(live.threadId) ?? [], ...live.visible]);
  const rows = orderFeed([...byThread].map(([threadId, messages]) => ({ threadId, messages })))
    .map(({ threadId, message }) => ({ id: `${threadId}:${message.id}`, role: message.role, threadId, message }));
  if (!hasMore) return rows;
  const fetchedKeys = new Set(fetched.filter(({ threadId }) => threadIds.has(threadId)).map(entryKey));
  const start = rows.findIndex((row) => fetchedKeys.has(row.id));
  return start > 0 ? rows.slice(start) : rows;
}

export function feedSegments(rows: readonly FeedRow[]): FeedSegment[] {
  const segments: FeedSegment[] = [];
  for (const row of rows) {
    const last = segments.at(-1);
    if (last?.threadId === row.threadId) last.rows.push(row);
    else segments.push({ threadId: row.threadId, rows: [row] });
  }
  return segments;
}

/** A newest page replaces the hold outright when nothing is held (the first load failed), when it is complete (no
 * `hasMore`: it is the whole history), or when it shares nothing with the hold (that would leave a gap behind it). An
 * older page asked for from the replaced hold no longer fits it. */
export function replacesHold(held: HeldFeed, page: WireFeedPage): boolean {
  if (held.entries.length === 0 || !page.hasMore) return true;
  const keys = new Set(held.entries.map(entryKey));
  return !(page.items as FeedEntry<Message>[]).some((item) => keys.has(entryKey(item)));
}

/** A newest page is the truth from its oldest line on: a held line newer than that which the page lacks was edited
 * away or archived, so it goes. Lines from the same moment as the page's oldest are kept (which came first is not
 * known here). */
export function mergeFeedPage(held: HeldFeed | undefined, page: WireFeedPage, which: "newest" | "older"): HeldFeed {
  const items = page.items as FeedEntry<Message>[];
  if (!held || (which === "newest" && replacesHold(held, page))) return { entries: items, hasMore: page.hasMore };
  const fresh = new Map(items.map((item) => [entryKey(item), item]));
  const kept = held.entries.filter((entry) => !fresh.has(entryKey(entry)));
  if (which === "older") return { entries: [...items, ...kept], hasMore: page.hasMore };
  const from = items[0]?.message.at ?? Number.POSITIVE_INFINITY;
  return { entries: [...kept.filter((entry) => entry.message.at <= from), ...items], hasMore: held.hasMore };
}

let mode = false;
const listeners = new Set<() => void>();

/** Mirrors features.singleChatFeed for code that runs outside React (thread-navigation.ts). */
export function setSingleChatFeedMode(on: boolean): void {
  if (mode === on) return;
  mode = on;
  for (const listener of listeners) listener();
}

export function singleChatFeedMode(): boolean {
  return mode;
}

export function useSingleChatFeedMode(): boolean {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, singleChatFeedMode, () => false);
}
