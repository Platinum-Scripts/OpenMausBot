// How a failed or timed-out run starts again by itself: the workspace default, a routine's own fields over it, and the
// limits both are kept to.
import { z } from "zod";
import type { RoutineRetryPolicy, RoutineTimeoutRetry } from "../shared/routines.ts";

/** Without any "retryOnFailure" (config.json or the routine's own): what OpenMausBot always did. A passing error gets
 * one more start; a run that reaches its run limit fails. */
export const RETRY_POLICY_LEGACY: RoutineRetryPolicy = { max: 1, delayMinutes: 2, onTimeout: "off" };
/** What a "retryOnFailure" that leaves a field out means for it. */
export const RETRY_POLICY_DEFAULT: RoutineRetryPolicy = { max: 1, delayMinutes: 2, onTimeout: "resume" };
export const RETRY_MAX_LIMIT = 2;
export const RETRY_DELAY_LIMIT_MINUTES = 60;
/** A routine whose last this-many outcomes all failed does not start again by itself: the next retry would fail too. */
export const RETRY_STREAK_CAP = 3;

const TIMEOUT_RETRIES = new Set<RoutineTimeoutRetry>(["resume", "rerun", "off"]);

const wholeIn = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;

/** The fields a person or config.json set, checked: `strict` throws on a bad field, otherwise a bad field is dropped. */
export function retryPolicyFields(value: unknown, strict = false): Partial<RoutineRetryPolicy> | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    if (strict) throw new Error("retryOnFailure is an object with max, delayMinutes and onTimeout");
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const fields: Partial<RoutineRetryPolicy> = {};
  if (raw.max !== undefined) {
    if (wholeIn(raw.max, RETRY_MAX_LIMIT)) fields.max = raw.max;
    else if (strict) throw new Error(`retryOnFailure.max is a whole number from 0 to ${RETRY_MAX_LIMIT}`);
  }
  if (raw.delayMinutes !== undefined) {
    if (wholeIn(raw.delayMinutes, RETRY_DELAY_LIMIT_MINUTES)) fields.delayMinutes = raw.delayMinutes;
    else if (strict) throw new Error(`retryOnFailure.delayMinutes is a whole number from 0 to ${RETRY_DELAY_LIMIT_MINUTES}`);
  }
  if (raw.onTimeout !== undefined) {
    if (TIMEOUT_RETRIES.has(raw.onTimeout as RoutineTimeoutRetry)) fields.onTimeout = raw.onTimeout as RoutineTimeoutRetry;
    else if (strict) throw new Error("retryOnFailure.onTimeout is resume, rerun or off");
  }
  return Object.keys(fields).length || Object.keys(raw).length === 0 ? fields : undefined;
}

const isObject = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether anyone asked for automatic retries: config.json or the routine sets "retryOnFailure", even as `{}`. */
export function retryPolicyOn(workspace?: unknown, own?: unknown): boolean {
  return isObject(workspace) || isObject(own);
}

/** Off unless asked for: the policy applies once config.json or the routine sets "retryOnFailure", even as `{}`. */
export function resolveRetryPolicy(workspace?: Partial<RoutineRetryPolicy>, own?: Partial<RoutineRetryPolicy>): RoutineRetryPolicy {
  const base = retryPolicyOn(workspace, own) ? RETRY_POLICY_DEFAULT : RETRY_POLICY_LEGACY;
  return { ...base, ...retryPolicyFields(workspace), ...retryPolicyFields(own) };
}

/** How a failed or timed-out routine starts again by itself, and how a teammate thread's default one immediate retry
 * can be changed or disabled. Routine defaults stay legacy while absent; once set (even `{}`), absent fields mean
 * max 1, delayMinutes 2, onTimeout "resume", threads on. */
export const retryOnFailureConfigSchema = z.object({
  max: z.number().int().min(0).max(RETRY_MAX_LIMIT).optional(),
  delayMinutes: z.number().int().min(0).max(RETRY_DELAY_LIMIT_MINUTES).optional(),
  onTimeout: z.enum(["resume", "rerun", "off"]).optional(),
  /** A teammate's thread that failed or stalled is resumed by OpenMausBot before its Chief of Staff hears of it. On unless false. */
  threads: z.boolean().optional(),
}).strict();
export type RetryOnFailureConfig = z.infer<typeof retryOnFailureConfigSchema>;
