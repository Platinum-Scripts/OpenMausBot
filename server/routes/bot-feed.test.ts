import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { pageSize, slimMessage } from "../host/message-pages.ts";
import { latestMessageAts } from "../message-db.ts";
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
    store, pageSize, slim: slimMessage, defaultPage: 3, latestAts: latestMessageAts,
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

  it("keeps a conversation whose recorded activity time lags its newest message", async () => {
    const { store, bot, main, topic } = fixture();
    for (const task of store.bot(bot.id)!.tasks!) task.updatedAt = task.createdAt = task.threadId === topic ? 1 : 9_000;
    const base = await serve(store);
    const newest = await get(base, `/api/bots/${bot.id}/feed?limit=2`);
    expect(lines(newest.body)).toEqual([`${topic}|frame`, `${main}|latest`]);
  });

  it("follows each conversation's active branch only", async () => {
    const { store, bot, main } = fixture();
    const latest = store.activePath(main).at(-1)!;
    expect(store.branchMessage(main, latest.id, "latest, edited")).not.toBeNull();
    const base = await serve(store);
    const texts = (await get(base, `/api/bots/${bot.id}/feed?limit=50`)).body.items.map((item: any) => item.message.text);
    expect(texts.filter((text: string) => text.startsWith("latest"))).toEqual(["latest, edited"]);
  });

  it("versions older branch changes even when activity and the newest page do not change", async () => {
    const { store, bot, main, topic } = fixture();
    const source = store.activePath(topic)[0]!;
    const branch = store.branchMessage(topic, source.id, "alternative")!;
    store.patchMessage(topic, branch.id, { at: 2_000 });
    store.setActiveLeaf(topic, source.id);
    const base = await serve(store);
    const path = `/api/bots/${bot.id}/feed?limit=1`;
    const before = (await get(base, path)).body;
    const stamp = store.bot(bot.id)!.tasks!.find(task => task.threadId === topic)!.updatedAt;
    store.setActiveLeaf(topic, branch.id);
    const after = (await get(base, path)).body;
    expect(after.items).toEqual(before.items);
    expect(after.revision).toEqual(expect.any(String));
    expect(after.revision).not.toBe(before.revision);
    expect(store.bot(bot.id)!.tasks!.find(task => task.threadId === topic)!.updatedAt).toBe(stamp);
    // Held over a restart, history read before it could miss a change made while away: a new epoch refetches it.
    expect((await get(await serve(new Store(() => sonnet)), path)).body.revision).not.toBe(after.revision);
    store.appendMessage(main, { role: "user", kind: "text", text: "append", at: 6_000 });
    expect((await get(base, path)).body.revision).toBe(after.revision);
    store.setActiveLeaf(topic, branch.id);
    expect((await get(base, path)).body.revision).toBe(after.revision);
  });

  it.each(["move", "reparent", "insert", "import", "backdate", "fork append"])("versions %s changes outside the newest page", async (change) => {
    const { store, bot, topic } = fixture();
    const first = store.activePath(topic)[0]!;
    const base = await serve(store);
    const path = `/api/bots/${bot.id}/feed?limit=1`;
    const before = (await get(base, path)).body.revision;
    if (change === "move") store.patchMessage(topic, first.id, { at: 1 });
    if (change === "reparent") store.patchMessage(topic, store.activePath(topic)[1]!.id, { parentId: null });
    if (change === "insert") store.insertMessageAfter(topic, first.id, { role: "user", kind: "text", text: "inserted" });
    if (change === "import") store.importTranscript(topic, [{ id: "imported", at: 1, role: "user", kind: "text", text: "imported", parentId: null }], "imported", []);
    if (change === "backdate") store.appendMessage(topic, { role: "user", kind: "text", text: "backdated", at: 1 });
    if (change === "fork append") store.appendMessage(topic, { role: "user", kind: "text", text: "forked", parentId: null });
    expect((await get(base, path)).body.revision).not.toBe(before);
  });

  it("keeps the revision for a line changed in place, which clients patch from the broadcast", async () => {
    const { store, bot, topic } = fixture();
    const base = await serve(store);
    const path = `/api/bots/${bot.id}/feed?limit=1`;
    const before = (await get(base, path)).body.revision;
    const patched: string[] = [];
    store.onChange((change) => { if (change.type === "message.patch") patched.push(change.message.text ?? ""); });
    const first = store.activePath(topic)[0]!;
    for (const patch of [{ text: "revised" }, { reactions: [{ emoji: "+1", by: "me" }] }, { turnTerminal: true, turnCompletedAt: 9 }]) store.patchMessage(topic, first.id, patch as never);
    await Promise.resolve();
    expect((await get(base, path)).body.revision).toBe(before);
    expect(patched).toEqual(["revised", "revised", "revised"]);
  });

  it("tells clients once per tick, after the restructure is stored", async () => {
    const { store, bot, topic } = fixture();
    const changes: string[] = [];
    store.onChange((change) => { if (change.type === "bot") changes.push(store.historyRevision(topic)); });
    const [first, second] = store.activePath(topic);
    const before = store.historyRevision(topic);
    store.patchMessage(topic, first!.id, { at: 1 });
    store.patchMessage(topic, second!.id, { at: 2 });
    expect(changes).toEqual([]);
    await Promise.resolve();
    expect(changes).toEqual([store.historyRevision(topic)]);
    expect(changes[0]).not.toBe(before);
    expect(store.bot(bot.id)).toBeDefined();
  });

  it("does not include invisible thread revisions in the feed token", async () => {
    const { store, bot, topic } = fixture();
    const base = await serve(store, { threads: [topic] });
    const path = `/api/bots/${bot.id}/feed?limit=1`;
    const before = (await get(base, path)).body.revision;
    store.branchMessage(topic, store.activePath(topic)[0]!.id, "hidden change");
    expect((await get(base, path)).body.revision).toBe(before);
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
