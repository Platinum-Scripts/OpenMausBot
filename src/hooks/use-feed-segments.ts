import { useMemo } from "react";

import { t } from "@/lib/i18n";
import { feedSegments, type FeedRow } from "@/lib/single-chat-feed";
import { localizedTaskTitle } from "@/lib/task-title";
import { transcriptLookups, type TranscriptLookups } from "@/lib/transcript-derivations";
import type { Bot, Message } from "@/state/store";

/** One run of the shown history from a single conversation. */
export interface ShownSegment<R> {
  key: string;
  threadId: string;
  live: boolean;
  /** The run's lines and its conversation's transcript; `previousAt` is when the line just above the run was said. */
  list: { messages: Message[]; transcript: Message[]; lookups: TranscriptLookups; previousAt?: number };
  /** The topic's name, drawn above the run, when the feed holds more than one topic. */
  title?: string;
  /** Another conversation's rows: read-only, busy when that conversation is. The open one uses the chat's own. */
  rows?: R & { readOnly: true; busy: boolean };
}

/** What the chat draws. With the single chat feed off (`feed` null) that is the open conversation's window as one run;
 * with it on, the window split wherever the conversation changes. */
export function useShownSegments<R extends object>({ feed, windowed, threadId, tasks, rows, transcript, lookups }: {
  feed: readonly FeedRow[] | null;
  windowed: ReadonlyArray<Message | FeedRow>;
  threadId: string;
  tasks: Bot["tasks"];
  rows: R;
  /** The open conversation's own transcript and lookups. */
  transcript: Message[];
  lookups: TranscriptLookups;
}): ShownSegment<R>[] {
  const elsewhere = useMemo(() => {
    const byThread = new Map<string, Message[]>();
    for (const row of feed ?? []) {
      if (row.threadId === threadId) continue;
      const list = byThread.get(row.threadId);
      if (list) list.push(row.message);
      else byThread.set(row.threadId, [row.message]);
    }
    return new Map([...byThread].map(([id, list]) => [id, { transcript: list, lookups: transcriptLookups(list, list) }]));
  }, [feed, threadId]);
  const contexts = useMemo(() => new Map([...elsewhere.keys()].map((id) => [id, {
    ...rows, threadId: id, readOnly: true as const, busy: Boolean(tasks?.find((task) => task.threadId === id)?.busy),
  }])), [elsewhere, rows, tasks]);
  const topics = useMemo(() => new Set(feed?.map((row) => row.threadId)).size, [feed]);

  return useMemo(() => {
    if (!feed) return [{ key: threadId, threadId, live: true, list: { messages: windowed as Message[], transcript, lookups } }];
    const title = (id: string) => localizedTaskTitle(tasks?.find((task) => task.threadId === id)?.title || t("task.newShort"));
    let previousAt: number | undefined;
    return feedSegments(windowed as FeedRow[]).map((segment) => {
      const live = segment.threadId === threadId;
      const messages = segment.rows.map((row) => row.message);
      const other = live ? undefined : elsewhere.get(segment.threadId)!;
      const shown: ShownSegment<R> = {
        key: segment.rows[0]!.id, threadId: segment.threadId, live,
        list: { messages, transcript: other?.transcript ?? transcript, lookups: other?.lookups ?? lookups, previousAt },
        title: topics > 1 ? title(segment.threadId) : undefined,
        rows: live ? undefined : contexts.get(segment.threadId),
      };
      previousAt = messages.at(-1)?.at;
      return shown;
    });
  }, [feed, windowed, threadId, tasks, topics, elsewhere, contexts, transcript, lookups]);
}
