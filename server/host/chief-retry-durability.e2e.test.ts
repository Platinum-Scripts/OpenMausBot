import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { AUTO_RETRY_LEAD } from "../incidents.ts";
import { launchRestartableServer } from "../testing/restartable-server.ts";
import type { ChiefRetryState } from "./chief-retry-journal.ts";

async function fixture(delayMinutes = 0, max = 1) {
  const server = await launchRestartableServer({ scripted: true,
    imports: [fileURLToPath(new URL("../testing/chief-retry-clock-hooks.mjs", import.meta.url))] });
  const plans: Record<string, unknown> = {};
  const actions: unknown[] = [];
  const seenBots: any[] = [];
  const plan = (bot: string, value: unknown) => {
    plans[bot] = value;
    writeFileSync(server.planPath, JSON.stringify(plans));
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${server.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) }).catch(cause => { throw new Error(`${method} ${path} failed; see ${server.logPath}`, { cause }); });
    if (method !== "GET") actions.push({ method, path, body, status: response.status });
    expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
    return await response.json() as any;
  };
  const config = (change: Record<string, unknown>) => {
    const file = join(server.dataDir, "config.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...change }));
  };
  const clock = (offset: number) => writeFileSync(join(server.dataDir, "chief-clock"), String(offset));
  await server.stop();
  config({ retryOnFailure: { max, delayMinutes }, threads: { maxConcurrentPerBot: 1 } });
  if (process.env.PCC83_BASELINE === "1") {
    writeFileSync(join(server.dataDir, "chief-baseline.ts"), execFileSync("git", ["show", "b299693a6:server/host/chief-notices.ts"], { encoding: "utf8" }));
  }
  await server.start();
  const chief = (await api("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.chiefOfStaff);
  expect(chief).toBeTruthy();
  plan(chief.id, { reply: "Incident received. No further action." });
  const bot = async (name: string) => {
    const created = (await api("POST", "/api/bots", { name })).bot;
    seenBots.push(created);
    return created;
  };
  const messages = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=200`)).messages as any[];
  const send = (bot: any, text: string) => api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
  const retries = async (bot: any) => (await messages(bot.threadId)).filter(line => line.role === "user" && line.peerAsk
    && (line.text?.startsWith(AUTO_RETRY_LEAD) || line.text?.startsWith("[Auto-retry from OpenMausBot")));
  const reports = async () => {
    const bots = (await api("GET", "/api/bots?messages=0")).bots;
    const task = bots.find((b: any) => b.id === chief.id).tasks.find((t: any) => t.title === "Team incidents");
    return task ? (await messages(task.threadId)).filter(line => line.role === "user" && line.peerAsk?.incident) : [];
  };
  const journalFile = join(server.dataDir, "chief-retries", "journal.sqlite");
  const states = (): ChiefRetryState[] => {
    if (!existsSync(journalFile)) return [];
    const db = new DatabaseSync(journalFile, { readOnly: true });
    try { return db.prepare("SELECT state FROM retries").all().map(row => JSON.parse(String(row.state))); }
    finally { db.close(); }
  };
  const state = (bot: any) => states().find(s => s.threadId === bot.threadId);
  const latencies: number[] = [];
  const health = async () => {
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      await api("GET", "/api/health");
      latencies.push(performance.now() - start);
    }
  };
  const close = async () => {
    const sorted = [...latencies].sort((a, b) => a - b);
    const evidence = { baseline: process.env.PCC83_BASELINE === "1", url: server.url, logPath: server.logPath,
      healthMs: { samples: sorted.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)] },
      states: states(), reports: await reports().catch(() => []), latencies, actions,
      transcripts: await Promise.all(seenBots.map(async bot => ({ botId: bot.id, threadId: bot.threadId,
        messages: await messages(bot.threadId).catch(() => []) }))) };
    writeFileSync(`${server.logPath}.chief-retries.json`, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ evidence: `${server.logPath}.chief-retries.json`, healthMs: evidence.healthMs }));
    await server.close();
  };
  return { ...server, api, plan, config, clock, chief, bot, messages, send, retries, reports, state, health, close, journalFile };
}

it("bounds retries beyond the notice hour and opens a fresh budget only for a new person's request", async () => {
  const f = await fixture();
  try {
    const fox = await f.bot("Retry budget fixture");
    const ready = join(f.dataDir, "retry-ready");
    const gate = join(f.dataDir, "retry-release");
    f.plan(fox.id, { script: [
      { key: "request", match: ["First request"], failWith: "Synthetic task failure" },
      { key: "retry", match: ["OpenMausBot"], repeat: true, readyFile: ready, gateFile: gate, failWith: "Synthetic retry failure" },
      { key: "new-request", match: ["New request"], failWith: "Synthetic new failure" },
    ] });
    await f.send(fox, "First request");
    await expect.poll(() => existsSync(ready), { timeout: 20_000 }).toBe(true);
    await f.health();
    f.clock(2 * 60 * 60_000);
    writeFileSync(gate, "release");
    await expect.poll(async () => (await f.reports()).length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(await f.retries(fox)).toHaveLength(1);
    expect((await f.reports())[0].text).toContain("already resumed that thread by itself once");
    expect(f.state(fox)).toMatchObject({ attempts: 1, started: 1 });
    await f.send(fox, "New request");
    await expect.poll(async () => (await f.reports()).length, { timeout: 20_000 }).toBe(2);
    expect(await f.retries(fox)).toHaveLength(2);
    expect(f.state(fox)).toMatchObject({ attempts: 1, started: 1 });
    await f.health();
  } finally { await f.close(); }
}, 120_000);

it("honors a two-retry thread budget before reporting the final stop", async () => {
  const f = await fixture(0, 2);
  try {
    const fox = await f.bot("Two-retry budget fixture");
    f.plan(fox.id, { script: [
      { key: "request", match: ["Finish this request"], failWith: "Synthetic task failure" },
      { key: "retry", match: ["OpenMausBot"], repeat: true, failWith: "Synthetic retry failure" },
    ] });
    await f.send(fox, "Finish this request");
    await expect.poll(async () => (await f.retries(fox)).length, { timeout: 20_000 }).toBe(2);
    const retries = await f.retries(fox);
    expect(retries[0].text).toContain("retry 1 of 2");
    expect(retries[1].text).toContain("retry 2 of 2");
    await expect.poll(async () => (await f.reports()).length, { timeout: 20_000 }).toBe(1);
    expect((await f.reports())[0].text).toContain("already resumed that thread by itself 2 times");
    expect(f.state(fox)).toMatchObject({ attempts: 2, started: 2 });
    expect(f.state(fox)?.pending).toBeUndefined();
    await f.health();
  } finally { await f.close(); }
}, 120_000);

it("recovers a delayed retry and a notice waiting on Chief capacity once, across real server restarts", async () => {
  const f = await fixture(1);
  try {
    const fox = await f.bot("Restart retry fixture");
    f.plan(fox.id, { failWith: "Synthetic recoverable failure" });
    await f.send(fox, "Finish this request");
    await expect.poll(() => f.state(fox)?.pending?.phase, { timeout: 20_000 }).toBe("retry");
    expect(await f.retries(fox)).toHaveLength(0);
    await f.stop();
    f.clock(120_000);
    const chiefReady = join(f.dataDir, "chief-ready");
    const chiefGate = join(f.dataDir, "chief-release");
    f.plan(f.chief.id, { readyFile: chiefReady, gateFile: chiefGate, reply: "Received." });
    const retryReady = join(f.dataDir, "retry-ready");
    const retryGate = join(f.dataDir, "retry-release");
    f.plan(fox.id, { readyFile: retryReady, gateFile: retryGate, failWith: "Synthetic retry failure" });
    await f.start();
    await expect.poll(() => existsSync(retryReady), { timeout: 20_000 }).toBe(true);
    expect(await f.retries(fox)).toHaveLength(1);
    await f.send(f.chief, "Hold Chief capacity");
    await expect.poll(() => existsSync(chiefReady), { timeout: 20_000 }).toBe(true);
    writeFileSync(retryGate, "release");
    await expect.poll(() => f.state(fox)?.pending?.phase, { timeout: 20_000 }).toBe("report");
    expect(await f.reports()).toHaveLength(0);
    await f.stop();
    f.clock(180_000);
    writeFileSync(chiefGate, "release");
    await f.start();
    await expect.poll(async () => (await f.reports()).length, { timeout: 20_000 }).toBe(1);
    expect((await f.reports())[0].text).toContain("already resumed that thread by itself once");
    await f.stop();
    await f.start();
    expect(await f.retries(fox)).toHaveLength(1);
    expect(await f.reports()).toHaveLength(1);
    expect(f.state(fox)?.pending).toBeUndefined();
    await f.health();
  } finally { await f.close(); }
}, 120_000);

it("rechecks opt-in, routing and user progress; ambiguous claims and invalid storage never replay", async () => {
  const f = await fixture(1);
  try {
    const uncertain = await f.bot("Claimed retry fixture");
    const disabled = await f.bot("Policy retry fixture");
    const moved = await f.bot("Rerouted retry fixture");
    const progressed = await f.bot("New request fixture");
    for (const bot of [uncertain, disabled, moved, progressed]) {
      f.plan(bot.id, { failWith: "Synthetic pending failure" });
      await f.send(bot, "Original request");
      await expect.poll(() => f.state(bot)?.pending?.phase, { timeout: 20_000 }).toBe("retry");
    }
    f.plan(progressed.id, { reply: "New request completed." });
    await f.send(progressed, "A different request");
    await expect.poll(async () => (await f.messages(progressed.threadId)).some(line => line.turnSucceeded === true), { timeout: 20_000 }).toBe(true);
    await f.api("PATCH", `/api/bots/${moved.id}`, { section: "No Chief here" });
    await f.stop();
    f.config({ retryOnFailure: { max: 1, delayMinutes: 0, threads: false } });
    const db = new DatabaseSync(f.journalFile);
    const claimed = f.state(uncertain)!;
    claimed.pending!.phase = "dispatching";
    claimed.attempts = 1;
    db.prepare("UPDATE retries SET state = ? WHERE thread = ?").run(JSON.stringify(claimed), uncertain.threadId);
    db.close();
    f.clock(120_000);
    await f.start();
    await expect.poll(async () => (await f.reports()).length, { timeout: 20_000 }).toBe(2);
    for (const bot of [uncertain, disabled, moved, progressed]) expect(await f.retries(bot)).toHaveLength(0);
    const report = (await f.reports()).find(line => line.peerAsk.incident.threadId === uncertain.threadId);
    expect(report.text).toContain("execution is uncertain");
    expect(report.text).toContain("1 automatic retry attempt was reserved without a confirmed start");
    expect(report.text).not.toContain("already resumed");
    await f.stop();
    f.config({ retryOnFailure: { max: 1, delayMinutes: 0 } });
    const broken = new DatabaseSync(f.journalFile);
    broken.prepare("UPDATE retries SET state = ? WHERE thread = ?").run('{"pending":{"phase":"retry"}}', disabled.threadId);
    broken.close();
    await f.start();
    await f.send(disabled, "New request with unavailable accounting");
    await expect.poll(async () => (await f.messages(disabled.threadId)).filter(line => line.turnSucceeded === false).length, { timeout: 20_000 }).toBeGreaterThan(1);
    expect(await f.retries(disabled)).toHaveLength(0);
    expect(await f.reports()).toHaveLength(2);
    await f.health();
  } finally { await f.close(); }
}, 180_000);
