#!/usr/bin/env python3
"""ops hotfix 2026-10-26: routine time limits follow the bot's model.
Each routine's mode comes from its bot's CURRENT model (discountrouter::kimi-3.1-pro = kimi), so one
idempotent pass handles the switch to kimi, the restore to sol/astra, and any drift (a rebuild, a manual edit).
- base values (timeoutMinutes + the prompt's 'TIME CAP ... By N minutes in') are recorded per routine in STATE
- kimi: timeout ~2.75x base. If base already finished before the next slot (hourly/daily), cap at the gap-2 so
  it still never overlaps the next run; if base already overlapped (sweeps, overlap=skip), round to a slot
  boundary minus 2 min so the run ends just before a slot. Prompt wrap-up point -> max(8, int(0.7*limit)).
- prompts are only edited by swapping that one number; no prompt text is stored.
- rooms.turnTimeoutMinutes (group-room turns only, not routines) is recorded, not changed.
Usage: omb-kimi-limits.py [--dry-run] [--force-mode kimi|base]
Called by /root/dr-model-guard.py on every run. Log: /var/log/omb-kimi-limits.log"""
import json, os, re, sys, time, urllib.request
STATE = "/root/omb-routine-limits.state.json"; LOG = "/var/log/omb-kimi-limits.log"; GLOG = "/var/log/dr-model-guard.log"
TOK = open("/root/openmausbot-staging-20261025/restore-session.token").read().strip()
KIMI = "discountrouter::kimi-3.1-pro"; FACTOR = 2.75; MAXTO = 240
CAP_RE = re.compile(r"(TIME CAP: this run is cut off at its time limit\. By )(\d+)( minutes in)")
DRY = "--dry-run" in sys.argv
FORCE = sys.argv[sys.argv.index("--force-mode") + 1] if "--force-mode" in sys.argv else None

def log(m, guard=False):
    line = time.strftime("%Y-%m-%d %H:%M:%S UTC ", time.gmtime()) + ("[dry-run] " if DRY else "") + m
    print(line)
    if DRY: return
    with open(LOG, "a") as f: f.write(line + "\n")
    if guard:
        with open(GLOG, "a") as f: f.write(line.replace(" UTC ", " UTC limits: ", 1) + "\n")

def api(method, path, body=None):
    r = urllib.request.Request("http://127.0.0.1:8799" + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + TOK, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=60))

def gap(sched):
    if sched.get("type") == "interval": return int(sched["everyMinutes"])
    f = (sched.get("expression") or "").split()
    if len(f) == 5 and f[0].isdigit() and f[2:] == ["*", "*", "*"]:
        return 60 if f[1] == "*" else 1440 if f[1].isdigit() else None
    return None

def kimi_vals(base, sched):
    to = base["timeoutMinutes"]
    t = round(to * FACTOR); g = gap(sched)
    if g:
        if to < g: t = min(t, g - 2)                       # never run into the next slot
        else: t = max(1, round(t / g)) * g - 2           # end just before a slot boundary
    t = max(to, min(MAXTO, t))
    return {"timeoutMinutes": t, "cap": max(8, int(t * 0.7)) if base["cap"] is not None else None}

def cur_vals(r):
    m = CAP_RE.search(r.get("prompt") or "")
    return {"timeoutMinutes": r.get("timeoutMinutes"), "cap": int(m.group(2)) if m else None}

def patch(r, want, why):
    body = {"timeoutMinutes": want["timeoutMinutes"]}
    if want["cap"] is not None and cur_vals(r)["cap"] != want["cap"]:
        body["prompt"] = CAP_RE.sub(lambda m: f"{m.group(1)}{want['cap']}{m.group(3)}", r["prompt"], count=1)
    c = cur_vals(r)
    log(f"{why}: {r['name']} timeout {c['timeoutMinutes']}->{want['timeoutMinutes']} min"
        + (f", wrap-up {c['cap']}->{want['cap']} min" if want["cap"] is not None else ""), guard=True)
    if not DRY: api("PATCH", "/api/routines/" + r["id"], body)

def main():
    st = json.load(open(STATE)) if os.path.exists(STATE) else {"routines": {}}
    if "rooms" not in st:
        try:
            cfg = json.load(open("/home/maus/.openmausbot/config.json"))
            st["rooms"] = {"turnTimeoutMinutes": (cfg.get("rooms") or {}).get("turnTimeoutMinutes"),
                           "note": "group-room turns only; not changed by this script"}
        except Exception as e: st["rooms"] = {"error": str(e)}
    model = {b["id"]: (b.get("modelSelection") or {}).get("model") for b in api("GET", "/api/bots")["bots"]}
    for r in api("GET", "/api/routines")["routines"]:
        if r.get("target") != "bot" or r.get("timeoutMinutes") is None: continue
        mode = FORCE or ("kimi" if model.get(r.get("botId")) == KIMI else "base")
        cur = cur_vals(r); rec = st["routines"].get(r["id"])
        on_kimi = bool(rec) and rec.get("applied") == "kimi"
        kv = kimi_vals(rec["base"], r["schedule"]) if rec else None
        if mode == "base":
            base = cur
            if on_kimi and cur == kv:
                patch(r, rec["base"], ("restore (forced)" if FORCE else f"restore (bot back on {model.get(r.get('botId'))})")); base = rec["base"]
            elif on_kimi:
                log(f"restore skipped: {r['name']} was edited while on kimi {cur}; keeping it as the new base")
            st["routines"][r["id"]] = {"name": r["name"], "base": base, "applied": "base"}
        else:
            if on_kimi and cur == kv: continue
            if on_kimi and cur != rec["base"]:
                log(f"drift: {r['name']} limits {cur} are neither base {rec['base']} nor kimi {kv}; taking them as the new base")
            want = kimi_vals(cur, r["schedule"])
            st["routines"][r["id"]] = {"name": r["name"], "base": cur, "applied": "kimi"}
            if want != cur: patch(r, want, "drift fix (bot on kimi)" if on_kimi else "raise (bot on kimi)")
    if not DRY:
        tmp = STATE + ".tmp"; json.dump(st, open(tmp, "w"), indent=1); os.chmod(tmp, 0o600); os.replace(tmp, STATE)

if __name__ == "__main__": main()
