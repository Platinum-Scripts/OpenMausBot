#!/usr/bin/env python3
"""ops hotfix 2026-10-26 — OpenMausBot routine auto-retry watchdog (cron, every 2 min).
OpenMausBot treats a run-limit timeout ("Stopped after reaching the N-minute run limit") or
other terminal failure as final; the only retry path was the Chief model calling
agents.retry_thread, which breaks whenever the model/tool schema breaks. This guard uses the
owner API only (GET /api/routines, GET /api/bots, POST /api/routines/<id>/run = "Run now"):
  * newest run of an enabled routine is `failed`, nothing running/queued for it,
  * failed >= GRACE_MIN ago and its thread was not resumed since (Chief retry_thread wins),
  * next scheduled run is > MIN_GAP_MIN away (otherwise the schedule is the retry),
  * at most MAX_CHAIN consecutive watchdog retries per routine, never the same run twice.
It never interrupts or cancels anything. Log: /var/log/omb-retry-watchdog.log.
Interaction with omb-kimi-limits (2026-10-26): on kimi the sweep limits are aligned to end 2 min before a
schedule slot, so a timed-out sweep always has its next run ~2 min away and is skipped here (the next
scheduled run, with the same raised limit, continues the work). The MIN_GAP_MIN rule therefore only fires
for early failures (errors, crashes), which is the case worth a retry. Hourly status is capped at 58 min,
so a timeout there is also always covered by the next hour.
"""
import json, os, sys, time, urllib.request
API = "http://127.0.0.1:8799"; TOKEN_FILE = "/root/openmausbot-staging-20261025/restore-session.token"
STATE = "/root/omb-retry-watchdog.state.json"; LOG = "/var/log/omb-retry-watchdog.log"
GRACE_MIN = float(os.environ.get("GRACE_MIN", 4)); MIN_GAP_MIN = 6; MAX_CHAIN = 2
DRY = "--dry-run" in sys.argv

def log(m):
    line = time.strftime("%Y-%m-%dT%H:%M:%SZ ", time.gmtime()) + m
    print(line)
    with open(LOG, "a") as f: f.write(line + "\n")

def api(method, path, body=None):
    tok = open(TOKEN_FILE).read().strip()
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)

def ms(t): return (t or 0) if (t or 0) > 1e11 else (t or 0) * 1000

def main():
    st = json.load(open(STATE)) if os.path.exists(STATE) else {"retried": {}, "ours": {}}
    now = time.time() * 1000
    d = api("GET", "/api/routines")
    tasks = {}
    for b in api("GET", "/api/bots").get("bots", []):
        for t in b.get("tasks", []): tasks[t.get("threadId")] = t
    runs = {}
    for r in d.get("runs", []): runs.setdefault(r["routineId"], []).append(r)
    for rt in d.get("routines", []):
        if not rt.get("enabled"): continue
        rs = sorted(runs.get(rt["id"], []), key=lambda r: ms(r.get("createdAt")), reverse=True)
        if not rs or any(r["status"] in ("running", "queued") for r in rs): continue
        last = rs[0]; name = rt.get("name", rt["id"])[:40]
        if last["status"] != "failed" or last["id"] in st["retried"]: continue
        fin = ms(last.get("finishedAt")) or ms(last.get("createdAt"))
        if now - fin < GRACE_MIN * 60000: continue
        t = tasks.get(last.get("threadId"))
        if t and (t.get("busy") or ms(t.get("updatedAt")) > fin + 60000):
            st["retried"][last["id"]] = {"by": "thread-resumed", "at": now}; log(f"skip {name}: run {last['id'][:8]} thread already resumed"); continue
        nxt = ms(rt.get("nextRunAt"))
        if nxt and nxt - now < MIN_GAP_MIN * 60000:
            log(f"skip {name}: run {last['id'][:8]} failed but next scheduled run in {(nxt-now)/60000:.1f} min"); st["retried"][last["id"]] = {"by": "schedule", "at": now}; continue
        chain = st["ours"].get(last["id"], {}).get("chain", 0)
        if chain >= MAX_CHAIN:
            log(f"GIVE UP {name}: {chain} watchdog retries failed in a row (last error: {(last.get('error') or '')[:80]}) — needs a human/Chief look")
            st["retried"][last["id"]] = {"by": "gave-up", "at": now}; continue
        if DRY: log(f"DRY would retry {name}: run {last['id'][:8]} ({(last.get('error') or '')[:60]})"); continue
        try:
            new = api("POST", f"/api/routines/{rt['id']}/run", {}).get("run", {})
        except Exception as e:
            log(f"ERROR retrying {name}: {type(e).__name__} {str(e)[:120]}"); continue
        st["retried"][last["id"]] = {"by": "watchdog", "at": now, "new": new.get("id")}
        if new.get("id"): st["ours"][new["id"]] = {"chain": chain + 1, "routine": rt["id"], "at": now}
        log(f"RETRY {name}: failed run {last['id'][:8]} ({(last.get('error') or '')[:60]}) -> new run {str(new.get('id'))[:8]} [{new.get('status')}] chain={chain+1}")
    cut = now - 3 * 86400000  # prune
    st["retried"] = {k: v for k, v in st["retried"].items() if v.get("at", now) > cut}
    st["ours"] = {k: v for k, v in st["ours"].items() if v.get("at", now) > cut}
    if not DRY:
        tmp = STATE + ".tmp"; json.dump(st, open(tmp, "w")); os.chmod(tmp, 0o600); os.replace(tmp, STATE)

if __name__ == "__main__":
    try: main()
    except Exception as e: log(f"watchdog error: {type(e).__name__} {str(e)[:200]}")
