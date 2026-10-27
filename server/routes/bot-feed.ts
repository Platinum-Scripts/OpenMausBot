import { createHash } from "node:crypto";

import { singleChatFeedThreads, type SingleChatFeedTask } from "../../shared/single-chat-feed.ts";
import { botFeedPage } from "../bot-feed.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Message, Store } from "../store.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

export interface BotFeedRouteDeps {
  store: Pick<Store, "bot" | "activePath" | "historyRevision">;
  defaultPage: number;
  /** undefined = absent, null = unusable (host/message-pages.ts). */
  pageSize(raw: string | null): number | null | undefined;
  slim(message: Message): Message | Record<string, unknown>;
  visibleFor(auth: RequestAuth): Pick<VisibleSet, "bot" | "thread">;
  /** Each conversation's newest message time, from the messages themselves (message-db.ts latestMessageAts). */
  latestAts(threadIds: readonly string[]): ReadonlyMap<string, number>;
}

/** One continuous history per bot (features.singleChatFeed): every conversation's active branch, merged by time. */
export function createBotFeedRoutes(deps: BotFeedRouteDeps): RouteHandler {
  return async ({ res, url, path, method, auth, json }: RouteContext) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/feed$/);
    if (!m || method !== "GET") return PASS;
    const visible = deps.visibleFor(auth);
    const bot = deps.store.bot(m[1]!);
    if (!bot || !visible.bot(bot.id)) return json(res, 404, { error: "no such bot" });
    const limit = deps.pageSize(url.searchParams.get("limit"));
    if (limit === null) return json(res, 400, { error: "limit must be a non-negative whole number" });
    const threadId = url.searchParams.get("threadId");
    const before = url.searchParams.get("before");
    if (Boolean(threadId) !== Boolean(before)) return json(res, 400, { error: "threadId and before go together" });

    const tasks: SingleChatFeedTask[] = bot.tasks?.length ? bot.tasks : [{ threadId: bot.threadId, createdAt: bot.createdAt }];
    const shown = singleChatFeedThreads(tasks, bot.threadId).filter((task) => visible.thread(task.threadId));
    // botFeedPage skips a conversation whose newest message is older than a full page: that time must be the real
    // one, since a task's activity stamp can lag (an imported or backdated line).
    const latest = deps.latestAts(shown.map((task) => task.threadId));
    const sources = shown
      .map((task) => ({
        threadId: task.threadId,
        newestAt: Math.max(latest.get(task.threadId) ?? Number.NEGATIVE_INFINITY, task.updatedAt ?? 0, task.createdAt ?? 0),
        messages: () => deps.store.activePath(task.threadId),
      }));
    const page = botFeedPage(sources, limit ?? deps.defaultPage, threadId && before ? { threadId, messageId: before } : null);
    if (!page) return json(res, 404, { error: "no such message" });
    return json(res, 200, {
      items: page.items.map(({ threadId: id, message }) => ({ threadId: id, message: deps.slim(message) })),
      hasMore: page.hasMore,
      // Which conversations are shown and each one's history revision: a held older page from another set no longer fits.
      revision: createHash("sha256").update(JSON.stringify(shown.map((task) => [task.threadId, deps.store.historyRevision(task.threadId)]).sort())).digest("hex"),
    });
  };
}
