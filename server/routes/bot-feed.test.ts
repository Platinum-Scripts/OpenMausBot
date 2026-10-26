import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { pageSize, slimMessage } from "../host/message-pages.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createBotFeedRoutes } from "./bot-feed.ts";
import { dispatchRoutes } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(store: Store, hidden: { bots?: string[]; threads?: string[] } = {}): Promise<string> {
  const routes = [createBotFeedRoutes({
    store, pageSize, slim: slimMessage, defaultPage: 3,
    visibleFor: () => ({ bot: (id) => !hidden.bots?.includes(id), thread: (id) => !hidden.threads?.includes(id) }),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function get(base: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

function fixture() {
  const store = new Store(() => sonnet);
  const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
  const main = bot.threadId;
  const topic = store.createTask(bot.id, "Pricing", false)!.threadId;
  const run = store.createTask(bot.id, "Hourly status run", false)!.threadId;
  const archived = store.createTask(bot.id, "Old", false)!.threadId;
  store.patchTask(bot.id, run, { routineRunId: "run-1" });
  store.patchTask(bot.id, archived, { archivedAt: 1 });
  store.appendMessage(main, { role: "user", kind: "text", text: "hello", at: 1_000 });
  store.appendMessage(topic, { role: "user", kind: "text", text: "price?", at: 2_000 });
  store.appendMessage(run, { role: "bot", kind: "activity", text: "tool chatter", at: 2_500 });
  store.appendMessage(main, { role: "bot", kind: "routine.run", text: "Hourly factory status", at: 3_000 });
  store.appendMessage(archived, { role: "user", kind: "text", text: "put away", at: 3_500 });
  store.appendMessage(topic, { role: "bot", kind: "screen", text: "frame", png: "AAAA", mime: "image/png", at: 4_000 });
  store.appendMessage(main, { role: "user", kind: "text", text: "latest", at: 5_000 });
  return { store, bot, main, topic, run, archived };
}

const lines = (body: any) => body.items.map((item: any) => `${item.threadId === undefined ? "?" : item.threadId}|${item.message.text}`);

describe("GET /api/bots/:id/feed", () => {
  it("merges the bot's conversations by time and leaves out routine runs and archived ones", async () => {
    const { store, bot, main, topic } = fixture();
    const base = await serve(store);
    const { status, body } = await get(base, `/api/bots/${bot.id}/feed?limit=50`);
    expect(status).toBe(200);
    expect(lines(body)).toEqual([
      `${main}|hello`, `${topic}|price?`, `${main}|Hourly factory status`, `${topic}|frame`, `${main}|latest`,
    ]);
    expect(body.hasMore).toBe(false);
    const frame = body.items.find((item: any) => item.message.kind === "screen").message;
    expect(frame.png).toBeUndefined();
    expect(frame.hasImage).toBe(true);
  });

  it("pages older messages from a cursor", async () => {
    const { store, bot, main, topic } = fixture();
    const base = await serve(store);
    const newest = await get(base, `/api/bots/${bot.id}/feed`);
    expect(lines(newest.body)).toEqual([`${main}|Hourly factory status`, `${topic}|frame`, `${main}|latest`]);
    expect(newest.body.hasMore).toBe(true);
    const oldest = newest.body.items[0];
    const older = await get(base, `/api/bots/${bot.id}/feed?threadId=${oldest.threadId}&before=${oldest.message.id}`);
    expect(lines(older.body)).toEqual([`${main}|hello`, `${topic}|price?`]);
    expect(older.body.hasMore).toBe(false);
  });

  it("follows each conversation's active branch only", async () => {
    const { store, bot, main } = fixture();
    const latest = store.activePath(main).at(-1)!;
    expect(store.branchMessage(main, latest.id, "latest, edited")).not.toBeNull();
    const base = await serve(store);
    const texts = (await get(base, `/api/bots/${bot.id}/feed?limit=50`)).body.items.map((item: any) => item.message.text);
    expect(texts.filter((text: string) => text.startsWith("latest"))).toEqual(["latest, edited"]);
  });

  it("refuses an unknown or unseen bot and leaves out conversations the viewer may not see", async () => {
    const { store, bot, topic } = fixture();
    expect((await get(await serve(store), "/api/bots/nobody/feed")).status).toBe(404);
    expect((await get(await serve(store, { bots: [bot.id] }), `/api/bots/${bot.id}/feed`)).status).toBe(404);
    const narrowed = await get(await serve(store, { threads: [topic] }), `/api/bots/${bot.id}/feed?limit=50`);
    expect(narrowed.body.items.some((item: any) => item.threadId === topic)).toBe(false);
    const cursorInHidden = await get(await serve(store, { threads: [topic] }), `/api/bots/${bot.id}/feed?threadId=${topic}&before=x`);
    expect(cursorInHidden.status).toBe(404);
  });

  it("rejects a half cursor, an unknown cursor and a bad limit", async () => {
    const { store, bot, main } = fixture();
    const base = await serve(store);
    expect((await get(base, `/api/bots/${bot.id}/feed?before=x`)).status).toBe(400);
    expect((await get(base, `/api/bots/${bot.id}/feed?threadId=${main}`)).status).toBe(400);
    expect((await get(base, `/api/bots/${bot.id}/feed?threadId=${main}&before=nope`)).status).toBe(404);
    expect((await get(base, `/api/bots/${bot.id}/feed?limit=-1`)).status).toBe(400);
  });
});
