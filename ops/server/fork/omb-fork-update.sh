#!/bin/bash
# OpenMausBot fork pipeline (runs as root; git/build steps run as maus).
#   omb-fork-update.sh update            daily: fetch upstream, ff fork main, rebase deploy onto main,
#                                        build+test, push, deploy at a quiet point, health check, auto-rollback
#   omb-fork-update.sh deploy-ref <ref>  build <ref> (no rebase/push) and deploy it
#   omb-fork-update.sh rollback          switch back to the previous build
#   omb-fork-update.sh rollback-npm      stop running the fork; run the original npm install again
#   omb-fork-update.sh health            health-check what is running now
# Status: /home/maus/omb-builds/last-update.json (+ last-update.log). Full log: /var/log/omb-fork-update.log
# Fork: Platinum-Scripts/OpenMausBot  (main = mirror of upstream milind-soni/OpenMausBot main; deploy = main + our commits = what runs)
set -uo pipefail
[ -f /etc/omb-ops/fork.env ] && . /etc/omb-ops/fork.env   # FACTORY_SSH=root@<factory host> (kept off the public fork)
SRC=/home/maus/src/OpenMausBot; B=/home/maus/omb-builds; LOG=/var/log/omb-fork-update.log
NODEBIN=/opt/openmausbot/node-v24.22.1-linux-x64/bin
API=http://127.0.0.1:8799; TOKF=/root/openmausbot-staging-20261025/restore-session.token
DROPIN=/etc/systemd/system/openmausbot.service.d/30-fork.conf
QUIET_MAX_MIN=${QUIET_MAX_MIN:-45}; QUIET_ROUTINE_ONLY_AFTER_MIN=${QUIET_ROUTINE_ONLY_AFTER_MIN:-30}
mkdir -p $B; chown maus:maus $B
RUN_ID=$(date -u +%Y%m%dT%H%M%SZ); RLOG=$B/last-update.log; : > $RLOG; chown maus:maus $RLOG
exec 9>/run/omb-fork-update.lock; flock -n 9 || { echo "another update is running"; exit 3; }
log(){ local l="$(date -u +%FT%TZ) [$RUN_ID] $*"; echo "$l" | tee -a $LOG >> $RLOG; echo "$l"; }
status(){ # stage ok detail
  python3 - "$@" <<'PY'
import json,sys,time,os
p="/home/maus/omb-builds/last-update.json"
d=json.load(open(p)) if os.path.exists(p) else {}
if d.get("run")!=os.environ["RUN_ID"]: d={"run":os.environ["RUN_ID"],"mode":os.environ.get("MODE"),"started":time.strftime("%FT%TZ",time.gmtime())}
d.update(stage=sys.argv[1], ok=sys.argv[2]=="1", detail=sys.argv[3], updated=time.strftime("%FT%TZ",time.gmtime()))
for k in ("OLD_DEPLOY","NEW_DEPLOY","UPSTREAM","BUILD_DIR","PREV_BUILD"):
  if os.environ.get(k): d[k.lower()]=os.environ[k]
json.dump(d,open(p+".tmp","w"),indent=1); os.replace(p+".tmp",p); os.chmod(p,0o644)
PY
}
export RUN_ID MODE=${1:-update}
asmaus(){ sudo -u maus bash -c ". /home/maus/src/build-env.sh; cd $SRC; $*"; }
pcc_ticket(){ # title body
  local t="$1" b="$2"
  sudo -u maus ssh -o BatchMode=yes -o ConnectTimeout=15 -i /home/maus/.ssh/factory_ops_ed25519 "$FACTORY_SSH" \
    "cd /opt/factory-ops && python3 -c 'import fo,sys; print(fo.file_issue(\"PCC\", sys.argv[1], sys.stdin.read(), \"omb-fork-update-\"+sys.argv[2], dedupe_minutes=720))' \"$t\" \"$(date -u +%F)\"" <<<"$b" 2>&1 | tail -1
}
fail(){ # stage msg
  log "FAIL at $1: $2"; status "$1" 0 "$2"
  local tk; tk=$(pcc_ticket "OpenMausBot fork $MODE failed at $1 (running build untouched)" \
"The OpenMausBot fork pipeline (omb-fork-update.sh $MODE, run $RUN_ID, OMB server $(hostname)) failed at stage: $1.
Detail: $2
The running build was left alone (or rolled back automatically). Repo: /home/maus/src/OpenMausBot (fork Platinum-Scripts/OpenMausBot; main mirrors milind-soni/OpenMausBot main; deploy = main + our commits).
Log tail:
$(tail -n 60 $RLOG)
Fix: resolve the conflict/build failure on the fork's deploy branch (rebase our commits onto main), push deploy, then run on the OMB server: touch /home/maus/omb-builds/update-request (or as root: /opt/omb-ops/omb-fork-update.sh update). Acceptance: last-update.json shows stage=done ok=true.")
  log "PCC ticket: $tk"; python3 - "$tk" <<'PY'
import json,sys; p="/home/maus/omb-builds/last-update.json"; d=json.load(open(p)); d["ticket"]=sys.argv[1]; json.dump(d,open(p,"w"),indent=1)
PY
  exit 1; }
api(){ curl -sS -m 20 -H "Authorization: Bearer $(cat $TOKF)" "$API$1"; }
health(){ # expected_bots expected_routines want_dir
  local i bots routines
  for i in $(seq 1 40); do sleep 3
    bots=$(api /api/bots 2>/dev/null | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["bots"]))' 2>/dev/null) || continue
    routines=$(api /api/routines 2>/dev/null | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["routines"]))' 2>/dev/null) || continue
    api /api/config >/dev/null 2>&1 || continue
    [ "$bots" = "$1" ] && [ "$routines" = "$2" ] || { log "health: bots=$bots/$1 routines=$routines/$2"; continue; }
    local pub; pub=$(curl -s -o /dev/null -w '%{http_code}' -m 20 https://bot.scdb.gg/) 
    local pid; pid=$(systemctl show -p MainPID --value openmausbot)
    local srv; srv=$(pgrep -a -P $pid node 2>/dev/null; pgrep -af "dist-server/index.js" | head -3)
    if [ -n "$3" ] && ! echo "$srv" | grep -qE "$3/|$B/current/"; then log "health: running server is not $3: $srv"; continue; fi
    log "health OK: bots=$bots routines=$routines public=$pub server=$(echo "$srv" | grep -o '/home/maus/[^ ]*dist-server/index.js' | head -1)"
    [ "$pub" -ge 200 ] && [ "$pub" -lt 500 ] && return 0
  done; return 1; }
counts(){ EXP_BOTS=$(api /api/bots | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["bots"]))'); EXP_ROUT=$(api /api/routines | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["routines"]))'); }
busy(){ # prints "<total busy> <non-routine busy>"
  python3 - <<'PY'
import json,urllib.request
t=open("/root/openmausbot-staging-20261025/restore-session.token").read().strip()
g=lambda p: json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8799"+p,headers={"Authorization":"Bearer "+t}),timeout=20))
rt={r.get("threadId") for r in g("/api/routines").get("runs",[]) if r.get("status") in ("running","queued")}
busy=[x for b in g("/api/bots")["bots"] for x in b.get("tasks",[]) if x.get("busy")]
print(len(busy)+sum(1 for _ in rt if _ not in {x.get("threadId") for x in busy}), sum(1 for x in busy if x.get("threadId") not in rt))
PY
}
wait_quiet(){
  local start=$(date +%s) n
  while :; do read tot human < <(busy || echo "99 99"); n=$(( ($(date +%s)-start)/60 ))
    [ "$tot" = 0 ] && { log "quiet: no turns running"; return 0; }
    if [ $n -ge $QUIET_ROUTINE_ONLY_AFTER_MIN ] && [ "$human" = 0 ]; then log "only scheduled routine turns busy ($tot) after ${n}m; restarting (watchdog/schedule re-runs them)"; return 0; fi
    [ $n -ge $QUIET_MAX_MIN ] && return 1
    status waiting_quiet 1 "waiting for running turns to finish ($tot busy, $human chat) ${n}m"; sleep 30; done; }
switch_to(){ # dir
  ln -sfn "$1" $B/current.tmp && mv -Tf $B/current.tmp $B/current; chown -h maus:maus $B/current
  if [ ! -f $DROPIN ]; then cat > $DROPIN <<EOD
# Run the Platinum-Scripts/OpenMausBot fork build (deploy branch). Remove this file + daemon-reload to go back to the npm install.
[Service]
ExecStart=
ExecStart=$NODEBIN/node /home/maus/omb-builds/current/cli.js serve --no-pair --public-url https://bot.scdb.gg
EOD
  fi
  systemctl daemon-reload; systemctl restart openmausbot; }
build(){ # -> BUILD_DIR
  local sha; sha=$(asmaus git rev-parse --short=10 HEAD)
  status building 1 "building $sha"; log "build $sha"
  asmaus "pnpm install --frozen-lockfile && pnpm build:server && pnpm exec vite build && node scripts/build-npm-package.mjs" >> $RLOG 2>&1 || return 1
  BUILD_DIR=$B/$(date -u +%Y%m%d-%H%M%S)-$sha; export BUILD_DIR
  sudo -u maus cp -a $SRC/release/npm $BUILD_DIR
  echo "$(asmaus git rev-parse HEAD) $(asmaus git describe --tags --always)" | sudo -u maus tee $BUILD_DIR/BUILD_COMMIT >/dev/null
  sudo -u maus bash -c ". /home/maus/src/build-env.sh; cd $BUILD_DIR && npm install --omit=dev --no-audit --no-fund --loglevel=error" >> $RLOG 2>&1 || return 1
  status testing 1 "testing $sha"; log "test $sha: packaged-server smoke + CLI"
  asmaus "timeout 600 node scripts/smoke-packaged-server.mjs" >> $RLOG 2>&1 || { log "smoke-packaged-server failed"; return 1; }
  sudo -u maus bash -c ". /home/maus/src/build-env.sh; cd /tmp; node --check $BUILD_DIR/dist-server/index.js && node --check $BUILD_DIR/dist-server/openmausbot.js && test -s $BUILD_DIR/dist/index.html && test -d $BUILD_DIR/node_modules/@1password/sdk" >>$RLOG 2>&1 || { log "staged bundle check failed"; return 1; }
  log "tests OK (smoke-packaged-server boots the bundle, MCP, doctor, backup, enterprise; staged CLI runs)"; return 0; }
deploy_build(){ # dir
  PREV_BUILD=$(readlink -f $B/current 2>/dev/null || echo npm); export PREV_BUILD
  counts; log "expect bots=$EXP_BOTS routines=$EXP_ROUT; prev=$PREV_BUILD"
  wait_quiet || { status deferred 1 "built $1 but turns never went quiet in ${QUIET_MAX_MIN}m; next run deploys it"; log "deferred"; exit 0; }
  status switching 1 "restarting onto $1"; switch_to "$1"
  if health $EXP_BOTS $EXP_ROUT "$1"; then return 0; fi
  log "health FAILED on $1 -> rollback to $PREV_BUILD"
  if [ "$PREV_BUILD" != npm ] && [ -d "$PREV_BUILD" ]; then switch_to "$PREV_BUILD"; health $EXP_BOTS $EXP_ROUT "$PREV_BUILD" && { fail health "new build failed health; rolled back to $PREV_BUILD (healthy)"; }; fi
  rm -f $DROPIN; systemctl daemon-reload; systemctl restart openmausbot
  health $EXP_BOTS $EXP_ROUT "" && fail health "new build failed health; rolled back to the npm install (healthy)" || fail health "ROLLBACK ALSO UNHEALTHY - service needs a human"; }
prune(){ ls -1dt $B/20*-* 2>/dev/null | tail -n +6 | while read d; do [ "$(readlink -f $B/current)" = "$d" ] || [ "$(readlink -f $B/previous 2>/dev/null)" = "$d" ] || rm -rf "$d"; done; }

case "$MODE" in
update)
  log "start update"; status fetching 1 "fetch upstream + origin"
  asmaus "git fetch -q upstream --tags && git fetch -q origin --prune" >> $RLOG 2>&1 || fail fetch "git fetch failed"
  asmaus "git checkout -q main && git merge -q --ff-only upstream/main" >> $RLOG 2>&1 || fail main-ff "fork main has diverged from upstream main (must stay a pure mirror)"
  UPSTREAM=$(asmaus git rev-parse --short=10 upstream/main); export UPSTREAM
  asmaus "git push -q origin main" >> $RLOG 2>&1 || fail push-main "push fork main failed"
  OLD_DEPLOY=$(asmaus git rev-parse origin/deploy); export OLD_DEPLOY
  asmaus "git checkout -q -B deploy origin/deploy" >> $RLOG 2>&1 || fail checkout "checkout deploy failed"
  if ! asmaus "git rebase -q main" >> $RLOG 2>&1; then
    files=$(asmaus "git diff --name-only --diff-filter=U" | tr '\n' ' '); asmaus "git rebase --abort"
    fail rebase "conflict rebasing deploy onto upstream main $UPSTREAM in: $files"; fi
  NEW_DEPLOY=$(asmaus git rev-parse HEAD); export NEW_DEPLOY
  RUNNING=$(cut -d' ' -f1 $B/current/BUILD_COMMIT 2>/dev/null)
  log "upstream=$UPSTREAM deploy ${OLD_DEPLOY:0:10} -> ${NEW_DEPLOY:0:10}; running=${RUNNING:0:10}"
  if [ "$NEW_DEPLOY" = "$RUNNING" ]; then status done 1 "no upstream changes; running ${NEW_DEPLOY:0:10} already"; log "noop"; exit 0; fi
  build || { asmaus "git checkout -q -B deploy origin/deploy"; fail build "build/test failed for ${NEW_DEPLOY:0:10} (deploy rebased on upstream $UPSTREAM); running build untouched; origin/deploy not pushed"; }
  if [ "$NEW_DEPLOY" != "$OLD_DEPLOY" ]; then asmaus "git push -q --force-with-lease=deploy:$OLD_DEPLOY origin deploy" >> $RLOG 2>&1 || fail push-deploy "push of rebased deploy rejected (someone pushed to deploy meanwhile); will retry next run"; log "pushed deploy ${NEW_DEPLOY:0:10}"; fi
  deploy_build "$BUILD_DIR" ;;
deploy-ref)
  REF=${2:?ref}; log "deploy-ref $REF"; asmaus "git fetch -q origin && git checkout -q --detach $REF" || fail checkout "bad ref $REF"
  NEW_DEPLOY=$(asmaus git rev-parse HEAD); export NEW_DEPLOY
  build || fail build "build/test failed for $REF"; deploy_build "$BUILD_DIR"; asmaus "git checkout -q deploy" ;;
rollback)
  P=$(readlink -f $B/previous); [ -d "$P" ] || fail rollback "no previous build"; counts; C=$(readlink -f $B/current)
  switch_to "$P"; ln -sfn "$C" $B/previous; health $EXP_BOTS $EXP_ROUT "$P" || fail rollback "rolled back build unhealthy"
  status done 1 "rolled back to $P"; exit 0 ;;
rollback-npm)
  counts; rm -f $DROPIN; systemctl daemon-reload; systemctl restart openmausbot; health $EXP_BOTS $EXP_ROUT "" && status done 1 "back on npm install" || fail rollback "npm unhealthy"; exit 0 ;;
health) counts; health $EXP_BOTS $EXP_ROUT "$(readlink -f $B/current)" && exit 0 || exit 1 ;;
*) echo "usage: $0 update|deploy-ref <ref>|rollback|rollback-npm|health"; exit 2 ;;
esac
[ "$PREV_BUILD" != npm ] && ln -sfn "$PREV_BUILD" $B/previous && chown -h maus:maus $B/previous
[ "$PREV_BUILD" = npm ] && ln -sfn /home/maus/.local/lib/node_modules/openmausbot $B/previous && chown -h maus:maus $B/previous
status done 1 "running $(cat $B/current/BUILD_COMMIT) (previous: $PREV_BUILD)"; log "done: running $(cat $B/current/BUILD_COMMIT)"; prune
