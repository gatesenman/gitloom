#!/usr/bin/env bash
# Complex multi-repo fixture for GitLoom: ≥25 repos nested at depths 1-6, submodules (nested + uninitialized),
# worktrees inside/outside the project, a bare repo, ignored node_modules repo, symlink loop, ahead/behind,
# conflict, detached HEAD, gitlink and ignored nested repos.
# usage: make-complex-fixture.sh <ROOT>   (project folder = <ROOT>/mono)
set -euo pipefail
ROOT=${1:-/tmp/gitloom-complex}
rm -rf "$ROOT"; mkdir -p "$ROOT/remotes" "$ROOT/outside"
export GIT_AUTHOR_NAME="Lin Wei" GIT_AUTHOR_EMAIL=linwei@example.com GIT_COMMITTER_NAME="Lin Wei" GIT_COMMITTER_EMAIL=linwei@example.com
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
G() { git -c init.defaultBranch=main -c protocol.file.allow=always -c advice.detachedHead=false "$@"; }
mk() { # mk <dir> [files...] : init repo with a couple of commits
  local d=$1; shift; mkdir -p "$d"; G -C "$d" init -q
  echo "# $(basename "$d")" > "$d/README.md"; G -C "$d" add -A; G -C "$d" commit -qm "chore: init $(basename "$d")"
  for f in "$@"; do mkdir -p "$(dirname "$d/$f")"; echo "export const v = 1" > "$d/$f"; done
  if [ $# -gt 0 ]; then G -C "$d" add -A; G -C "$d" commit -qm "feat: scaffold $(basename "$d")"; fi
}
bare_from() { G clone -q --bare "$1" "$2"; G -C "$1" remote add origin "$2"; G -C "$1" fetch -q origin; G -C "$1" branch -q -u origin/main main; }

P=$ROOT/mono
mk "$P" package.json
printf 'node_modules/\nservices/\ntools/local/\n' > "$P/.gitignore"; G -C "$P" add .gitignore; G -C "$P" commit -qm "chore: ignore rules"

# apps (untracked by the monorepo root)
mk "$P/apps/web" src/main.ts src/App.tsx
bare_from "$P/apps/web" "$ROOT/remotes/web.git"
echo "export const feature = 'a'" > "$P/apps/web/src/a.ts"; G -C "$P/apps/web" add -A; G -C "$P/apps/web" commit -qm "feat(web): a"
echo "export const feature = 'b'" > "$P/apps/web/src/b.ts"; G -C "$P/apps/web" add -A; G -C "$P/apps/web" commit -qm "feat(web): b"   # ahead 2
mk "$P/apps/api" src/server.go
bare_from "$P/apps/api" "$ROOT/remotes/api.git"
G clone -q "$ROOT/remotes/api.git" "$ROOT/outside/api-other"
echo "// upstream" >> "$ROOT/outside/api-other/src/server.go"; G -C "$ROOT/outside/api-other" commit -qam "fix(api): upstream change"; G -C "$ROOT/outside/api-other" push -q origin main
G -C "$P/apps/api" fetch -q origin                                     # behind 1
rm -rf "$ROOT/outside/api-other"
mk "$P/apps/admin" src/index.ts
mk "$P/apps/docs-portal" docs/index.md
mk "$P/apps/mobile/ios/native" Sources/App.swift                       # depth 4

# libs
mk "$P/libs/core" src/index.ts
mk "$P/libs/utils" src/str.ts
mk "$P/libs/ui/components" src/Button.tsx                              # conflict state
G -C "$P/libs/ui/components" checkout -qb feature/color
echo "export const color = 'green'" > "$P/libs/ui/components/src/theme.ts"; G -C "$P/libs/ui/components" add -A; G -C "$P/libs/ui/components" commit -qm "feat: green"
G -C "$P/libs/ui/components" checkout -q main
echo "export const color = 'purple'" > "$P/libs/ui/components/src/theme.ts"; G -C "$P/libs/ui/components" add -A; G -C "$P/libs/ui/components" commit -qm "feat: purple"
G -C "$P/libs/ui/components" merge -q feature/color >/dev/null 2>&1 || true
mk "$P/libs/a/b/c/d" lib.rs                                            # depth 5

# services (ignored by the root repo)
mk "$P/services/auth" main.py
G -C "$P/services/auth" checkout -q --detach HEAD~1                   # detached HEAD
mk "$P/services/billing" main.py
echo "# wip" >> "$P/services/billing/main.py"; echo "tmp" > "$P/services/billing/notes.txt"   # dirty
mk "$P/services/gateway" main.go
mk "$P/services/notify" main.go

# packages
mk "$P/packages/cli" bin/cli.js
mk "$P/packages/sdk/js" index.js
mk "$P/packages/sdk/python" sdk/__init__.py
mk "$P/docs/site" index.md
mk "$P/experiments/2024/q3/ml/model" train.py                          # depth 5

# nested repo inside an ignored folder of the root + a gitlink (embedded repo added without .gitmodules)
mk "$P/tools/local/scratch" notes.md
mk "$P/third_party/zlib" zlib.h
G -C "$P" add third_party/zlib 2>/dev/null; G -C "$P" commit -qm "chore: embed zlib (gitlink)"

# submodules: shared (with nested submodule deep) + one declared but uninitialized
mk "$ROOT/src-deep" deep.txt;  G clone -q --bare "$ROOT/src-deep" "$ROOT/remotes/deep.git"
mk "$ROOT/src-shared" shared.txt
G -C "$ROOT/src-shared" submodule add -q "$ROOT/remotes/deep.git" vendor/deep; G -C "$ROOT/src-shared" commit -qm "chore: add deep submodule"
G clone -q --bare "$ROOT/src-shared" "$ROOT/remotes/shared.git"
mk "$ROOT/src-extra" extra.txt; G clone -q --bare "$ROOT/src-extra" "$ROOT/remotes/extra.git"
rm -rf "$ROOT/src-deep" "$ROOT/src-shared" "$ROOT/src-extra"
G -C "$P" submodule add -q "$ROOT/remotes/shared.git" modules/shared
G -C "$P" submodule add -q "$ROOT/remotes/extra.git" modules/extra
G -C "$P" commit -qm "chore: add submodules"
G -C "$P" submodule update -q --init --recursive -- modules/shared
G -C "$P" submodule deinit -q -f modules/extra                         # uninitialized (declared in .gitmodules)
echo "dirty" >> "$P/modules/shared/shared.txt"                          # dirty submodule

# worktrees: one inside the project, one outside
G -C "$P/apps/web" worktree add -q -b feature/inside "$P/worktrees/web-inside"
G -C "$P/apps/web" worktree add -q -b hotfix/outside "$ROOT/outside/web-hotfix"

# bare repository inside the project
G clone -q --bare "$P/libs/core" "$P/infra/mirror.git"

# ignored node_modules containing a repo (must be skipped) + symlink loop + symlink to an already-seen repo
mk "$P/node_modules/left-pad" index.js
ln -s .. "$P/libs/loop"
mkdir -p "$P/links"; ln -s ../libs/core "$P/links/core-link"
echo "fixture ready: $P"
