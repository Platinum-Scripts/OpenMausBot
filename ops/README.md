# Fork operations (Platinum-Scripts/OpenMausBot)

Branches:
- `main`: pure mirror of upstream `milind-soni/OpenMausBot` main (fast-forward only, never commit here).
- `deploy`: `main` + our commits. This is what runs on bot.scdb.gg. Merge our changes (PCC tickets etc.) here, and also PR them upstream from a topic branch based on `main`.
- `ops/hotfixes`: the server-side ops scripts below (already merged into `deploy`).

Daily (4:00 AM ET, OpenMausBot routine "OMB fork daily rebase + deploy" on Factory Ops):
`touch /home/maus/omb-builds/update-request` triggers `omb-fork-update.service` (root) which runs
`/opt/omb-ops/omb-fork-update.sh update`: fetch upstream, ff `main`, rebase `deploy` onto it, build
(`pnpm build:server && vite build && build-npm-package`), test (`smoke-packaged-server`), push `deploy`
(--force-with-lease), wait for running turns to finish, switch `/home/maus/omb-builds/current`, restart,
health check, automatic rollback. Conflict/build failure: running build untouched + PCC ticket.

Status: `/home/maus/omb-builds/last-update.json`, `/home/maus/omb-builds/last-update.log`, `/var/log/omb-fork-update.log`.

Install `server/fork/omb-pcc-ticket.py` alongside `/opt/omb-ops/omb-fork-update.sh` when updating the ops scripts. The helper sends JSON on SSH stdin, not interpolated shell arguments, and accepts only a successful `PCC-<number>` receipt. `ticket_state=unconfirmed` means transport or creation failed or was ambiguous; reconcile the `omb-fork-update-YYYY-MM-DD` dedupe key in PCC before retrying. A ticket failure never overwrites the pipeline's failed stage or claims success. Raw build logs remain server-local.

Rollback: `/opt/omb-ops/omb-fork-update.sh rollback` (previous build) or `rollback-npm`
(remove `/etc/systemd/system/openmausbot.service.d/30-fork.conf`, run the npm install again).
