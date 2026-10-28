import { afterEach, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
import type { RoutineRun } from "./routines.ts";

let fixture: VerificationServer | undefined;
afterEach(async () => { await fixture?.close(); });

it("resumes and reruns only after shutdown, exhausts the budget, and honors revoked or absent policy", async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" });
  const { url } = fixture.info;
  const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBeLessThan(300);
    return value as T;
  };
  const schedule = { type: "cron", expression: "0 7 * * *", timeZone: "Europe/London" };
  const create = async (name: string, retryOnFailure?: object) => {
    const { bot } = await runControlOmb(["new-bot", "--name", name, "--url", url]) as { bot: { id: string } };
    return (await api<{ routine: { id: string } }>("POST", "/api/routines", { name, prompt: "Sweep the inbox.", botId: bot.id, timeoutMinutes: 5,
      schedule, ...(retryOnFailure ? { retryOnFailure } : {}) })).routine.id as string;
  };
  const resume = await create("Resume sweep", { max: 1, delayMinutes: 0, onTimeout: "resume" });
  const rerun = await create("Rerun sweep", { max: 1, delayMinutes: 0, onTimeout: "rerun" });
  const revoked = await create("Revoked sweep", { max: 1, delayMinutes: 1, onTimeout: "rerun" });
  const legacy = await create("Legacy sweep");
  const run = async (routineId: string): Promise<RoutineRun> =>
    (await api<{ runs: RoutineRun[] }>("GET", "/api/routines")).runs.find((candidate) => candidate.routineId === routineId)!;
  const initial = new Map<string, string>();
  for (const id of [resume, rerun, revoked, legacy]) {
    await api("POST", `/api/routines/${id}/run`);
    await expect.poll(() => run(id), { timeout: 30_000 }).toMatchObject({ status: "running" });
    initial.set(id, (await run(id)).threadId!);
  }
  await expect.poll(() => run(revoked), { timeout: 6.5 * 60_000, interval: 1_000 })
    .toMatchObject({ status: "queued", retried: "timeout", timeoutPending: true });
  await api("PATCH", `/api/routines/${revoked}`, { retryOnFailure: { max: 0 } });
  await expect.poll(() => run(revoked), { timeout: 90_000, interval: 1_000 })
    .toMatchObject({ status: "cancelled", threadId: initial.get(revoked), retries: 1 });
  const resumed = await run(resume), reran = await run(rerun), old = await run(legacy);
  expect(resumed).toMatchObject({ status: "running", threadId: initial.get(resume), retried: "timeout", retries: 1 });
  expect(reran).toMatchObject({ status: "running", retried: "timeout", retries: 1 });
  expect(reran.threadId).not.toBe(initial.get(rerun));
  expect(resumed.timeoutPending).toBeUndefined();
  expect(reran.timeoutPending).toBeUndefined();
  expect(old).toMatchObject({ status: "failed", error: "Stopped after reaching the 5-minute run limit" });
  expect(old.retried).toBeUndefined();
  console.log("first limit: same-thread resume, new-thread rerun, revoked retry cancelled, absent policy failed");
  for (const id of [resume, rerun]) {
    await expect.poll(() => run(id), { timeout: 6.5 * 60_000, interval: 5_000 })
      .toMatchObject({ status: "failed", retries: 1, error: "Stopped after reaching the 5-minute run limit (after 1 automatic retry)" });
  }
  const { runs } = await api("GET", "/api/routines") as { runs: RoutineRun[] };
  for (const id of [resume, rerun, revoked, legacy]) expect(runs.filter((candidate) => candidate.routineId === id)).toHaveLength(1);
  console.log("second limit: both retry budgets exhausted; one run record per routine");
}, 16 * 60_000);
