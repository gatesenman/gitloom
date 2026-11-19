#!/usr/bin/env bash
# Large-project fixture modelled on a real "EVER-BUDDY" workspace: ~24 repos (18 service/module repos with bare
# remotes, .kilo/worktrees/* and worktree/* linked worktrees), mixed ahead / behind / diverged / dirty / staged /
# no-upstream / detached / unreachable-remote states and long, similar-looking repo names.
# usage: make-bigproject-fixture.sh <ROOT>   (project folder = <ROOT>/EVER-BUDDY)
set -euo pipefail
ROOT=${1:-/tmp/gitloom-big}
rm -rf "$ROOT"; mkdir -p "$ROOT/remotes" "$ROOT/upstream"
export GIT_AUTHOR_NAME="Lin Wei" GIT_AUTHOR_EMAIL=linwei@example.com GIT_COMMITTER_NAME="Lin Wei" GIT_COMMITTER_EMAIL=linwei@example.com
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
G() { git -c init.defaultBranch=main -c advice.detachedHead=false "$@"; }
P=$ROOT/EVER-BUDDY
mkdir -p "$P"
n=0
mk() { # mk <name> <nfiles>
  local d=$P/$1; mkdir -p "$d/src"; G -C "$d" init -q
  printf '# %s\n\n%s 服务\n' "$1" "$1" > "$d/README.md"
  for i in $(seq 1 "$2"); do printf 'export const item%s = { id: %s, name: "%s-%s" }\n' "$i" "$i" "$1" "$i" > "$d/src/m$i.ts"; done
  printf '{ "name": "%s", "version": "1.0.0" }\n' "$1" > "$d/package.json"
  G -C "$d" add -A; G -C "$d" commit -qm "chore: init $1"
  echo "export const ready = true" >> "$d/src/m1.ts"; G -C "$d" commit -qam "feat: $1 ready"
  G clone -q --bare "$d" "$ROOT/remotes/$1.git"; G -C "$d" remote add origin "$ROOT/remotes/$1.git"; G -C "$d" fetch -q origin; G -C "$d" branch -q -u origin/main main
  n=$((n+1))
}
ahead() { local d=$P/$1; for i in $(seq 1 "$2"); do echo "// local change $i" >> "$d/src/m1.ts"; G -C "$d" commit -qam "feat($1): 本地改动 $i"; done; }
behind() { # behind <name> <n>: commits pushed by "a colleague", then fetched
  local u=$ROOT/upstream/$1; rm -rf "$u"; G clone -q "$ROOT/remotes/$1.git" "$u"
  for i in $(seq 1 "$2"); do echo "// upstream $i" >> "$u/README.md"; G -C "$u" commit -qam "fix($1): 同事的提交 $i"; done
  G -C "$u" push -q origin main; rm -rf "$u"; G -C "$P/$1" fetch -q origin
}
dirty() { local d=$P/$1; echo "// wip" >> "$d/src/m2.ts"; echo "new" > "$d/src/new-file.ts"; }

mk everbuddy-applications 40;           ahead everbuddy-applications 1; dirty everbuddy-applications
mk everbuddy-governance 20;             ahead everbuddy-governance 2
mk everbuddy-module-automation 30;      ahead everbuddy-module-automation 5
mk everbuddy-contracts 25
mk everbuddy-module-actor 15
mk everbuddy-module-authorization-gateway-service 20; ahead everbuddy-module-authorization-gateway-service 2
mk everbuddy-module-authorization-gateway-client 12;  behind everbuddy-module-authorization-gateway-client 3
mk everbuddy-module-environment 10;     ahead everbuddy-module-environment 1
mk everbuddy-module-execution 30;       behind everbuddy-module-execution 12
mk everbuddy-module-resource 25;        ahead everbuddy-module-resource 7
mk everbuddy-module-test-a 8
mk everbuddy-module-test-b 8;           behind everbuddy-module-test-b 2
mk everbuddy-module-work 20
mk everbuddy-module-workflow 20;        ahead everbuddy-module-workflow 2
mk everbuddy-platform 50;               ahead everbuddy-platform 1; behind everbuddy-platform 2   # diverged → ff-only pull fails
mk everbuddy-rd-docs 10;                ahead everbuddy-rd-docs 2
mk everbuddy-gateway 15;                behind everbuddy-gateway 1
G -C "$P/everbuddy-gateway" remote set-url origin "https://127.0.0.1:9/everbuddy/gateway.git"        # unreachable remote
mk everbuddy-notify 10;                 G -C "$P/everbuddy-notify" checkout -qb feature/sms; ahead everbuddy-notify 1   # no upstream
G -C "$P/everbuddy-contracts" checkout -q HEAD~1                                                      # detached HEAD
echo "staged" > "$P/everbuddy-module-actor/src/staged.ts"; G -C "$P/everbuddy-module-actor" add -A
dirty everbuddy-module-workflow
# linked worktrees in the workspace (as AI coding tools create them)
mkdir -p "$P/.kilo/worktrees" "$P/worktree"
for w in crane sturgeon swan tiger; do G -C "$P/everbuddy-applications" worktree add -q -b "kilo/$w" "$P/.kilo/worktrees/$w"; done
echo "// tiger wip" >> "$P/.kilo/worktrees/tiger/src/m3.ts"
for w in feat-login feat-billing; do G -C "$P/everbuddy-module-work" worktree add -q -b "$w" "$P/worktree/$w"; done
# noise the scanner must skip quickly
mkdir -p "$P/node_modules/pkg/.git" "$P/everbuddy-platform/node_modules/x"
for i in $(seq 1 300); do mkdir -p "$P/everbuddy-platform/node_modules/x/d$i"; done
echo "$n repos with remotes + 6 worktrees under $P"
