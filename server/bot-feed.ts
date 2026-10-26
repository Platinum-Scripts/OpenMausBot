import { compareFeed, keyedFeed, type FeedEntry, type KeyedFeedEntry } from "../shared/single-chat-feed.ts";
import type { Message } from "./store.ts";

export interface FeedSource {
  threadId: string;
  /** No message in the conversation is newer: a conversation older than a full page is never read. */
  newestAt: number;
  messages(): readonly Message[];
}

export interface FeedCursor {
  threadId: string;
  messageId: string;
}

/** The `limit` feed entries right before `before` (the newest ones without it), oldest first. null: no conversation
 * holds the cursor. */
export function botFeedPage(sources: readonly FeedSource[], limit: number, before?: FeedCursor | null): { items: FeedEntry<Message>[]; hasMore: boolean } | null {
  const loaded = new Map<string, KeyedFeedEntry<Message>[]>();
  const read = (source: FeedSource) => {
    let entries = loaded.get(source.threadId);
    if (!entries) loaded.set(source.threadId, entries = keyedFeed(source.threadId, source.messages()));
    return entries;
  };
  const cursorSource = before ? sources.find((source) => source.threadId === before.threadId) : undefined;
  const bound = before && cursorSource ? read(cursorSource).find((entry) => entry.message.id === before.messageId) : undefined;
  if (before && !bound) return null;

  const kept: KeyedFeedEntry<Message>[] = [];
  for (const source of [...sources].sort((a, b) => b.newestAt - a.newestAt)) {
    const floor = kept.length > limit ? kept[limit] : undefined;
    if (floor && source.newestAt < floor.message.at) break;
    for (const entry of read(source)) if (!bound || compareFeed(entry, bound) < 0) kept.push(entry);
    kept.sort((a, b) => compareFeed(b, a));
    kept.length = Math.min(kept.length, limit + 1);
  }
  return {
    items: kept.slice(0, limit).reverse().map(({ threadId, message }) => ({ threadId, message })),
    hasMore: kept.length > limit,
  };
}
