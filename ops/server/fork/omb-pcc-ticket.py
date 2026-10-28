#!/usr/bin/env python3
"""File one deduplicated failure ticket; stdout is a confirmed PCC identifier only."""
import datetime
import json
import os
import re
import shlex
import subprocess
import sys

REMOTE_CODE = '''import fo,json,re,sys
p=json.load(sys.stdin)
ident=fo.file_issue("PCC",p["title"],p["body"],p["dedupe_key"],dedupe_minutes=720)
if not isinstance(ident,str) or not re.fullmatch(r"PCC-[1-9][0-9]*",ident):
    raise SystemExit(1)
print(ident)
'''
REMOTE_COMMAND = "cd /opt/factory-ops && python3 -c " + shlex.quote(REMOTE_CODE)


def file_ticket(title, body, destination):
    if not destination or not re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+", destination):
        raise ValueError("factory SSH destination missing or invalid")
    payload = json.dumps({
        "title": title,
        "body": body,
        "dedupe_key": "omb-fork-update-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d"),
    })
    result = subprocess.run([
        "sudo", "-u", "maus", "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
        "-i", "/home/maus/.ssh/factory_ops_ed25519", destination, REMOTE_COMMAND,
    ], input=payload, capture_output=True, text=True, timeout=300, check=False)
    identifier = result.stdout.strip()
    if result.returncode != 0 or not re.fullmatch(r"PCC-[1-9][0-9]*", identifier):
        raise ValueError("ticket creation unconfirmed")
    return identifier


def main():
    try:
        print(file_ticket(sys.argv[1], sys.stdin.read(), os.environ.get("FACTORY_SSH", "")))
    except (IndexError, OSError, ValueError, subprocess.TimeoutExpired):
        # Remote stderr and partial output can contain credentials or an ambiguous receipt.
        print("PCC ticket unconfirmed; reconcile the daily dedupe key before retrying", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
