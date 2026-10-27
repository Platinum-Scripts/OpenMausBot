import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import type { IncidentCount, IncidentKind } from "../incidents.ts";

export interface PendingChiefIncident {
  id: string;
  phase: "retry" | "report" | "dispatching" | "delivering";
  chiefId: string | null;
  audience: string;
  kind: IncidentKind;
  detail: string;
  failedAt: number;
  tailId: string | null;
  dueAt: number;
  count: IncidentCount;
  refused?: string;
}

export interface ChiefRetryState {
  threadId: string;
  botId: string;
  boundaryId: string | null;
  boundaryAt: number;
  attempts: number;
  started: number;
  uncertain?: boolean;
  revision: number;
  pending?: PendingChiefIncident;
}

/** Single-host durable claims. A claimed dispatch is never replayed after a crash. */
export class ChiefRetryJournal {
  private db: DatabaseSync | undefined;
  private failed = false;

  constructor(file?: string) {
    try {
      if (!file) {
        const dir = join(DATA_DIR, "chief-retries");
        file = join(dir, "journal.sqlite");
        if (existsSync(dir) && !existsSync(file)) throw new Error("Missing Chief retry journal");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodSync(dir, 0o700);
      }
      this.db = new DatabaseSync(file);
      if (file !== ":memory:") chmodSync(file, 0o600);
      this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS retries (thread TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL);`);
    } catch {
      this.failed = true;
      try { this.db?.close(); } catch {}
      this.db = undefined;
    }
  }

  private database(): DatabaseSync {
    if (this.failed || !this.db) throw new Error("Chief retry storage unavailable");
    return this.db;
  }

  private decode(row: Record<string, unknown>): ChiefRetryState {
    const state = JSON.parse(String(row.state)) as ChiefRetryState;
    if (state.threadId !== row.thread || state.revision !== row.revision || typeof state.botId !== "string"
      || !(state.boundaryId === null || typeof state.boundaryId === "string") || !Number.isFinite(state.boundaryAt)
      || !Number.isSafeInteger(state.attempts) || state.attempts < 0 || !Number.isSafeInteger(state.started)
      || state.started < 0 || state.started > state.attempts
      || (state.uncertain !== undefined && typeof state.uncertain !== "boolean")) throw new Error("Invalid Chief retry state");
    const p = state.pending;
    if (p && (typeof p.id !== "string" || !["retry", "report", "dispatching", "delivering"].includes(p.phase)
      || !(p.chiefId === null || typeof p.chiefId === "string") || typeof p.audience !== "string" || typeof p.detail !== "string"
      || !["failed", "stalled", "could-not-start", "routine-failed"].includes(p.kind)
      || !(p.tailId === null || typeof p.tailId === "string") || !Number.isFinite(p.failedAt) || !Number.isFinite(p.dueAt)
      || !Number.isSafeInteger(p.count?.count) || p.count.count < 1 || typeof p.count.muted !== "boolean"
      || typeof p.count.mayRetry !== "boolean" || (p.refused !== undefined && typeof p.refused !== "string"))) {
      throw new Error("Invalid pending Chief incident");
    }
    return state;
  }

  get(threadId: string): ChiefRetryState | undefined {
    const row = this.database().prepare("SELECT * FROM retries WHERE thread = ?").get(threadId);
    return row ? this.decode(row) : undefined;
  }

  pending(): ChiefRetryState[] {
    return this.database().prepare("SELECT * FROM retries WHERE json_extract(state, '$.pending') IS NOT NULL")
      .all().map(row => this.decode(row));
  }

  save(state: ChiefRetryState): boolean {
    const next = { ...state, revision: state.revision + 1 };
    const db = this.database();
    const result = state.revision === 0
      ? db.prepare("INSERT OR IGNORE INTO retries VALUES (?, ?, ?)").run(state.threadId, next.revision, JSON.stringify(next))
      : db.prepare("UPDATE retries SET revision = ?, state = ? WHERE thread = ? AND revision = ?")
        .run(next.revision, JSON.stringify(next), state.threadId, state.revision);
    if (result.changes !== 1) return false;
    state.revision = next.revision;
    return true;
  }

  close(): void { this.db?.close(); this.failed = true; }
}
