#!/usr/bin/env bash
# Create sample repositories for manual testing / screenshots (branches, merges, tags, remote,
# worktree, stash, staged + unstaged changes, an in-progress merge conflict, llmwiki hook).
set -euo pipefail
ROOT=${1:-/tmp/gitloom-demo}
HOOK_SRC=${2:-}
[ -n "$HOOK_SRC" ] && HOOK_SRC=$(cd "$(dirname "$HOOK_SRC")" && pwd)/$(basename "$HOOK_SRC")
rm -rf "$ROOT"; mkdir -p "$ROOT"
export GIT_AUTHOR_NAME="Lin Wei" GIT_AUTHOR_EMAIL="linwei@example.com" GIT_COMMITTER_NAME="Lin Wei" GIT_COMMITTER_EMAIL="linwei@example.com"
d=1760000000
c() { d=$((d+5400)); GIT_AUTHOR_DATE="@$d +0800" GIT_COMMITTER_DATE="@$d +0800" git commit -q "$@"; }
as() { export GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$2"; }

# ---- webapp (main demo)
git init -q --bare -b main "$ROOT/remotes/webapp.git"
W="$ROOT/workspace/webapp"; mkdir -p "$W"; cd "$W"
git init -q -b main; git config user.name "Lin Wei"; git config user.email linwei@example.com; git config commit.gpgsign false
mkdir -p src/components src/pages
cat > README.md <<'R'
# WebApp

一个用于演示 GitLoom 的前端项目：React + TypeScript。

## 功能
- 登录 / 注册
- 暗色模式
R
cat > package.json <<'R'
{ "name": "webapp", "version": "1.0.0", "scripts": { "dev": "vite", "test": "vitest" } }
R
cat > src/App.tsx <<'R'
import { Header } from './components/Header'

export default function App() {
  return (
    <main>
      <Header title="WebApp" />
      <p>Hello world</p>
    </main>
  )
}
R
cat > src/components/Header.tsx <<'R'
export function Header({ title }: { title: string }) {
  return <header className="header">{title}</header>
}
R
git add -A; c -m "chore: 初始化项目结构"
git remote add origin "$ROOT/remotes/webapp.git"
cat >> src/components/Header.tsx <<'R'

export function SubHeader({ text }: { text: string }) {
  return <h2 className="sub">{text}</h2>
}
R
git add -A; c -m "feat(header): 新增 SubHeader 组件"
git tag -a v0.1.0 -m "第一个版本"
git push -q -u origin main
as "Zhang San" zhangsan@example.com
git checkout -q -b feature/login
cat > src/pages/Login.tsx <<'R'
import { useState } from 'react'

export function Login() {
  const [user, setUser] = useState('')
  return <form><input value={user} onChange={(e) => setUser(e.target.value)} /></form>
}
R
git add -A; c -m "feat(login): 登录页面骨架"
echo "export const validate = (u: string) => u.length > 2" > src/pages/validate.ts
git add -A; c -m "feat(login): 用户名校验"
git checkout -q main
as "Lin Wei" linwei@example.com
sed -i 's/Hello world/欢迎使用 WebApp/' src/App.tsx
git add -A; c -m "fix(app): 本地化欢迎语"
git merge -q --no-ff feature/login -m "Merge branch 'feature/login'"
as "Li Si" lisi@example.com
git checkout -q -b feature/dark-mode
cat > src/theme.ts <<'R'
export type Theme = 'light' | 'dark'
export const defaultTheme: Theme = 'dark'
R
git add -A; c -m "feat(theme): 暗色模式基础"
echo "export const toggle = (t: Theme): Theme => (t === 'dark' ? 'light' : 'dark')" >> src/theme.ts
git add -A; c -m "feat(theme): 主题切换函数"
git checkout -q main
as "Lin Wei" linwei@example.com
git checkout -q -b fix/header-style
sed -i 's/className="header"/className="header sticky"/' src/components/Header.tsx
git add -A; c -m "fix(header): 头部吸顶"
git checkout -q main
echo "- 多语言" >> README.md
git add -A; c -m "docs: 更新功能列表"
git merge -q --no-ff fix/header-style -m "Merge branch 'fix/header-style'"
git tag v0.2.0
git push -q origin main feature/dark-mode
git checkout -q -b release/1.0
echo '{ "name": "webapp", "version": "1.0.0-rc.1", "scripts": { "dev": "vite", "test": "vitest" } }' > package.json
git add -A; c -m "chore(release): 1.0.0-rc.1"
git checkout -q main
# worktree for dark-mode branch
git worktree add -q "$ROOT/workspace/webapp-dark-mode" feature/dark-mode
# stash
echo "// TODO: 记住用户名" >> src/pages/Login.tsx
git stash push -q -m "WIP: 记住用户名"
# hooks: llmwiki
if [ -n "$HOOK_SRC" ] && [ -f "$HOOK_SRC" ]; then cp "$HOOK_SRC" .git/hooks/post-commit; chmod +x .git/hooks/post-commit; fi
# working changes: staged + unstaged + untracked
cat > src/App.tsx <<'R'
import { Header, SubHeader } from './components/Header'
import { Login } from './pages/Login'

export default function App() {
  const user = null
  return (
    <main className="app">
      <Header title="WebApp" />
      <SubHeader text="一个演示项目" />
      {user ? <p>欢迎回来</p> : <Login />}
    </main>
  )
}
R
git add src/App.tsx
cat > src/theme.ts <<'R'
export type Theme = 'light' | 'dark' | 'system'
R
sed -i 's/useState(\x27\x27)/useState<string>(\x27\x27)/' src/pages/Login.tsx
sed -i 's/return <form>/  const [remember, setRemember] = useState(false)\n  return <form data-remember={remember}>/' src/pages/Login.tsx
printf 'export function Footer() {\n  return <footer>© 2026 WebApp</footer>\n}\n' > src/components/Footer.tsx
echo "React + TypeScript + Vite" >> README.md

# ---- api-service
A="$ROOT/workspace/api-service"; mkdir -p "$A"; cd "$A"
git init -q -b main; git config user.name "Lin Wei"; git config user.email linwei@example.com
printf 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("api")\n}\n' > main.go
git add -A; c -m "init: api 服务"
printf 'module api\n\ngo 1.22\n' > go.mod; git add -A; c -m "build: go module"
echo "// handler" > handler.go; git add -A; c -m "feat: handler"

# ---- conflict-demo (merge in progress)
X="$ROOT/workspace/conflict-demo"; mkdir -p "$X"; cd "$X"
git init -q -b main; git config user.name "Lin Wei"; git config user.email linwei@example.com
printf 'title = "GitLoom"\ncolor = "blue"\nsize = 10\n' > config.toml; git add -A; c -m "init config"
git checkout -q -b feature/color; sed -i 's/blue/green/; s/10/12/' config.toml; git add -A; c -m "feat: 绿色主题"
git checkout -q main; sed -i 's/blue/purple/' config.toml; git add -A; c -m "feat: 紫色主题"
git merge feature/color >/dev/null 2>&1 || true

# ---- docs-site (clean)
D="$ROOT/workspace/docs-site"; mkdir -p "$D"; cd "$D"
git init -q -b main; git config user.name "Lin Wei"; git config user.email linwei@example.com
echo "# Docs" > index.md; git add -A; c -m "docs: 初始化"
echo "Demo repos created under $ROOT/workspace"
