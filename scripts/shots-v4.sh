#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
bash scripts/make-complex-fixture.sh /tmp/gitloom-complex >/dev/null 2>&1 || true
F=/tmp/gitloom-complex/mono
# also ensure a simple repo with history for blame/rebase shots
R=/tmp/gitloom-v4-repo
rm -rf "$R"; mkdir -p "$R"
( cd "$R" && git init -b main && git config user.email e@e.com && git config user.name E \
  && echo one > a.txt && git add a.txt && git commit -m c1 \
  && echo two >> a.txt && git add a.txt && git commit -m c2 \
  && echo three >> a.txt && git add a.txt && git commit -m c3 \
  && git checkout -b feature && echo feat > b.txt && git add b.txt && git commit -m feat1 \
  && echo feat2 >> b.txt && git add b.txt && git commit -m feat2 && git checkout main )
OUT=$PWD/screenshots/v4
mkdata() { rm -rf "$1"; mkdir -p "$1"; cat > "$1/gitloom.json" <<EOF
{"settings":{"theme":"dark","ai":{"baseUrl":"http://127.0.0.1:9/v1","apiKey":"","model":"demo","temperature":0.2,"language":"zh","commitStyle":"conventional"},"diffMode":"split","graphLimit":800,"autoFetchMinutes":0,"gitPath":"git","scanDepth":6,"aiEnvForHooks":false,"fontSize":13,"density":"comfortable","concurrency":6,"forge":{"githubToken":"","gitlabToken":"","gitlabBaseUrl":"https://gitlab.com"}},
 "workspace":{"repos":[],"active":null,"projects":$2,"activeProject":"p-mono","pinned":[],"recent":[]}}
EOF
}
run() { GITLOOM_NO_WATCH=1 GITLOOM_AUTOSHOT=$OUT GITLOOM_AUTOSHOT_WAIT=2800 GITLOOM_AUTOSHOT_SIZE=1440x900 timeout 900 xvfb-run -a -s "-screen 0 1600x1000x24" npx electron . --no-sandbox --disable-gpu >/dev/null 2>&1 || true; }
rm -rf "$OUT"; mkdir -p "$OUT"
mkdata /tmp/glc-v4 '[{"id":"p-mono","name":"mono","root":"'$F'","repos":[],"hidden":[]},{"id":"p-adv","name":"adv","root":"'$R'","repos":[],"hidden":[]}]'
GITLOOM_DATA_DIR=/tmp/glc-v4 GITLOOM_AUTOSHOT_DELAY=7000 GITLOOM_AUTOSHOT_STEPS="\
01-rebase=rebase@$R,\
02-bisect=bisect@$R,\
03-tools-blame=tools@$R,\
04-submodules=submodules@$F,\
05-forge=forge@$F/apps/web,\
06-ai-chat=ai@$R,\
07-dashboard=dashboard,\
08-cross-changes=allchanges,\
09-light-tools=tools:light@$R,\
10-command-palette~2000=palette" run
ls "$OUT"
