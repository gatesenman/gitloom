import type { HookTemplate } from '../../shared/types'

export const STANDARD_HOOKS = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
  'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit',
  'post-index-change'
]

/** Hooks most relevant for client-side work, shown first in the UI. */
export const COMMON_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-push',
  'post-checkout', 'post-merge', 'pre-rebase', 'post-rewrite']

const LLMWIKI = `#!/bin/sh
# ---------------------------------------------------------------------------
# GitLoom hook template: llmwiki (post-commit)
# Keeps an LLM-friendly project wiki up to date after every commit:
#   <dir>/index.md      project overview, structure, languages, hot files, recent commits
#   <dir>/changelog.md  one entry per commit (newest first), optional AI summary
# Settings (all optional):
#   git config llmwiki.dir docs/llmwiki     output directory (default docs/llmwiki)
#   git config llmwiki.ai true|false        enable AI summary (default: true when a key is present)
#   git config llmwiki.baseUrl / llmwiki.model   OpenAI-compatible endpoint + model
#   env LLMWIKI_BASE_URL / LLMWIKI_API_KEY / LLMWIKI_MODEL  (GitLoom injects these when
#       "向钩子注入 AI 配置" is enabled; the API key is never written to disk by GitLoom)
#   env LLMWIKI_SKIP=1   skip once;  env LLMWIKI_SYNC=1   run the AI step synchronously
# The hook never commits by itself (no recursion). Commit the wiki whenever you like.
# ---------------------------------------------------------------------------
[ -n "$LLMWIKI_SKIP" ] && exit 0
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$ROOT" || exit 0
DIR=$(git config --get llmwiki.dir 2>/dev/null)
[ -z "$DIR" ] && DIR="docs/llmwiki"
mkdir -p "$DIR" || exit 0
NAME=$(basename "$ROOT")
SHA=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
NOW=$(date '+%Y-%m-%d %H:%M:%S')
FILES_TMP="$DIR/.files.tmp"
git ls-files | grep -v "^$DIR/" > "$FILES_TMP"
TOTAL=$(wc -l < "$FILES_TMP" | tr -d ' ')

{
  echo "# $NAME · LLM Wiki"
  echo
  echo "> 自动生成：$NOW · 分支 \\\`$BRANCH\\\` @ \\\`$SHA\\\` · 由 GitLoom llmwiki 钩子维护，请勿手工编辑。"
  echo
  echo "## 项目概览"
  echo
  README=""
  for f in README.md README.MD readme.md README README.txt; do [ -f "$f" ] && README="$f" && break; done
  if [ -n "$README" ]; then
    echo "以下摘录自 \\\`$README\\\`："
    echo
    sed -n '1,30p' "$README" | sed 's/^/> /'
  else
    echo "_仓库中没有 README。_"
  fi
  echo
  echo "## 基本信息"
  echo
  echo "- 跟踪文件数：$TOTAL"
  echo "- 提交总数：$(git rev-list --count HEAD 2>/dev/null)"
  echo "- 贡献者：$(git shortlog -sn HEAD 2>/dev/null | wc -l | tr -d ' ')"
  echo "- 远程：$(git remote -v 2>/dev/null | awk '/fetch/{print $1" "$2}' | tr '\\n' ';')"
  echo
  echo "## 目录结构（前两层）"
  echo
  echo '\`\`\`'
  awk -F/ '{ if (NF==1) print $1; else if (NF==2) print $1"/"$2; else print $1"/"$2"/…" }' "$FILES_TMP" | sort -u | head -n 150
  echo '\`\`\`'
  echo
  echo "## 文件类型统计"
  echo
  echo "| 扩展名 | 文件数 |"
  echo "|---|---|"
  sed -n 's/.*\\.\\([A-Za-z0-9_]*\\)$/\\1/p' "$FILES_TMP" | sort | uniq -c | sort -rn | head -n 15 | awk '{print "| ."$2" | "$1" |"}'
  echo
  echo "## 热点文件（最近 100 次提交中修改最多）"
  echo
  git log -n 100 --name-only --format= 2>/dev/null | grep -v '^$' | grep -v "^$DIR/" | sort | uniq -c | sort -rn | head -n 15 | awk '{print "- \`"$2"\` ("$1" 次)"}'
  echo
  echo "## 最近提交"
  echo
  git log -n 20 --date=short --format='- \`%h\` %ad %an：%s' 2>/dev/null
  echo
  echo "## 变更日志"
  echo
  echo "详见 [changelog.md](changelog.md)。"
} > "$DIR/index.md"
rm -f "$FILES_TMP"

# ---- changelog entry -------------------------------------------------------
ENTRY="$DIR/.entry.tmp"
{
  echo "## \\\`$SHA\\\` $(git log -1 --format='%s')"
  echo
  echo "- 作者：$(git log -1 --format='%an') · 时间：$(git log -1 --date=iso --format='%ad') · 分支：\\\`$BRANCH\\\`"
  echo
  echo '\`\`\`'
  git show --stat --format= HEAD 2>/dev/null | tail -n 25
  echo '\`\`\`'
  echo
} > "$ENTRY"
CL="$DIR/changelog.md"
[ -f "$CL" ] || printf '# 变更日志（llmwiki）\\n\\n' > "$CL"
{ sed -n '1,2p' "$CL"; cat "$ENTRY"; sed '1,2d' "$CL"; } > "$CL.tmp" && mv "$CL.tmp" "$CL"
rm -f "$ENTRY"

# ---- optional AI summary --------------------------------------------------
BASE=\${LLMWIKI_BASE_URL:-$(git config --get llmwiki.baseUrl 2>/dev/null)}
MODEL=\${LLMWIKI_MODEL:-$(git config --get llmwiki.model 2>/dev/null)}
KEY=\${LLMWIKI_API_KEY:-}
AI=$(git config --get llmwiki.ai 2>/dev/null)
[ -z "$BASE" ] && exit 0
[ "$AI" = "false" ] && exit 0
command -v node >/dev/null 2>&1 || exit 0
export BASE MODEL KEY SHA CL
ai_step() {
  git show HEAD --format='%s%n%n%b' --stat -p 2>/dev/null | head -c 14000 | node -e '
const chunks=[];process.stdin.on("data",c=>chunks.push(c)).on("end",async()=>{
  const diff=Buffer.concat(chunks).toString("utf8");
  const url=process.env.BASE.replace(/\\/+$/,"")+"/chat/completions";
  const headers={"content-type":"application/json"};
  if(process.env.KEY) headers.authorization="Bearer "+process.env.KEY;
  try{
    const ctl=new AbortController();setTimeout(()=>ctl.abort(),60000).unref();
    const r=await fetch(url,{method:"POST",headers,signal:ctl.signal,body:JSON.stringify({
      model:process.env.MODEL||"gpt-4o-mini",temperature:0.2,messages:[
        {role:"system",content:"你是项目文档维护者。用简体中文，用 3-6 条要点总结这次提交做了什么、为什么、影响哪些模块，面向之后阅读代码库的 LLM 与开发者。只输出 Markdown 要点。"},
        {role:"user",content:diff}]})});
    const j=await r.json();const t=j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content;
    if(!t) return;
    const fs=require("fs");const cl=process.env.CL;let s=fs.readFileSync(cl,"utf8");
    const marker="## \`"+process.env.SHA+"\`";const i=s.indexOf(marker);if(i<0)return;
    const j2=s.indexOf("\\n",i);const block="\\n\\n**AI 摘要**\\n\\n"+t.trim()+"\\n";
    s=s.slice(0,j2)+block+s.slice(j2);fs.writeFileSync(cl,s);
  }catch(e){}
});'
}
if [ -n "$LLMWIKI_SYNC" ]; then ai_step; else (ai_step >/dev/null 2>&1 &); fi
exit 0
`

const CONVENTIONAL = `#!/bin/sh
# GitLoom hook template: enforce Conventional Commits (commit-msg)
MSG_FILE="$1"
FIRST=$(head -n1 "$MSG_FILE")
case "$FIRST" in
  Merge*|Revert*|fixup!*|squash!*|amend!*) exit 0 ;;
esac
if ! echo "$FIRST" | grep -Eq '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\([^)]+\\))?!?: .+'; then
  echo "✖ 提交信息不符合 Conventional Commits 规范：" >&2
  echo "    $FIRST" >&2
  echo "  示例：feat(ui): 新增分支图视图" >&2
  exit 1
fi
`

const PRECOMMIT_CHECK = `#!/bin/sh
# GitLoom hook template: basic pre-commit checks
# - reject conflict markers, whitespace errors and files larger than 5 MB
git diff --cached --check || { echo "✖ 存在空白错误或冲突标记" >&2; exit 1; }
LIMIT=\${GITLOOM_MAX_FILE_BYTES:-5242880}
BIG=$(git diff --cached --name-only --diff-filter=AM | while IFS= read -r f; do
  [ -f "$f" ] || continue
  s=$(wc -c < "$f" | tr -d ' ')
  [ "$s" -gt "$LIMIT" ] && echo "$f ($s 字节)"
done)
if [ -n "$BIG" ]; then echo "✖ 文件过大，考虑使用 Git LFS：" >&2; echo "$BIG" >&2; exit 1; fi
`

const PREPUSH_TEST = `#!/bin/sh
# GitLoom hook template: run tests before push (pre-push)
if [ -f package.json ] && grep -q '"test"' package.json; then
  echo "▶ npm test"; npm test --silent || { echo "✖ 测试失败，已阻止推送" >&2; exit 1; }
elif [ -f Cargo.toml ]; then cargo test --quiet || exit 1
elif [ -f go.mod ]; then go test ./... || exit 1
elif [ -f pytest.ini ] || [ -f pyproject.toml ]; then python -m pytest -q || exit 1
fi
`

const BRANCH_PREFIX = `#!/bin/sh
# GitLoom hook template: prefix commit message with ticket id from branch name (prepare-commit-msg)
# feature/ABC-123-login  ->  "ABC-123: <message>"
MSG_FILE="$1"; SOURCE="$2"
[ -n "$SOURCE" ] && [ "$SOURCE" != "message" ] && exit 0
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
TICKET=$(echo "$BRANCH" | grep -Eo '[A-Z][A-Z0-9]+-[0-9]+' | head -n1)
[ -z "$TICKET" ] && exit 0
grep -q "^$TICKET" "$MSG_FILE" && exit 0
sed -i.bak "1s/^/$TICKET: /" "$MSG_FILE" && rm -f "$MSG_FILE.bak"
`

const POST_CHECKOUT_DEPS = `#!/bin/sh
# GitLoom hook template: remind to reinstall deps when lockfiles change (post-checkout / post-merge)
PREV="$1"; NEW="$2"
[ -z "$NEW" ] && NEW=HEAD && PREV=ORIG_HEAD
CHANGED=$(git diff --name-only "$PREV" "$NEW" 2>/dev/null)
echo "$CHANGED" | grep -Eq '(package-lock.json|pnpm-lock.yaml|yarn.lock|Cargo.lock|go.sum|poetry.lock)' && \\
  echo "ℹ 依赖锁文件已变化，记得重新安装依赖。"
exit 0
`

export const HOOK_TEMPLATES: HookTemplate[] = [
  { id: 'llmwiki', name: 'llmwiki：自动维护 LLM 项目百科', hook: 'post-commit',
    description: '每次提交后生成/更新 docs/llmwiki/index.md（项目概览、目录结构、热点文件、最近提交）与 changelog.md；配置 AI 后自动追加本次提交的 AI 摘要。', content: LLMWIKI },
  { id: 'conventional', name: '约定式提交校验', hook: 'commit-msg',
    description: '要求提交信息符合 Conventional Commits（feat/fix/docs…）。', content: CONVENTIONAL },
  { id: 'precommit-check', name: '提交前基础检查', hook: 'pre-commit',
    description: '拦截冲突标记、空白错误与超过 5MB 的大文件（提示使用 LFS）。', content: PRECOMMIT_CHECK },
  { id: 'prepush-test', name: '推送前运行测试', hook: 'pre-push',
    description: '自动识别 npm / cargo / go / pytest 并在推送前运行测试。', content: PREPUSH_TEST },
  { id: 'branch-ticket', name: '分支工单号前缀', hook: 'prepare-commit-msg',
    description: '从分支名提取 ABC-123 形式的工单号并加到提交信息前。', content: BRANCH_PREFIX },
  { id: 'deps-reminder', name: '依赖变化提醒', hook: 'post-checkout',
    description: '切换分支后若锁文件变化，提醒重新安装依赖。', content: POST_CHECKOUT_DEPS }
]
