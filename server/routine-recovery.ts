// What an unattended routine run's failure turns into: a failure starts the run once more after a short wait, unless a
// second start could only repeat or undo it (a stall the turn watchdog stopped, a stop someone pressed or typed, a
// refusal, a spent cap); a busy target is waited for, a usage limit with a known reset is waited out, and what only the
// owner can fix fails at once and is told to them once per bot and cause, until one of that bot's runs completes.
// A teammate's failed thread takes the same verdict (host/chief-notices.ts).
import type { RuntimeEvent } from "../shared/runtime-events.ts";
import type { RoutineRetryCause, RoutineRetryPolicy } from "../shared/routines.ts";
import { engineFailureKind } from "./drivers/engine-errors.ts";
import { classifyError } from "./drivers/retry.ts";
import { outcomesNewestFirst } from "./routine-outcomes.ts";
import { resolveRetryPolicy, RETRY_POLICY_LEGACY, RETRY_STREAK_CAP, retryPolicyOn } from "./routine-retry-policy.ts";
import type { RoutineRun } from "./routines.ts";
import { hostTimeZone } from "./turn-clock.ts";
import { classifyContinuable } from "./turn-continuation.ts";

export type RoutineOwnerCause = "signed_out" | "credits" | "usage_limit" | "setup";

/** What is known about a failure besides its words: a cause the server words itself, and the engine's own flags. */
export interface RoutineFailureFacts {
  /** stalled: the turn watchdog stopped it; cap: a spend or turn cap (or the repeat guard) ended it; refused: the server
   * would not start it, or its start failed before the turn began (judged by its words, never retried as a crash). */
  cause?: "stalled" | "busy" | "cap" | "refused";
  stopReason?: string | null;
  setup?: boolean;
  stalled?: boolean;
  trialCredit?: string;
  limitResetsAt?: number;
  /** A backup engine takes over from one whose usage limit refused the run. */
  backupReady?: boolean;
}

export type RoutineFailureClass =
  | { kind: "retry"; cause: Exclude<RoutineRetryCause, "usage_limit" | "timeout"> }
  | { kind: "busy" }
  | { kind: "owner"; cause: RoutineOwnerCause; resetsAt?: number }
  | { kind: "final" };

/** A failure notification's own words; null stays quiet because the owner was already told. */
export interface RoutineAlert { detail: string }

export interface RoutineOwnerNotice { botId: string; cause: RoutineOwnerCause; at: number }

export type RoutineRecovery = { queued: true; alert?: RoutineAlert } | { queued: false; error: string; alert?: RoutineAlert | null };

const RETRY_MS = 15_000;
const RATE_LIMIT_RETRY_MS = 60_000;
export const ROUTINE_BUSY_RECHECK_MS = 30_000;
export const ROUTINE_BUSY_WAIT_MS = 60 * 60_000;
/** Past this, a usage limit fails the run instead: the routine's next scheduled runs come sooner. */
const LIMIT_WAIT_MS = 12 * 60 * 60_000;
const AFTER_RESET_MS = 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;
/** startTurn's codes for a bot or thread that is busy for now. */
const BUSY_CODES = new Set(["thread_busy", "thread_limit", "workspace_busy", "settling"]);
/** Stop reasons of a turn someone ended on purpose (Stop, a typed "stop", a settings change that cut it short), the AI
 * declined, or a tool call the person denied or that failed after its corrective rounds: a second start would undo or
 * repeat it. */
const NOT_RETRIED_STOPS = new Set(["cancelled", "interrupted", "refusal", "tool_error"]);
/** What the provider answered for a reason a second start would meet again. */
const REFUSED_KINDS = new Set(["refused", "tool_schema", "tool_count"]);
const OWNER_CAUSES = new Set<RoutineOwnerCause>(["signed_out", "credits", "usage_limit", "setup"]);

const OWNER_ACTION: Record<Exclude<RoutineOwnerCause, "setup">, string> = {
  signed_out: "This bot's AI is signed out. Sign in again in Settings → Model providers.",
  credits: "This bot's AI account is out of credit. Add credit with the provider, or choose another AI for this bot.",
  usage_limit: "This bot's AI reached its usage limit. Its routines work again once it resets, or choose another AI for this bot now.",
};
const TRIAL_ACTION = "The trial Claude credit can't run this. Sign in with your own Claude or ChatGPT account, or add an API key.";
const RETRY_WHY: Record<Exclude<RoutineRetryCause, "usage_limit">, string> = {
  stalled: "the AI stalled", restarted: "OpenMausBot restarted while it ran", rate_limited: "a rate limit", provider: "a temporary error",
  timeout: "reaching its run limit",
  failed: "a failure",
};
const FIRST_START: Record<Exclude<RoutineRetryCause, "timeout">, string> = {
  stalled: "stopped when its AI stalled", restarted: "was cut off when OpenMausBot restarted", rate_limited: "was stopped by a rate limit",
  provider: "failed on a temporary AI error", usage_limit: "was refused by the AI's usage limit", failed: "failed",
};
/** Any failure gets one automatic retry, except a stall the turn watchdog stopped (its Chief hears instead), a
 * stop someone pressed or typed, a refusal, and a spent cap. Routine runs and teammate threads both judge by this. */
export function classifyRoutineFailure(failure: string, facts: RoutineFailureFacts = {}): RoutineFailureClass {
  if (facts.cause === "busy") return { kind: "busy" };
  if (facts.cause === "stalled" || facts.cause === "cap") return { kind: "final" };
  if (facts.stopReason && NOT_RETRIED_STOPS.has(facts.stopReason)) return { kind: "final" };
  if (classifyContinuable(facts.stopReason, failure) === "cap") return { kind: "final" };
  if (facts.stalled) return { kind: "retry", cause: "stalled" };
  const engine = engineFailureKind(failure);
  const { reason, transient } = classifyError({ text: failure });
  if (facts.trialCredit || engine === "credits") return { kind: "owner", cause: "credits" };
  if (facts.limitResetsAt || facts.stopReason === "quota" || engine === "usage_limit") {
    return { kind: "owner", cause: "usage_limit", ...(facts.limitResetsAt ? { resetsAt: facts.limitResetsAt } : {}) };
  }
  if (facts.stopReason === "auth_required" || reason === "auth") return { kind: "owner", cause: "signed_out" };
  if (reason === "quota") return { kind: "owner", cause: "credits" };
  if (facts.setup || facts.stopReason === "update_required" || facts.stopReason === "setup_required") return { kind: "owner", cause: "setup" };
  if (engine === "rate_limit" || reason === "rate_limited") return { kind: "retry", cause: "rate_limited" };
  if (engine === "overloaded" || engine === "server" || transient) return { kind: "retry", cause: "provider" };
  // A failure nothing above names (a crash, an exit before the result): one more start. A refused start or a named refusal never.
  return reason === "unknown" && facts.cause !== "refused" && !(engine && REFUSED_KINDS.has(engine)) ? { kind: "retry", cause: "failed" } : { kind: "final" };
}

/** Why startTurn would not start a run: busy for now, the workspace spend cap, or any other refusal. A start that threw
 * without a status or code (an engine that would not spawn) is a failure like any other. */
export function dispatchRefusal(error: unknown): RoutineFailureFacts {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  if (typeof code === "string" && BUSY_CODES.has(code)) return { cause: "busy" };
  if (code === "spend_cap") return { cause: "cap" };
  return typeof code === "string" || (typeof status === "number" && status >= 400 && status < 500) ? { cause: "refused" } : {};
}

/** Whether OpenMausBot runs a failed teammate thread once more by itself before its Chief hears of it. */
export function retriesTeammateThread(failure: string, facts: RoutineFailureFacts = {}): boolean {
  return classifyRoutineFailure(failure, facts).kind === "retry";
}

export function engineFacts({ setup, stalled, trialCredit, limitResetsAt }: RuntimeEvent & { type: "runtime.error" }): RoutineFailureFacts {
  return { setup, stalled, trialCredit, limitResetsAt };
}

/** Host-local, with its zone: on a Cloud home the host's zone need not be the reader's. */
function when(at: number): string {
  const timeZone = hostTimeZone();
  try {
    return `${new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })} (${timeZone})`;
  } catch {
    return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

/** How many times the run already started again by itself. */
export function retriesOf(run: Pick<RoutineRun, "retried" | "retries">): number {
  return run.retries ?? (run.retried === undefined ? 0 : 1);
}

const retryWord = (count: number) => `${count} automatic ${count === 1 ? "retry" : "retries"}`;

/** Queues the run's next start; false when it already had `limit` of them or is not a bot's run. */
function requeue(run: RoutineRun, cause: RoutineRetryCause, failure: string, at: number, limit: number): boolean {
  const retries = retriesOf(run);
  if (run.target !== "bot" || retries >= limit) return false;
  run.status = "queued";
  run.retried = cause;
  run.retries = retries + 1;
  run.retryAt = at;
  run.attention = cause === "usage_limit"
    ? `Waiting for the AI's usage limit to reset; this run starts again at ${when(at)}`
    : `Starting again shortly after ${RETRY_WHY[cause]}${cause === "restarted" ? "" : `: ${failure}`}`.slice(0, 500);
  delete run.error;
  return true;
}

/** Queues the run's one second start after a restart or a usage limit; false when it already started again. */
export function requeueOnce(run: RoutineRun, cause: RoutineRetryCause, failure: string, now: number,
  at = now + (cause === "rate_limited" ? RATE_LIMIT_RETRY_MS : RETRY_MS)): boolean {
  return requeue(run, cause, failure, at, 1);
}

/** The retry policy a run starts again by, and why it must not, or null: a newer run of its routine took over, or the
 * routine keeps failing. `on` is false while neither config.json nor the routine asked for automatic retries. */
export interface RetryContext {
  policy: RoutineRetryPolicy;
  refusal: string | null;
  on: boolean;
}

/** A newer run of the same routine is working or has completed since `run` began: starting `run` again would redo or
 * race that run's work. */
export function overtakenBy(runs: readonly RoutineRun[], run: RoutineRun): string | null {
  const at = runs.indexOf(run);
  const newer = runs.filter((other, index) => index > at && other.routineId === run.routineId && other.id !== run.id);
  if (newer.some((other) => other.status === "running" || other.status === "waiting")) return "a newer run of this routine is already running";
  if (newer.some((other) => other.status === "completed")) return "a newer run of this routine has completed since";
  return null;
}

/** Without any "retryOnFailure" (config.json or the routine's own), retries behave as they always did. */
export function retryContextFor(runs: readonly RoutineRun[], run: RoutineRun, workspace?: Partial<RoutineRetryPolicy>,
  own?: Partial<RoutineRetryPolicy>): RetryContext {
  const policy = resolveRetryPolicy(workspace, own);
  if (!retryPolicyOn(workspace, own)) return { policy, refusal: null, on: false };
  const outcomes = outcomesNewestFirst(runs, run.routineId, run.id);
  const success = outcomes.findIndex((outcome) => outcome.status === "completed");
  const streak = success < 0 ? outcomes.length : success;
  return { policy, refusal: overtakenBy(runs, run) ?? (streak >= RETRY_STREAK_CAP ? `its last ${streak} runs failed too` : null), on: true };
}

/** A queued automatic retry whose routine moved on meanwhile is cancelled instead of started; true when it was. */
export function cancelOvertakenRetry(runs: readonly RoutineRun[], run: RoutineRun, retry: RetryContext, now: number): boolean {
  if (run.retried === undefined || run.retried === "restarted") return false;
  const refused = overtakenBy(runs, run) ?? (retriesOf(run) > retry.policy.max ||
    (run.retried === "timeout" && (!retry.on || retry.policy.onTimeout === "off"))
    ? "the current retry policy no longer permits this attempt" : null);
  if (refused) Object.assign(run, { status: "cancelled", attention: undefined, finishedAt: now, error: `Not retried: ${refused}` } satisfies Partial<RoutineRun>);
  return refused !== null;
}

/** A run that reached its run limit: it starts again with a fresh limit, in its own thread ("resume") or a new one
 * ("rerun"), until its policy's retries are used up. A queued run is changed in place; a failing one is the caller's
 * to fail with `error`. */
export function recoverTimeout(run: RoutineRun, limitReached: string, now: number, retry: RetryContext): RoutineRecovery {
  const retries = retriesOf(run);
  const given = retries ? `${limitReached} (after ${retryWord(retries)})` : limitReached;
  if (run.target !== "bot" || retry.policy.onTimeout === "off") return { queued: false, error: given };
  if (retry.refusal) return { queued: false, error: `${given}. Not retried: ${retry.refusal}` };
  if (!requeue(run, "timeout", limitReached, now + retry.policy.delayMinutes * 60_000, retry.policy.max)) return { queued: false, error: given };
  for (const field of ["waitedMs", "asked", "waitingSince", "deferredAt", "deferredNoticeAt"] as const) delete run[field];
  run.timeoutPending = true;
  const limit = run.timeoutMinutes ? `a fresh ${run.timeoutMinutes}-minute run limit` : "a fresh run limit";
  run.attention = retry.policy.onTimeout === "resume"
    ? `Reached its run limit; continuing in its own thread with ${limit} at ${when(run.retryAt!)}`
    : `Reached its run limit; starting over in a new thread with ${limit} at ${when(run.retryAt!)}`;
  return { queued: true };
}

export function settleTimeoutRetry(run: RoutineRun, retry: RetryContext, settled?: (botId: string, threadId: string) => boolean): boolean {
  if (!run.timeoutPending) return true;
  if (!run.threadId || settled?.(run.botId, run.threadId) !== true) return false;
  if (retry.policy.onTimeout === "rerun") delete run.threadId;
  delete run.timeoutPending;
  return true;
}

/** The next start's own line, so a run that already did part of its work does not do it twice. */
export function retryNote(cause: RoutineRetryCause): string {
  if (cause === "timeout") {
    return "[Auto-retry from OpenMausBot: this run's last start reached its run limit before it finished, and it starts again with a fresh limit. " +
      "Check what it already did (files, messages sent, anything started) so nothing is done twice, then finish the routine. " +
      "If the same problem comes back, say exactly what is blocking and stop.]";
  }
  return `[OpenMausBot: this run's first start ${FIRST_START[cause]} before it finished. If it already did part of the work, ` +
    "check what it did (files, messages sent, anything started) so nothing is done twice; then finish the routine.]";
}

function firstNotice(notices: RoutineOwnerNotice[], botId: string, cause: RoutineOwnerCause, at: number): boolean {
  if (notices.some((notice) => notice.botId === botId && notice.cause === cause)) return false;
  notices.push({ botId, cause, at });
  return true;
}

/** What a failed attempt becomes. A queued run is changed in place; a failing one is the caller's to fail with `error`. */
export function recoverRun(run: RoutineRun, failure: string, facts: RoutineFailureFacts, now: number, notices: RoutineOwnerNotice[],
  retry: RetryContext = { policy: RETRY_POLICY_LEGACY, refusal: null, on: false }): RoutineRecovery {
  const verdict: RoutineFailureClass = run.target === "bot" ? classifyRoutineFailure(failure, facts) : { kind: "final" };
  const retries = retriesOf(run);
  const again = retries ? `Failed after ${retries === 1 ? "one automatic retry" : retryWord(retries)}: ${failure}` : failure;
  if (verdict.kind === "busy") {
    run.deferredAt ??= now;
    // A run of checked items waits as long as it takes: its bot is busy with the person, which is not a failure.
    if (now - run.deferredAt >= ROUTINE_BUSY_WAIT_MS && run.checkKey === undefined) return { queued: false, error: `Did not start: still busy after ${ROUTINE_BUSY_WAIT_MS / 60_000} minutes (${failure})` };
    run.status = "queued";
    run.retryAt = now + ROUTINE_BUSY_RECHECK_MS;
    run.attention = `Waiting to start: ${failure}`.slice(0, 500);
    delete run.error;
    return { queued: true };
  }
  if (verdict.kind === "retry") {
    if (retry.refusal && retries < retry.policy.max) return { queued: false, error: `${again}. Not retried: ${retry.refusal}` };
    const at = now + (verdict.cause === "rate_limited" ? RATE_LIMIT_RETRY_MS : RETRY_MS);
    return requeue(run, verdict.cause, failure, at, retry.policy.max) ? { queued: true } : { queued: false, error: again };
  }
  if (verdict.kind === "final") return { queued: false, error: again };
  if (verdict.cause === "usage_limit" && facts.backupReady && requeueOnce(run, "usage_limit", failure, now, now + RETRY_MS)) {
    run.attention = "Starting again on the backup AI: this bot's AI reached its usage limit";
    return { queued: true };
  }
  const first = firstNotice(notices, run.botId, verdict.cause, now);
  const reset = verdict.resetsAt;
  if (reset && reset > now && reset - now <= LIMIT_WAIT_MS && requeueOnce(run, "usage_limit", failure, now, reset + AFTER_RESET_MS)) {
    return { queued: true, ...(first ? { alert: { detail: `This bot's AI reached its usage limit. This run starts again at ${when(reset + AFTER_RESET_MS)}.` } } : {}) };
  }
  const action = verdict.cause === "setup" ? failure : verdict.cause === "credits" && facts.trialCredit ? TRIAL_ACTION : OWNER_ACTION[verdict.cause];
  return { queued: false, error: verdict.cause === "signed_out" ? `${action} The AI said: “${failure}”` : failure, alert: first ? { detail: action } : null };
}

export function loadOwnerNotices(value: unknown): RoutineOwnerNotice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((notice) => typeof notice?.botId === "string" && OWNER_CAUSES.has(notice.cause) && Number.isFinite(notice.at)
    ? [{ botId: notice.botId, cause: notice.cause as RoutineOwnerCause, at: notice.at as number }] : []).slice(-500);
}

export function weekRuns(runs: readonly RoutineRun[], routineId: string, now: number): { ok: number; total: number } | undefined {
  let ok = 0, total = 0;
  for (const run of runs) {
    if (run.routineId !== routineId || !["completed", "failed", "missed"].includes(run.status) || (run.finishedAt ?? run.createdAt) < now - WEEK_MS) continue;
    total += 1;
    if (run.status === "completed") ok += 1;
  }
  return total ? { ok, total } : undefined;
}
