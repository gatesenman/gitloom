// Prompt library for GitLoom AI features + thin wrappers over the protocol-aware client (aiClient.ts).
import type { AIAction, AISettings } from '../shared/types'

import { chatWithFallback, listProfileModels, migrateAI, stripThink, taskOf, type CallOpts, type ChatMessage } from './aiClient'

export type { ChatMessage }
export { stripThink }

/** Chat through the configured provider chain (profiles + per-task model + fallback). */
export async function chat(settings: AISettings, messages: ChatMessage[], opts: CallOpts & { action?: AIAction | 'chat' } = {}): Promise<string> {
  const { action, ...o } = opts
  return (await chatWithFallback(settings, taskOf(action ?? 'chat'), messages, o)).text
}

export async function listModels(settings: AISettings): Promise<string[]> {
  const ai = migrateAI(settings)
  const p = ai.profiles?.find((x) => x.id === ai.activeProfile)
  if (!p) throw new Error('还没有配置 AI 服务商')
  const r = await listProfileModels(p)
  if (r.source !== 'remote') throw new Error(`获取模型列表失败：${r.error}`)
  return r.models
}

/** Remove ``` fences the model may wrap around a commit message / command. */
export function unfence(s: string): string {
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(s.trim())
  return (m ? m[1] : s).trim()
}

export function buildPrompt(action: AIAction, s: AISettings, input: { diff?: string; context?: string; question?: string; branch?: string; log?: string }): ChatMessage[] {
  const lang = s.language === 'en' ? 'English' : '简体中文'
  switch (action) {
    case 'commitMessage': {
      const style = s.commitStyle === 'conventional'
        ? `使用 Conventional Commits 格式：第一行 "<type>(<scope>): <subject>"（type 取 feat/fix/docs/style/refactor/perf/test/build/ci/chore），subject 不超过 72 字符`
        : s.commitStyle === 'gitmoji' ? '第一行以合适的 gitmoji 开头（如 ✨ 🐛 📝 ♻️），不超过 72 字符' : '第一行为不超过 72 字符的简短摘要'
      return [
        { role: 'system', content: `你是资深工程师，负责根据 git 暂存区差异写提交信息。${style}。如有必要，空一行后用 2-5 条 "- " 要点说明动机与关键改动。提交信息使用${lang}书写（type/scope 关键字保持英文）。只输出提交信息本身，不要解释，不要代码块。` },
        { role: 'user', content: `${input.branch ? `当前分支：${input.branch}\n` : ''}${input.context ? `用户补充：${input.context}\n` : ''}暂存区差异：\n${input.diff}` }
      ]
    }
    case 'explainDiff':
      return [
        { role: 'system', content: `你是代码审阅助手。用${lang}解释下面的代码差异：先一句话总结，再分点说明每处修改做了什么、为什么可能这样改、潜在影响。使用 Markdown。` },
        { role: 'user', content: input.diff ?? '' }
      ]
    case 'reviewStaged':
      return [
        { role: 'system', content: `你是严格但友善的代码审查者。审查以下即将提交的改动，用${lang}输出 Markdown：\n## 总结\n## 问题（按严重程度：🔴 严重 / 🟡 建议 / 🟢 细节，每条注明文件与行附近内容）\n## 测试建议\n若没有问题请明确说明。不要编造未出现在差异中的代码。` },
        { role: 'user', content: input.diff ?? '' }
      ]
    case 'branchName':
      return [
        { role: 'system', content: '根据任务描述给出 5 个 git 分支名建议，格式 <type>/<kebab-case-short-desc>（type 取 feature/fix/chore/docs/refactor/hotfix），只包含小写英文、数字、连字符和一个斜杠。每行一个，不要编号和解释。' },
        { role: 'user', content: input.question ?? '' }
      ]
    case 'nlToGit':
      return [
        { role: 'system', content: `你把用户的自然语言需求翻译成 git 命令。输出严格的 JSON：{"commands": ["git ..."], "explanation": "用${lang}解释每条命令的作用与风险"}。只使用 git 命令，每条以 "git " 开头，不使用管道、重定向、&& 或 shell 变量。危险操作（reset --hard、push --force、clean -fd、branch -D）必须在 explanation 中警示。` },
        { role: 'user', content: `${input.context ? `仓库状态：\n${input.context}\n\n` : ''}需求：${input.question}` }
      ]
    case 'prDescription':
      return [
        { role: 'system', content: `根据提交记录与差异摘要，用${lang}生成 Pull Request 描述（Markdown）：## 概述、## 主要改动（分点）、## 测试方式、## 风险与回滚。另外在末尾给出一段适合放进 CHANGELOG 的条目（### Changelog）。` },
        { role: 'user', content: `${input.log ?? ''}\n\n${input.diff ?? ''}` }
      ]
    case 'conflictHelp':
      return [
        { role: 'system', content: `你是合并冲突解决助手。给出 base/ours/theirs 三个版本和当前带冲突标记的文件，用${lang}先分析双方意图，再输出建议的合并结果。合并结果放在唯一的一个 \`\`\` 代码块中，必须是完整文件内容且不含冲突标记。` },
        { role: 'user', content: input.diff ?? '' }
      ]
    case 'designReview':
      return [
        { role: 'system', content: `你是前端设计系统审查助手。根据 DESIGN.md（设计契约）用${lang}输出 Markdown：\n## 总结\n## 完整性（令牌/组件/间距/可访问性是否写清）\n## 问题（按 🔴严重 / 🟡建议 / 🟢细节）\n## 改进建议\n不要编造文件中没有的内容；若文档很短也要诚实指出缺口。` },
        { role: 'user', content: input.diff ?? input.context ?? '' }
      ]
  }
}