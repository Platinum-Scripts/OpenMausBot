import { compareFeed, type FeedEntry, type KeyedFeedEntry } from "../shared/single-chat-feed.ts";
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
 * holds the cursor. Holds at most `limit + 1` candidates however long the conversations are: each one is walked newest
 * first, and as conversations are almost always in time order, a line that cannot make the page costs one compare. */
export function botFeedPage(sources: readonly FeedSource[], limit: number, before?: FeedCursor | null): { items: FeedEntry<Message>[]; hasMore: boolean } | null {
  const read = new Map<string, readonly Message[]>();
  const messagesOf = (source: FeedSource) => {
    let messages = read.get(source.threadId);
    if (!messages) read.set(source.threadId, messages = source.messages());
    return messages;
  };
  let bound: KeyedFeedEntry<Message> | undefined;
  if (before) {
    const cursorSource = sources.find((source) => source.threadId === before.threadId);
    const messages = cursorSource ? messagesOf(cursorSource) : [];
    const index = messages.findIndex((message) => message.id === before.messageId);
    if (index < 0) return null;
    bound = { threadId: before.threadId, message: messages[index]!, index };
  }

  const room = limit + 1;
  /** Newest first: the page plus one more, which proves there is more. */
  const kept: KeyedFeedEntry<Message>[] = [];
  for (const source of [...sources].sort((a, b) => b.newestAt - a.newestAt)) {
    if (kept.length === room && source.newestAt < kept[room - 1]!.message.at) break;
    const messages = messagesOf(source);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = { threadId: source.threadId, message: messages[index]!, index };
      if (bound && compareFeed(entry, bound) >= 0) continue;
      if (kept.length === room && compareFeed(entry, kept[room - 1]!) <= 0) continue;
      let low = 0, high = kept.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (compareFeed(kept[middle]!, entry) > 0) low = middle + 1;
        else high = middle;
      }
      kept.splice(low, 0, entry);
      if (kept.length > room) kept.pop();
    }
  }
  return {
    items: kept.slice(0, limit).reverse().map(({ threadId, message }) => ({ threadId, message })),
    hasMore: kept.length > limit,
  };
}
