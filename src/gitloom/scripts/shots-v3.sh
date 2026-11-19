#!/usr/bin/env bash
# Reproduce screenshots/v3 (multi-repo round) against the complex fixture.
set -e
cd "$(dirname "$0")/.."
bash scripts/make-complex-fixture.sh /tmp/gitloom-complex >/dev/null 2>&1
F=/tmp/gitloom-complex/mono
OUT=$PWD/screenshots/v3
mkdata() { rm -rf "$1"; mkdir -p "$1"; cat > "$1/gitloom.json" <<EOF
{"settings":{"theme":"dark","ai":{"baseUrl":"http://127.0.0.1:9/v1","apiKey":"","model":"","temperature":0.2,"language":"zh","commitStyle":"conventional"},"diffMode":"split","graphLimit":800,"autoFetchMinutes":0,"gitPath":"git","scanDepth":6,"aiEnvForHooks":true,"fontSize":13,"density":"comfortable","concurrency":6},
 "workspace":{"repos":[],"active":null,"projects":$2,"activeProject":"p-mono","pinned":$3,"recent":[]}}
EOF
}
run() { GITLOOM_NO_WATCH=1 GITLOOM_AUTOSHOT=$OUT GITLOOM_AUTOSHOT_WAIT=3000 GITLOOM_AUTOSHOT_SIZE=1440x900 timeout 900 xvfb-run -a -s "-screen 0 1600x1000x24" npx electron . --no-sandbox --disable-gpu >/dev/null 2>&1 || true; }
rm -rf "$OUT"; mkdir -p "$OUT"
mkdata /tmp/glc-data '[{"id":"p-mono","name":"mono","root":"'$F'","repos":[],"hidden":[]},{"id":"p-e2e","name":"gitloom-e2e","root":"/tmp/gitloom-e2e/workspace","repos":[],"hidden":[]}]' '["'$F'/apps/web","'$F'/libs/ui/components"]'
GITLOOM_DATA_DIR=/tmp/glc-data GITLOOM_AUTOSHOT_DELAY=6000 GITLOOM_AUTOSHOT_STEPS="01-tree-sidebar-expanded=changes@$F/services/billing,03-grouped-by-status=mode-status,04-flat-list~1500=mode-flat,05-tree-filter~1500=mode-tree::comp,02-breadcrumb-deep-repo~1500=filter,02-breadcrumb-deep-repo=graph@$F/apps/mobile/ios/native,06-dashboard-project=dashboard,07-dashboard-bulk-progress~2300=dashboard:::bulk-fetch-slow,08-dashboard-bulk-results~6000=dashboard,09-dashboard-folder-scope=dashboard::$F/libs,10-cross-repo-changes=allchanges,11-quick-open~2000=quickopen::sdk,12-command-palette~2000=palette,13-light-tree-changes=changes:light@$F/services/billing,14-light-dashboard=dashboard:light,15-compact-density=changes:dark:::compact@$F/apps/web,16-compact-dashboard=dashboard:dark:::compact" run
# onboarding: empty profile → welcome → slowed scan of the fixture
mkdata /tmp/glc-onb '[]' '[]'
GITLOOM_DATA_DIR=/tmp/glc-onb GITLOOM_SCAN_SLOWMO=60 GITLOOM_AUTOSHOT_DELAY=4000 GITLOOM_AUTOSHOT_STEPS="17-onboarding-welcome~1500=settings,17-onboarding-welcome~1500=dashboard,18-onboarding-scan~2500=scan::$F,19-onboarding-tree~9000=dashboard" run
ls "$OUT"
