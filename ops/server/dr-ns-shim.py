#!/usr/bin/env python3
"""ops hotfix 2026-10-26 — DiscountRouter namespace shim for codex.
Codex 0.164 sends MCP tools as Responses `namespace` tools. DiscountRouter's non-OpenAI
adapters (kimi, grok, glm) return the function_call with the bare tool name and NO
`namespace`, so codex answers "unsupported call: <tool>" for every MCP tool (agents.*,
browser.*), including retry_thread. This pass-through proxy restores `namespace` on
function_call items (from the request's own tool list, else from DR's call_id
"<ns>--_--<tool>_<n>_<hex>"). Everything else is forwarded byte-for-byte.
Remove once DiscountRouter preserves namespace (see DRO/PCC tickets)."""
import gzip, http.client, json, re, sys, time, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
UP_HOST = "api.discountrouter.com"; LISTEN = ("127.0.0.1", 8790); LOG = "/var/log/dr-ns-shim.log"
CALL_RE = re.compile(r"^(?P<ns>.+?)--_--(?P<name>.+)_\d+_[0-9a-f]+$")
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
       "transfer-encoding", "upgrade", "host", "accept-encoding", "content-length"}

def log(m):
    try:
        with open(LOG, "a") as f: f.write(time.strftime("%Y-%m-%dT%H:%M:%SZ ", time.gmtime()) + m + "\n")
    except Exception: pass

def tool_map(body, enc):
    try:
        if enc == "gzip": body = gzip.decompress(body)
        elif enc == "deflate": body = zlib.decompress(body)
        elif enc: return {}, None
        req = json.loads(body)
    except Exception: return {}, None
    m = {}
    for t in req.get("tools") or []:
        if isinstance(t, dict) and t.get("type") == "namespace":
            for c in t.get("tools") or []:
                if isinstance(c, dict) and c.get("name"): m.setdefault(c["name"], set()).add(t.get("name"))
    return m, req.get("model")

def fix(obj, tmap, stats):
    if isinstance(obj, dict):
        if obj.get("type") == "function_call" and not obj.get("namespace"):
            name = obj.get("name") or ""; ns = None
            cands = tmap.get(name)
            if cands and len(cands) == 1: ns = next(iter(cands))
            else:
                mm = CALL_RE.match(str(obj.get("call_id") or ""))
                if mm and mm.group("name") == name:
                    guess = mm.group("ns")
                    if cands:  # prefer a declared namespace that matches DR's prefix
                        for c in cands:
                            if c.rstrip("_") == guess.rstrip("_"): ns = c
                    elif not tmap: ns = guess
            if ns:
                obj["namespace"] = ns; stats.append(f"{ns}/{name}")
        for v in obj.values(): fix(v, tmap, stats)
    elif isinstance(obj, list):
        for v in obj: fix(v, tmap, stats)

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def _go(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        tmap, model = tool_map(body, (self.headers.get("Content-Encoding") or "").lower()) if body else ({}, None)
        hdrs = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        hdrs["Accept-Encoding"] = "identity"
        if body: hdrs["Content-Length"] = str(len(body))
        try:
            c = http.client.HTTPSConnection(UP_HOST, timeout=900)
            c.request(self.command, self.path, body=body or None, headers=hdrs)
            r = c.getresponse()
        except Exception as e:
            log(f"upstream error {self.command} {self.path}: {type(e).__name__}")
            self.send_response(502); self.send_header("Content-Length", "0"); self.end_headers(); return
        self.send_response(r.status, r.reason)
        ctype = r.getheader("Content-Type") or ""
        for k, v in r.getheaders():
            if k.lower() not in HOP and k.lower() != "content-encoding": self.send_header(k, v)
        self.send_header("Transfer-Encoding", "chunked"); self.end_headers()
        stats = []
        def out(b):
            if b: self.wfile.write(b"%x\r\n%s\r\n" % (len(b), b)); self.wfile.flush()
        try:
            if "text/event-stream" in ctype:
                while True:
                    line = r.readline()
                    if not line: break
                    if line.startswith(b"data:") and b"function_call" in line:
                        try:
                            d = json.loads(line[5:]); fix(d, tmap, stats)
                            line = b"data: " + json.dumps(d, separators=(",", ":")).encode() + b"\n"
                        except Exception: pass
                    out(line)
            else:
                data = r.read()
                if b"function_call" in data and "json" in ctype:
                    try: d = json.loads(data); fix(d, tmap, stats); data = json.dumps(d).encode()
                    except Exception: pass
                out(data)
            self.wfile.write(b"0\r\n\r\n"); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError): pass
        finally:
            c.close()
            if stats: log(f"model={model} restored namespace on {len(stats)} item(s): {sorted(set(stats))}")
    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _go

if __name__ == "__main__":
    ThreadingHTTPServer.daemon_threads = True
    log("shim start"); ThreadingHTTPServer(LISTEN, H).serve_forever()
