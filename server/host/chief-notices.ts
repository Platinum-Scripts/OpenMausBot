import { createHash, randomUUID } from "node:crypto";
import { ChiefRetryJournal, type ChiefRetryState } from "./chief-retry-journal.ts";
import { failedTurnTool } from "../../shared/failed-turn.ts";
import { admit } from "../admission.ts";
import { ESCALATIONS_THREAD_TITLE, EscalationLedger, escalationChip, escalationDeliverable, escalationText, type Escalation, type EscalationKind } from "../escalations.ts";
import {
  AUTO_RETRY_LEAD, chiefForBot, INCIDENTS_THREAD_TITLE, IncidentLedger, incidentChip, incidentContext, incidentText, RETRY_BLOCKED, RETRY_LEAD,
  type Incident, type IncidentKind,
} from "../incidents.ts";
import { buildNotification, type Notification } from "../notify.ts";
import { quoteInNote } from "../peer-provenance.ts";
import { peerName } from "../peer-roster.ts";
import { redactSecretsInText } from "../redact.ts";
import { retriesTeammateThread, type RoutineFailureFacts } from "../routine-recovery.ts";
import { resolveRetryPolicy } from "../routine-retry-policy.ts";
import { queueSteeredMessage } from "../steer-queue.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import type { RoutineRetryPolicy } from "../../shared/routines.ts";

type PeerAsk = NonNullable<Message["peerAsk"]>;

export type EscalationOutcome = "chief" | "person" | "muted" | "off" | "skipped" | "failed";

export interface ChiefNoticeDeps {
  store: Pick<Store, "bots" | "bot" | "tasks" | "taskByThread" | "groupByThread" | "createTask" | "appendMessage" | "messagesFor" | "activePath">;
  assignerOf(threadId: string): unknown;
  notify(notification: Notification | null): void;
  threadBusy(botId: string, threadId: string): boolean;
  botAtThreadCapacity(botId: string): boolean;
  groupTurnActive(botId: string): boolean;
  startTurn(botId: string, text: string, opts: { threadId: string; unattended?: boolean; peerAsk: PeerAsk; sendId?: string }): Promise<unknown>;
  escalationsEnabled(): boolean;
  /** A failed teammate thread gets one immediate retry by default. config.json "retryOnFailure" can change the budget
   * and delay, or set "threads" to false to leave every retry to the Chief. */
  retryPolicy?(): (Partial<RoutineRetryPolicy> & { threads?: boolean }) | undefined;
  /** The thread's last run has ended but is still shutting down. */
  threadSettling?(threadId: string): boolean;
  /** The thread waits for a free slot and starts on its own. */
  threadQueued?(botId: string, threadId: string): boolean;
  /** Timers for the automatic retry; the host's by default. */
  schedule?(run: () => void, delayMs: number): void;
  retryJournal?: ChiefRetryJournal;
  /** Security invariant: a read-and-draft run's prompt and reply carry mail and invite text, so its failures and
   * questions never reach a Chief as a notice. */
  quietThread?(botId: string, threadId: string): boolean;
  /** A person's private chat on a Team Cloud: its notices go to that person, never into a Chief's thread the team reads. */
  privateThread?(threadId: string): boolean;
  /** A Team Cloud: a notice reaches a Chief only when the conversation's asks are its person's (a member's private chat
   * is theirs alone), into a notices chat of that person's own. */
  routing?: {
    askedPerson(botId: string, threadId: string): string | null;
    personOf(chief: BotRecord): string | null;
    startedBy(threadId: string): string | undefined;
    open(threadId: string, person: string): void;
  };
}

export function createChiefNotices(deps: ChiefNoticeDeps) {
  const { store } = deps;
  const incidentLedger = new IncidentLedger();
  const escalationLedger = new EscalationLedger();
  const journal = deps.retryJournal ?? new ChiefRetryJournal();
  let storageFailed = false;
  function guarded(run: () => void): void {
    if (storageFailed) return;
    try { run(); } catch {
      storageFailed = true;
      console.warn("Chief automatic recovery paused: durable state unavailable");
    }
  }
  const schedule = deps.schedule ?? ((run: () => void, delayMs: number) => { setTimeout(run, delayMs).unref?.(); });

  /** Why a teammate's stopped thread cannot be retried now, in words a Chief can act on, or null. */
  function retryRefusal(botId: string, threadId: string): string | null {
    const blocked = deps.threadSettling?.(threadId) ? "settling" : deps.threadBusy(botId, threadId) ? "running"
      : deps.threadQueued?.(botId, threadId) ? "queued" : null;
    if (blocked) return RETRY_BLOCKED[blocked];
    // A thread that finished a run since it was last reported has nothing to resume: resuming would redo finished work.
    const reportedAt = incidentLedger.lastAt(threadId);
    if (reportedAt !== undefined && store.activePath(threadId).some((line) => line.turnSucceeded === true && line.at > reportedAt)) {
      return "that thread has finished a run since it was reported — there is nothing to retry; read what it did before deciding anything else";
    }
    return null;
  }

  /** The one way a teammate's stopped thread runs again: a Chief's retry_thread and OpenMausBot's automatic retry both
   * start it here, after the same refusal checks. Throws the refusal, or why the start failed. */
  async function retryThread(input: { chief: BotRecord; bot: BotRecord; threadId: string; unattended: boolean; note?: string; automatic?: true; sendId?: string }): Promise<void> {
    const refused = retryRefusal(input.bot.id, input.threadId);
    if (refused) throw new Error(refused);
    const chief = peerName(input.chief.name);
    const lead = input.automatic
      ? `${AUTO_RETRY_LEAD}, once, before telling ${chief}, your Chief of Staff, that this thread's last run failed.`
      : `${RETRY_LEAD}${chief}, your Chief of Staff, after this thread's last run stopped.${input.note ? ` Note from ${chief}: ${quoteInNote(input.note, 300)}` : ""}`;
    await deps.startTurn(input.bot.id, `${lead} Continue the request above from where it stopped and finish it. If the same problem comes back, say exactly what is blocking and stop.]`,
      { threadId: input.threadId, unattended: input.unattended, sendId: input.sendId,
        peerAsk: { botId: input.chief.id, name: input.chief.name, ...(input.unattended ? { unattended: true } : {}) } });
  }

  function incidentRefused(chief: BotRecord, incidentsThreadId: string, asks: ReadonlyArray<Message["peerAsk"]>, why: string): void {
    const refused = `the incident could not reach ${chief.name} — ${why}`;
    store.appendMessage(incidentsThreadId, { role: "bot", kind: "activity", tool: failedTurnTool(refused) });
    const lines = store.messagesFor(incidentsThreadId);
    for (const ask of asks) {
      if (!ask?.incident || ask.incident.notified) continue;
      const bot = store.bot(ask.botId);
      if (!bot) continue;
      const { threadId } = ask.incident;
      const chip = lines.findLast(line => line.kind === "activity" && line.tool?.ok === false && line.threadRef?.threadId === threadId)?.tool?.name;
      const group = store.groupByThread(threadId);
      deps.notify(buildNotification("incident", bot, threadId, chip ?? refused, {
        avatarUrl: bot.avatarUrl,
        ...(group ? { group: { id: group.id, name: group.name } } : {}),
      }));
    }
  }

  /** Upstream's one immediate retry is the default; an explicit policy can delay, change the budget or opt out. */
  function autoRetry(): { max: number; delayMs: number } | null {
    const configured = deps.retryPolicy?.();
    if (configured === undefined) return { max: 1, delayMs: 0 };
    if (configured.threads === false) return null;
    const { max, delayMinutes } = resolveRetryPolicy(configured);
    return max > 0 ? { max, delayMs: delayMinutes * 60_000 } : null;
  }

  /** A notice about this thread may go to `chief`: the asks there are the Chief's person's, never another's private chat. */
  function reachesChief(chief: BotRecord, bot: BotRecord, threadId: string): boolean {
    const routing = deps.routing;
    return routing ? routing.askedPerson(bot.id, threadId) === routing.personOf(chief) : deps.privateThread?.(threadId) !== true;
  }

  function audience(bot: BotRecord, threadId: string, chief: BotRecord | null): string {
    return createHash("sha256").update(JSON.stringify([Boolean(deps.routing), deps.privateThread?.(threadId) === true,
      deps.routing?.askedPerson(bot.id, threadId) ?? null, chief ? deps.routing?.personOf(chief) ?? null : null])).digest("hex");
  }

  function arm(state: ChiefRetryState): void {
    const pending = state.pending;
    if (!pending) return;
    schedule(() => guarded(() => processPending(state.threadId, pending.id)), Math.min(2_147_483_647, Math.max(0, pending.dueAt - Date.now())));
  }

  function clearPending(state: ChiefRetryState): void {
    delete state.pending;
    journal.save(state);
  }

  function processPending(threadId: string, id: string): void {
    const state = journal.get(threadId);
    const p = state?.pending;
    if (!state || !p || p.id !== id) return;
    // A crash between the durable claim and the external side effect is ambiguous, not permission to replay it.
    if (p.phase === "delivering") return;
    if (p.phase === "dispatching") {
      state.uncertain = true;
      p.phase = "report";
      p.refused = "An automatic retry was claimed before a restart; its execution is uncertain. Do not repeat it automatically";
      p.count.mayRetry = false;
      const receipt = store.activePath(threadId).find(line => line.sendId === p.id);
      if (receipt) p.tailId = receipt.id;
      if (!journal.save(state)) return;
    }
    if (p.dueAt > Date.now()) { arm(state); return; }
    const bot = store.bot(state.botId);
    const task = bot && store.taskByThread(bot.id, threadId);
    const group = store.groupByThread(threadId);
    if (!bot || (!task && !group) || task?.archivedAt || deps.quietThread?.(bot.id, threadId) || deps.assignerOf(threadId)) { clearPending(state); return; }
    const candidate = chiefForBot(store.bots, bot);
    const chief = candidate && reachesChief(candidate, bot, threadId) ? candidate : null;
    if ((chief?.id ?? null) !== p.chiefId || audience(bot, threadId, chief) !== p.audience) { clearPending(state); return; }
    const path = store.activePath(threadId);
    const requestStart = state.boundaryId === null ? 0 : path.findIndex(line => line.id === state.boundaryId);
    if (requestStart < 0 || path.slice(requestStart).some(line => line.requestCancelled === true)) { clearPending(state); return; }
    const tail = p.tailId === null ? -1 : path.findIndex(line => line.id === p.tailId);
    if ((p.tailId !== null && tail === -1) || path[tail]?.turnSucceeded === true || path.slice(tail + 1).some(line => line.role === "user" || line.turnSucceeded === true)) {
      clearPending(state); return;
    }
    if (p.phase === "retry" && store.groupByThread(threadId)) { clearPending(state); return; }
    const policy = autoRetry();
    if (p.phase === "retry" && (!policy || state.uncertain || state.attempts >= policy.max)) {
      p.phase = "report";
      if (!journal.save(state)) return;
    }
    if (p.phase === "retry" && policy && p.failedAt + policy.delayMs > Date.now()) {
      p.dueAt = p.failedAt + policy.delayMs;
      if (journal.save(state)) arm(state);
      return;
    }
    if (deps.threadBusy(bot.id, threadId) || deps.threadSettling?.(threadId) || deps.threadQueued?.(bot.id, threadId)
      || deps.botAtThreadCapacity(bot.id) || deps.groupTurnActive(bot.id)) {
      p.dueAt = Date.now() + 5_000;
      if (journal.save(state)) arm(state);
      return;
    }
    if (p.phase === "retry" && chief && policy) {
      state.attempts += 1;
      p.phase = "dispatching";
      if (!journal.save(state)) return;
      void retryThread({ chief, bot, threadId, unattended: true, automatic: true, sendId: p.id }).then(() => guarded(() => {
          const current = journal.get(threadId);
          if (current?.pending?.id !== p.id || current.pending.phase !== "dispatching") return;
          current.started += 1;
          clearPending(current);
        }), () => guarded(() => {
          const current = journal.get(threadId);
          if (current?.pending?.id !== p.id || current.pending.phase !== "dispatching") return;
          current.uncertain = true;
          current.pending.phase = "report";
          current.pending.count.mayRetry = false;
          current.pending.refused = "OpenMausBot's automatic retry could not confirm its start; the reserved attempt remains used";
          const receipt = store.activePath(threadId).find(line => line.sendId === p.id);
          if (receipt) current.pending.tailId = receipt.id;
          if (journal.save(current)) processPending(threadId, p.id);
        }));
      return;
    }
    const notices = chief && store.tasks(chief.id).find(task => task.title === INCIDENTS_THREAD_TITLE && !task.archivedAt
      && (!deps.routing || deps.routing.startedBy(task.threadId) === (deps.routing.personOf(chief) ?? undefined)));
    if (chief && (deps.botAtThreadCapacity(chief.id) || deps.groupTurnActive(chief.id)
      || (notices && (deps.threadBusy(chief.id, notices.threadId) || deps.threadSettling?.(notices.threadId)
        || deps.threadQueued?.(chief.id, notices.threadId))))) {
      p.dueAt = Date.now() + 5_000;
      if (journal.save(state)) arm(state);
      return;
    }
    const context = incidentContext(path.filter(line => !(line.peerAsk?.unattended
      && (line.text?.startsWith(AUTO_RETRY_LEAD) || line.text?.startsWith("[Auto-retry from OpenMausBot for ")))));
    const incident: Incident = { kind: p.kind, bot, threadId, title: task?.title ?? null, room: group?.name ?? null, detail: p.detail,
      lastRequest: context.lastRequest ? redactSecretsInText(context.lastRequest) : null,
      lastReply: context.lastReply ? redactSecretsInText(context.lastReply) : null };
    p.phase = "delivering";
    if (!journal.save(state)) return;
    deliver({ chief, title: INCIDENTS_THREAD_TITLE, bot, threadId, chip: incidentChip(incident),
      text: incidentText(incident, p.count, { autoRetried: state.started, reserved: state.attempts - state.started, refused: p.refused }),
      alreadyNotified: p.kind === "could-not-start" || p.kind === "routine-failed" });
    clearPending(state);
  }

  function deliver(input: {
    chief: BotRecord | null; title: string; bot: BotRecord; threadId: string; chip: string; text: string; alreadyNotified: boolean;
  }): "chief" | "person" {
    const { chief, bot, threadId } = input;
    const task = store.taskByThread(bot.id, threadId);
    const group = store.groupByThread(threadId);
    const tellThePerson = () => {
      if (!input.alreadyNotified) {
        deps.notify(buildNotification("incident", bot, threadId, input.chip, {
          avatarUrl: bot.avatarUrl,
          ...(group ? { group: { id: group.id, name: group.name } } : {}),
        }));
      }
      return "person" as const;
    };
    const routing = deps.routing;
    const person = chief && routing ? routing.personOf(chief) : null;
    if (!chief || !reachesChief(chief, bot, threadId)) return tellThePerson();
    const notices = store.tasks(chief.id).find((candidate) => candidate.title === input.title && !candidate.archivedAt &&
        (!routing || routing.startedBy(candidate.threadId) === (person ?? undefined)))
      ?? store.createTask(chief.id, input.title, false, undefined, { botId: chief.id, name: chief.name, at: Date.now() });
    if (!notices || notices.threadId === threadId) return tellThePerson();
    if (routing && person && routing.startedBy(notices.threadId) === undefined) routing.open(notices.threadId, person);
    store.appendMessage(notices.threadId, {
      role: "bot",
      kind: "activity",
      tool: { name: input.chip, ok: false },
      threadRef: { botId: bot.id, threadId, title: task?.title ?? (group ? group.name : `${bot.name}'s conversation`) },
    });
    const peerAsk = { botId: bot.id, name: bot.name, unattended: true,
      incident: { threadId, ...(input.alreadyNotified ? { notified: true } : {}) } };
    const decision = admit("incident", {}, {
      threadBusy: deps.threadBusy(chief.id, notices.threadId),
      atCapacity: deps.botAtThreadCapacity(chief.id),
      groupTurn: deps.groupTurnActive(chief.id),
    });
    if (decision.action === "queue") {
      queueSteeredMessage(chief.id, notices.threadId, input.text, { reason: decision.reason, unattended: true, peerAsk });
      return "chief";
    }
    void deps.startTurn(chief.id, input.text, { threadId: notices.threadId, unattended: true, peerAsk }).catch((error) => {
      incidentRefused(chief, notices.threadId, [peerAsk], error instanceof Error ? error.message : String(error));
    });
    return "chief";
  }

  function reportIncident(input: { kind: IncidentKind; bot: BotRecord; threadId: string; detail: string; facts?: RoutineFailureFacts }): void {
    guarded(() => {
      const { bot, threadId } = input;
      if (deps.quietThread?.(bot.id, threadId) || deps.assignerOf(threadId)) return;
      const path = store.activePath(threadId);
      // Only a new person's text request opens a fresh budget; peer continuations and elapsed time never do.
      const boundary = path.findLast(line => line.role === "user" && line.kind === "text" && !line.peerAsk && !line.aside && !line.automation && !line.roomRequest);
      let state = journal.get(threadId);
      if (state && state.botId !== bot.id) return;
      if (state && state.boundaryId !== (boundary?.id ?? null)) {
        if (!boundary || boundary.at < state.boundaryAt
          || (state.boundaryId !== null && !store.messagesFor(threadId).some(line => line.id === state!.boundaryId))) return;
        state = { threadId, botId: bot.id, boundaryId: boundary.id, boundaryAt: boundary.at,
          attempts: 0, started: 0, revision: state.revision };
      }
      if (!state) {
        const after = boundary ? path.slice(path.indexOf(boundary) + 1) : path;
        const legacy = after.filter(line => line.role === "user" && line.peerAsk?.unattended
          && (line.text?.startsWith(AUTO_RETRY_LEAD) || line.text?.startsWith("[Auto-retry from OpenMausBot for "))).length;
        state = { threadId, botId: bot.id, boundaryId: boundary?.id ?? null, boundaryAt: boundary?.at ?? 0,
          attempts: legacy, started: legacy, revision: 0 };
      }
      const tailId = path.at(-1)?.id ?? null;
      if (state.pending?.tailId === tailId) return;
      const count = incidentLedger.note(threadId);
      // Suppression controls notices, never the durable retry budget.
      const candidate = chiefForBot(store.bots, bot);
      const chief = candidate && reachesChief(candidate, bot, threadId) ? candidate : null;
      const auto = input.kind === "failed" ? autoRetry() : null;
      const answered = path.findLast((line) => line.role === "user")?.text ?? "";
      const retry = auto && chief && !answered.startsWith(RETRY_LEAD) && retriesTeammateThread(input.detail, input.facts)
        && !state.uncertain && !store.groupByThread(threadId) && state.attempts < auto.max;
      if (state.uncertain) count.mayRetry = false;
      if (!retry && count.muted) return;
      state.pending = { id: randomUUID(), phase: retry ? "retry" : "report", chiefId: chief?.id ?? null,
        audience: audience(bot, threadId, chief), kind: input.kind, detail: redactSecretsInText(input.detail).slice(0, 1_000), failedAt: Date.now(), tailId,
        dueAt: Date.now() + (retry ? auto.delayMs : 0), count };
      if (!journal.save(state)) return;
      if (retry) arm(state);
      else processPending(threadId, state.pending.id);
    });
  }

  // Advisory: a delivery fault is logged and never reaches the gate, the turn fold or the caller's own outcome.
  function reportEscalation(input: {
    kind: EscalationKind; bot: BotRecord; threadId: string; gate: string; reason: string; alreadyNotified: boolean;
  }): EscalationOutcome {
    if (!deps.escalationsEnabled()) return "off";
    try {
      const { bot, threadId } = input;
      if (deps.quietThread?.(bot.id, threadId)) return "skipped";
      if (input.kind === "needs-input" && deps.assignerOf(threadId)) return "skipped";
      const task = store.taskByThread(bot.id, threadId);
      const group = store.groupByThread(threadId);
      const escalation: Escalation = {
        kind: input.kind,
        bot,
        threadId,
        title: task?.title ?? null,
        room: group?.name ?? null,
        gate: input.gate,
        reason: redactSecretsInText(input.reason),
      };
      const count = escalationLedger.note(threadId);
      if (count.muted) return "muted";
      const chief = chiefForBot(store.bots, bot);
      return deliver({
        chief: chief && escalationDeliverable(chief, bot) ? chief : null, title: ESCALATIONS_THREAD_TITLE, bot, threadId,
        chip: escalationChip(escalation), text: escalationText(escalation, count), alreadyNotified: input.alreadyNotified,
      });
    } catch (error) {
      console.warn(`escalation for thread ${input.threadId} not delivered: ${error instanceof Error ? error.message : String(error)}`);
      return "failed";
    }
  }

  guarded(() => { for (const state of journal.pending()) arm(state); });
  return { reportIncident, reportEscalation, incidentRefused, retryRefusal, retryThread };
}
