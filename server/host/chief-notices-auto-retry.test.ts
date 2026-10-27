import { describe, expect, it, vi } from "vitest";

import { createChiefNotices, type ChiefNoticeDeps } from "./chief-notices.ts";

function fixture(extra: Partial<ChiefNoticeDeps> = {}) {
  const bots = [
    { id: "chief", name: "Chief", chiefOfStaff: true, threadId: "chief-main", tasks: [] as Array<{ threadId: string; title: string }> },
    { id: "fox", name: "Fox", threadId: "fox-main", tasks: [{ threadId: "fox-sweep", title: "Inbox sweep" }] },
  ];
  const path: Array<{ role: string; at: number }> = [];
  let made = 0;
  const store = {
    bots, bot: (id: string) => bots.find((one) => one.id === id),
    tasks: (id: string) => bots.find((one) => one.id === id)?.tasks ?? [],
    taskByThread: (id: string, threadId: string) => bots.find((one) => one.id === id)?.tasks.find((task) => task.threadId === threadId),
    groupByThread: () => undefined,
    createTask: (id: string, title: string) => {
      const task = { threadId: `notices-${++made}`, title };
      bots.find((one) => one.id === id)!.tasks.push(task);
      return task;
    },
    appendMessage: () => {},
    messagesFor: () => [],
    activePath: () => path,
  };
  const timers: Array<{ run: () => void; delayMs: number }> = [];
  const startTurn = vi.fn(async (_botId: string, _text: string, _opts: { threadId: string }) => undefined);
  const notices = createChiefNotices({
    store: store as never, notify: () => {}, threadBusy: () => false, botAtThreadCapacity: () => false,
    groupTurnActive: () => false, startTurn, assignerOf: () => undefined, escalationsEnabled: () => true,
    retryPolicy: () => ({ max: 1, delayMinutes: 2 }),
    schedule: (run, delayMs) => { timers.push({ run, delayMs }); },
    ...extra,
  });
  const fire = () => { for (const timer of timers.splice(0)) timer.run(); };
  const fail = () => notices.reportIncident({ kind: "failed", bot: bots[1] as never, threadId: "fox-sweep", detail: "Stopped after reaching the 10-minute run limit" });
  const calls = () => startTurn.mock.calls.map(([botId, text, opts]) => ({ botId, threadId: opts.threadId, text }));
  return { notices, startTurn, timers, fire, fail, calls, path };
}

describe("OpenMausBot's own retry of a teammate's stopped thread", () => {
  it("resumes the thread after its delay without the Chief, then reports the next stop to the Chief", async () => {
    const f = fixture();
    f.fail();
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(f.timers.map((timer) => timer.delayMs)).toEqual([120_000]);
    f.fire();
    expect(f.calls()).toEqual([{ botId: "fox", threadId: "fox-sweep", text: expect.stringMatching(/^\[Auto-retry from OpenMausBot for Chief, your Chief of Staff, .*automatic retry 1 of 1/) }]);
    expect(f.startTurn.mock.calls[0]![2]).toMatchObject({ unattended: true, peerAsk: { botId: "chief", unattended: true } });

    // The resumed run stops too: the retry is used up, so the Chief hears, and is told what was already tried.
    f.fail();
    expect(f.timers).toEqual([]);
    expect(f.calls().map((call) => call.botId)).toEqual(["fox", "chief"]);
    expect(f.calls()[1]!.text).toContain("OpenMausBot already resumed that thread by itself once, and it stopped again.");
  });

  it("leaves the thread alone when it is busy, queued or finished meanwhile", () => {
    for (const extra of [{ threadBusy: () => true }, { threadQueued: () => true }] satisfies Partial<ChiefNoticeDeps>[]) {
      const f = fixture(extra);
      f.fail();
      expect(f.notices.retryRefusal("fox", "fox-sweep")).toMatch(/still running|waiting for a free slot/);
      f.fire();
      expect(f.calls().filter((call) => call.botId === "fox")).toEqual([]);
    }
    const done = fixture();
    done.fail();
    done.path.push({ role: "bot", at: Date.now() + 1, turnSucceeded: true } as never);
    done.fire();
    expect(done.startTurn).not.toHaveBeenCalled();
  });

  it("uses the same settling refusal for automatic and Chief-requested retries", () => {
    const f = fixture({ threadBusy: () => true, threadSettling: () => true });
    f.fail();
    expect(f.notices.retryRefusal("fox", "fox-sweep")).toContain("still shutting down");
    f.fire();
    expect(f.startTurn).not.toHaveBeenCalled();
  });

  it("does not retry a private thread through another person's Chief", () => {
    const f = fixture({ privateThread: () => true });
    f.fail();
    expect(f.timers).toEqual([]);
    expect(f.startTurn).not.toHaveBeenCalled();
  });

  it("leaves the thread alone when the person wrote there after it stopped", () => {
    const f = fixture();
    f.fail();
    f.path.push({ role: "user", at: Date.now() + 1 });
    f.fire();
    expect(f.startTurn).not.toHaveBeenCalled();
  });

  it("tells the Chief when its own retry cannot start", async () => {
    const f = fixture();
    f.startTurn.mockRejectedValueOnce(new Error("the bot is at its thread limit"));
    f.fail();
    f.fire();
    await vi.waitFor(() => expect(f.calls().map((call) => call.botId)).toEqual(["fox", "chief"]));
    expect(f.calls()[1]!.text).toContain("OpenMausBot's automatic retry could not start: the bot is at its thread limit.");
  });

  it("is off when the host does not turn it on, as before: the Chief hears at once", () => {
    const f = fixture({ retryPolicy: () => undefined });
    f.fail();
    expect(f.timers).toEqual([]);
    expect(f.calls().map((call) => call.botId)).toEqual(["chief"]);
  });
});
