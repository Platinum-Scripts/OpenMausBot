import type { WireMessage } from "./wire.ts";

export interface SingleChatFeedTask {
  threadId: string;
  createdAt?: number;
  updatedAt?: number;
  historyRevision?: string;
  archivedAt?: number;
  routineRunId?: string;
}

/** One message of `GET /api/bots/:id/feed` and the conversation it was said in. */
export interface FeedEntry<M = WireMessage> {
  threadId: string;
  message: M;
}

/** `GET /api/bots/:id/feed[?limit=&threadId=&before=]`: oldest first; `threadId` + `before` name the oldest entry
 * already held, and the page is what comes right before it. */
export interface WireFeedPage {
  items: FeedEntry[];
  hasMore: boolean;
  /** Opaque: the shown conversations and their history revisions. Appending keeps it; rewriting history changes it. */
  revision?: string;
}

const recency = (task: SingleChatFeedTask): number => task.updatedAt ?? task.createdAt ?? 0;
const detached = (task: SingleChatFeedTask): boolean => task.routineRunId !== undefined;

/** The conversations a single chat feed shows: all but a routine's detached run (its result card is posted where the
 * routine reports) and an archived one, except the open conversation, which is always shown. */
export function singleChatFeedThreads<T extends SingleChatFeedTask>(tasks: readonly T[], selectedThreadId: string): T[] {
  return tasks.filter((task) => !detached(task) && (task.archivedAt === undefined || task.threadId === selectedThreadId));
}

/** Where a single chat feed's composer sends: the conversation with the newest message, else the open one.
 * `newestAts`: each conversation's newest message time where known; a task's activity stamp can lag it (an imported
 * or backdated line), so like the server's feed (routes/bot-feed.ts) the later of the two counts. */
export function singleChatFeedTarget(
  bot: { threadId: string; tasks?: readonly SingleChatFeedTask[] },
  newestAts?: ReadonlyMap<string, number>,
): string {
  const at = (task: SingleChatFeedTask) => Math.max(recency(task), newestAts?.get(task.threadId) ?? 0);
  let target: SingleChatFeedTask | undefined;
  for (const task of bot.tasks ?? []) {
    if (detached(task) || task.archivedAt !== undefined) continue;
    const newer = !target || at(task) > at(target) || (at(task) === at(target) && task.threadId === bot.threadId);
    if (newer) target = task;
  }
  return target?.threadId ?? bot.threadId;
}

export type KeyedFeedEntry<M> = FeedEntry<M> & { index: number };

/** Feed order: by time, then by conversation id, then by place in the conversation. */
export function compareFeed<M extends { at: number }>(a: KeyedFeedEntry<M>, b: KeyedFeedEntry<M>): number {
  return a.message.at - b.message.at || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0) || a.index - b.index;
}

export function keyedFeed<M extends { at: number }>(threadId: string, messages: readonly M[]): KeyedFeedEntry<M>[] {
  return messages.map((message, index) => ({ threadId, message, index }));
}

export function orderFeed<M extends { at: number }>(threads: ReadonlyArray<{ threadId: string; messages: readonly M[] }>): FeedEntry<M>[] {
  return threads.flatMap(({ threadId, messages }) => keyedFeed(threadId, messages))
    .sort(compareFeed)
    .map(({ threadId, message }) => ({ threadId, message }));
}

/** features.singleChatFeed: off unless true. */
export function singleChatFeedEnabled(cfg: { features?: { singleChatFeed?: boolean } } | null | undefined): boolean {
  return cfg?.features?.singleChatFeed === true;
}
