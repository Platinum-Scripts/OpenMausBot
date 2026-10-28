#!/usr/bin/env python3
"""DR model guard: if DR rate-limits gpt-6.1-sol (429; codex hangs on that instead of
failing over), move the factory bots to codex kimi-3.1-pro and stop their hung turns.
When gpt-6.1-sol answers again, restore each bot's saved model.
Log: /var/log/dr-model-guard.log  State: /root/dr-model-guard.state.json"""
import json, os, subprocess, time, urllib.request, urllib.error
# ops hotfix 2026-10-26: after every guard pass (incl. early exits), make routine time limits match each bot's
# current model (raise on kimi, restore on sol/astra, fix drift). See /opt/omb-ops/omb-kimi-limits.py.
import atexit
def _sync_limits():
    try:
        r = subprocess.run(["/usr/bin/python3", "/opt/omb-ops/omb-kimi-limits.py"], capture_output=True, text=True, timeout=180)
        if r.returncode: log("limits sync failed: " + (r.stderr.strip().splitlines() or ["?"])[-1][:200])
    except Exception as e: log(f"limits sync failed: {e}")
atexit.register(_sync_limits)
STATE = "/root/dr-model-guard.state.json"; LOG = "/var/log/dr-model-guard.log"
TOKF = "/root/openmausbot-staging-20261025/restore-session.token"
TOK = open(TOKF).read().strip()
BOTS = ["Grok Bot", "Factory Ops", "DiscountRouter Fixer", "PackHub Planning", "StreamClash Architect", "MiamiV Architect"]
SAFE = {"instanceId": "codex", "model": "discountrouter::kimi-3.1-pro"}
CLI = "/home/maus/.local/bin/openmausbot"
ENV = dict(os.environ, PATH="/opt/openmausbot/node-v24.22.1-linux-x64/bin:" + os.environ.get("PATH", ""))

def log(m):
    with open(LOG, "a") as f: f.write(time.strftime("%Y-%m-%d %H:%M:%S UTC ", time.gmtime()) + m + "\n")

def drkey():
    for l in open("/home/maus/.secrets/dr.env"):
        if l.startswith("DISCOUNTROUTER_API_KEY="): return l.split("=", 1)[1].strip().strip("\"'")

def probe(model):
    r = urllib.request.Request("https://api.discountrouter.com/v1/responses",
        data=json.dumps({"model": model, "input": "say ok"}).encode(),
        headers={"Authorization": "Bearer " + drkey(), "Content-Type": "application/json"})
    try: return urllib.request.urlopen(r, timeout=60).status
    except urllib.error.HTTPError as e: return e.code
    except Exception: return 0

def api(method, path, body=None):
    r = urllib.request.Request("http://127.0.0.1:8799" + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + TOK, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=120))

def cli(*a):
    subprocess.run([CLI, "interrupt", *a, "--token-file", TOKF, "--url", "http://127.0.0.1:8799"],
                   env=ENV, capture_output=True, timeout=60)

def stop_busy(bid):
    b = [x for x in api("GET", "/api/bots")["bots"] if x["id"] == bid][0]
    n = 0
    if b.get("busy"): cli("--bot", bid, "--tree"); n += 1
    for t in b.get("tasks") or []:
        if t.get("busy"): cli("--bot", bid, "--task", t["threadId"]); n += 1
    return n

def bad(code): return code == 429 or code >= 500 or code == 0

state = json.load(open(STATE)) if os.path.exists(STATE) else {}
sol = probe("gpt-6.1-sol")
if bad(sol):
    time.sleep(20); sol = probe("gpt-6.1-sol")
bots = {b["name"]: b for b in api("GET", "/api/bots")["bots"]}
if bad(sol):
    k = probe("kimi-3.1-pro")
    if k != 200:
        log(f"sol={sol}, kimi={k}: no safe model, no swap"); raise SystemExit
    for n in BOTS:
        b = bots.get(n)
        if not b or b["modelSelection"] == SAFE: continue
        state[b["id"]] = {"name": n, "model": b["modelSelection"]}
        json.dump(state, open(STATE, "w"))
        api("PATCH", "/api/bots/" + b["id"], {"threadId": b["mainThreadId"], "modelSelection": SAFE})
        s = stop_busy(b["id"])
        log(f"sol={sol}: {n} {b['modelSelection']['model']} -> kimi-3.1-pro, stopped {s} hung turn(s)")
elif sol == 200 and state:
    byid = {b["id"]: b for b in bots.values()}
    for bid, s in list(state.items()):
        b = byid.get(bid)
        if not b: del state[bid]; continue
        if b["modelSelection"] != SAFE: del state[bid]; continue   # someone changed it; leave alone
        api("PATCH", "/api/bots/" + bid, {"threadId": b["mainThreadId"], "modelSelection": s["model"]})
        log(f"sol=200: restored {s['name']} -> {s['model']['model']}")
        del state[bid]
    json.dump(state, open(STATE, "w"))
