// Built-in templates (editable / copyable). Deterministic runners for issues/security/branches; others use AI runCustom.
import type { AiTaskDef, TemplateId } from '../../shared/tasks'
import { DETERMINISTIC_TEMPLATES } from '../../shared/tasks'

export interface TemplateDef { id: TemplateId; name: string; desc: string; prompt: string; schedule: AiTaskDef['schedule']; needs?: 'issues' }
export const TEMPLATES: TemplateDef[] = [
  { id: 'issues', name: '线上问题日志日报', needs: 'issues', schedule: { kind: 'weekdays', time: '09:30' },
    desc: '每天汇总昨天问题平台里含「卡顿/卡死/崩溃/闪退/无响应」的上报，按根因分组并定位可疑代码。',
    prompt: `排查内容：
- 从问题上报平台拉取昨天（00:00–24:00）的全部工单，全量拉取、不抽样。
- 筛出标题或描述中包含「卡顿、卡死、崩溃、闪退、无响应」任一关键词的上报。
- 按根因分组：同一原因导致的上报归为一类，并结合代码定位可疑的文件和函数。

要求：
- 只做分析，不修改问题平台和代码。
- 每一类都要有依据；拿不准根因的单独归入「待人工确认」，不要硬归类。
- 还没有接入问题上报平台时，不运行，直接提示「需先接入问题上报平台」。

输出格式：
- 开头一句：「昨日命中 N 条 / 分成 M 类根因」。
- 每类一组：条数、一个样例单号、一句话结论、可疑文件 + 函数。
- 最后一组：「待人工确认」，列出单号和标题。
- 没有命中时只写：「昨日无命中上报」。` },
  { id: 'security', name: '主动安全扫描', schedule: { kind: 'weekly', days: [1], time: '10:00' },
    desc: '静态检查硬编码密钥、命令/SQL 拼接、不安全反序列化、路径穿越与高危依赖漏洞；与上次对比标出新增。',
    prompt: `扫描内容：
- 硬编码的密钥、令牌、密码。
- 命令拼接（把外部输入拼进 shell 命令）。
- SQL 拼接（把外部输入拼进 SQL 语句）。
- 不安全的反序列化。
- 路径穿越（外部输入直接拼进文件路径）。
- 已知高危依赖漏洞（依赖审计）。

要求：
- 先用确定性的静态规则检测，AI 只用来判断是否真的可被利用。
- 每条结果必须带文件和行号，否则不报。
- 按真实可利用性排序，分为高 / 中 / 低。
- 与上一次运行结果对比，新出现的标「本周新增」。
- 只给修复建议，不修改任何代码。

输出格式：
- 开头一句：「本次 N 条，其中高危 X 条」。
- 按高危 / 中危 / 低危分组，每条：类别、问题、文件:行号、代码片段、修复建议。
- 与上次相比没有新增时写：「本次未发现新增风险」。` },
  { id: 'branches', name: '陈旧本地分支清理建议', schedule: { kind: 'weekly', days: [5], time: '17:00' },
    desc: '找出 30 天没动、从未推送的本地分支，列出最后提交时间、是否已合并、有无未推送提交，只给删除建议。',
    prompt: `盘点内容：
- 超过 30 天没有新提交、且从未推送到远程的本地分支。
- 逐个列出：最后提交时间、是否已合并进主分支、是否有未推送的提交。

要求：
- 分支事实由程序确定性计算，不靠 AI 猜。
- 只有「已合并进主分支且没有未推送提交」的才建议删除。
- 有未推送提交的建议保留，并写明原因。
- 只给建议，绝不执行删除。

输出格式：
- 开头一句：「N 个分支超过 30 天没动，其中 X 个建议删除」。
- 分「建议删除 / 建议保留」两组，每个分支一行：分支名、最后提交时间、是否已合并、有无未推送提交、理由。
- 没有符合条件的分支时只写：「本地很干净，没什么要清的」。` },
  { id: 'deps', name: '依赖漏洞周报', schedule: { kind: 'weekly', days: [1], time: '09:00' },
    desc: '盘点 npm/pip 等依赖审计结果，按高危优先列出 CVE 与升级建议，适合周一开工前看一眼。',
    prompt: `排查内容：
- 对各仓库执行依赖审计（npm audit / pip 等可获得的只读结果）。
- 汇总高危 / 中危漏洞：包名、当前版本、建议版本、CVE 或公告链接（如有）。
- 标出本周相对上次（若上下文有）新增的漏洞。

要求：
- 只做分析与升级建议，不修改 lockfile 或执行安装。
- 没有审计工具时说明缺失项，不要编造 CVE。
- 按真实风险排序：高危在前。

输出格式：
- 开头一句：「本周依赖漏洞 N 条，其中高危 X 条」。
- 按高危 / 中危 / 低危分组；每条：包、版本、问题摘要、建议动作。
- 无漏洞时写：「依赖面干净，未发现需立刻处理的漏洞」。` },
  { id: 'stale-pr', name: '陈旧 PR / 未合并提醒', schedule: { kind: 'weekdays', time: '10:00' },
    desc: '找出长时间未更新或未合并的 Pull Request 线索，提醒跟进评审与合并，避免分支烂尾。',
    prompt: `排查内容：
- 基于最近提交、分支与远程跟踪信息，推断可能对应未合并改动的分支/PR 线索。
- 标出超过 14 天无新提交、或已落后主分支较多的特性分支。
- 区分：可合并候选 / 需作者更新 / 建议关闭。

要求：
- 没有 forge API 时，用本地 git 事实说话，不要假装读到了 PR 列表。
- 只给跟进建议，不合并、不关闭远程 PR。

输出格式：
- 开头一句：「发现 N 条陈旧未合并线索，其中 X 条建议优先处理」。
- 分组列出分支名、最后活动时间、落后情况、建议。
- 没有问题时写：「没有明显烂尾的未合并改动」。` },
  { id: 'bigfiles', name: '大文件 / 二进制误提交巡检', schedule: { kind: 'weekly', days: [3], time: '11:00' },
    desc: '扫描近期提交与工作区，找出过大的文件或可疑二进制，避免仓库膨胀。',
    prompt: `排查内容：
- 找出体积偏大（例如 >1MB）或疑似二进制/压缩包/安装包的已跟踪文件。
- 关注最近 30 个提交中新引入的大文件。
- 判断是否更适合 Git LFS 或移出仓库。

要求：
- 依据 git 与路径后缀做判断；不确定标「待人工确认」。
- 只建议，不删除文件、不改历史。

输出格式：
- 开头一句：「发现 N 个可疑大文件 / 二进制」。
- 列表：路径、大约体积或类型、首次引入线索、建议（LFS / 移出 / 忽略）。
- 没有问题时写：「未发现明显的大文件误提交」。` },
  { id: 'changelog', name: '提交规范与 Changelog 草稿', schedule: { kind: 'weekly', days: [5], time: '16:00' },
    desc: '汇总本周提交，检查约定式提交合规性，并起草一份给人看的 Changelog。',
    prompt: `排查内容：
- 汇总选定范围内最近一段时间（默认约 7 天）的提交信息。
- 检查是否符合约定式提交（feat/fix/docs/…）；列出不合规样例。
- 按用户可见变更起草 Changelog 草稿（新增 / 修复 / 破坏性变更）。

要求：
- 草稿要可直接粘贴到发布说明；不要编造未出现的功能。
- 只分析，不改写 git 历史。

输出格式：
- 开头一句：「本周 N 个提交，其中不合规 X 个」。
- 然后「Changelog 草稿」分段。
- 最后列出不合规提交的短哈希与原信息。` },
  { id: 'coverage', name: '测试覆盖率下滑预警', schedule: { kind: 'weekly', days: [2], time: '09:30' },
    desc: '根据仓库内已有覆盖率报告或测试脚本线索，提醒覆盖率下滑与高风险未测区域。',
    prompt: `排查内容：
- 查找 coverage / lcov / jacoco / pytest --cov 等报告或配置线索。
- 若有数字：对比（或估）关键模块覆盖是否明显偏低。
- 若无报告：根据测试目录与最近改动，标出「高风险未测」文件。

要求：
- 没有覆盖率数据时如实说明，并给「如何一键生成报告」的建议命令（只建议不执行）。
- 不修改测试或配置。

输出格式：
- 开头一句：「覆盖率结论：…」。
- 列出风险文件 / 模块与理由。
- 无可疑项时写：「未发现明显的覆盖率下滑信号」。` },
  { id: 'license', name: '许可证 / LICENSE 合规抽查', schedule: { kind: 'weekly', days: [4], time: '14:00' },
    desc: '抽查仓库 LICENSE、第三方声明与高风险许可证依赖，降低合规风险。',
    prompt: `排查内容：
- 是否存在根目录 LICENSE / NOTICE / 第三方声明文件。
- 依赖中是否出现常见高风险或需注意的许可证线索（GPL/AGPL/未知等，基于锁文件与清单文字）。
- 多仓库时逐仓简述状态。

要求：
- 证据不足时标「待确认」，不要断言法律结论。
- 只输出合规观察与建议动作。

输出格式：
- 开头一句：「许可证抽查：N 项需关注」。
- 分「仓库自身 / 依赖线索 / 建议」三组。
- 干净时写：「未发现明显许可证缺口」。` },
  { id: 'secrets-drift', name: '敏感配置漂移巡检', schedule: { kind: 'weekdays', time: '11:30' },
    desc: '对比 .env.example / 示例配置与可能被提交的真实环境文件，发现密钥与配置漂移。',
    prompt: `排查内容：
- 查找 .env、.env.*、*secret*、credentials 等路径是否被跟踪。
- 对比 .env.example / *.example 与疑似真实配置：键是否漂移、是否像真实密钥。
- 列出不该提交却已跟踪的候选文件。

要求：
- 输出中对疑似密钥打码；不要完整回显密钥。
- 只建议加入 ignore / 轮换密钥，不改文件。

输出格式：
- 开头一句：「敏感配置巡检：N 项需处理」。
- 每条：路径、问题类型、建议。
- 干净时写：「未发现明显的敏感配置漂移」。` },
  { id: 'release-checklist', name: '发布前 Checklist 摘要', schedule: { kind: 'manual' },
    desc: '发布前一键汇总：脏工作区、未推送提交、落后主分支、TODO/FIXME、钩子与基础卫生，生成可勾选清单。',
    prompt: `排查内容：
- 工作区是否干净、是否有未推送提交、是否落后上游/主分支。
- 最近改动中的 TODO/FIXME/XXX 残留。
- 基础卫生：是否像缺 README/LICENSE、是否有巨大未跟踪文件线索。

要求：
- 输出为可勾选的发布前清单（Markdown 复选框）。
- 每项给出通过 / 风险 / 未知，并附一句证据。
- 只分析，不执行发布或打 tag。

输出格式：
- 开头一句：「发布前检查：通过 A 项 / 风险 B 项 / 未知 C 项」。
- 然后 checklist 列表。
- 最后「建议发布条件」一段话。` }
]
export const templateOf = (id?: TemplateId | null) => TEMPLATES.find((t) => t.id === id)
/** guard: may this task run now? */
export function guard(t: Pick<AiTaskDef, 'template' | 'scope'>, ctx: { connectorReady: boolean; aiReady: boolean }): { ok: true } | { ok: false; reason: string } {
  if (t.template === 'issues' && !ctx.connectorReady) return { ok: false, reason: '需先接入问题上报平台' }
  if (t.template !== 'issues' && !t.scope.repos.length) return { ok: false, reason: '没有选择要分析的仓库' }
  const needsAi = !t.template || !DETERMINISTIC_TEMPLATES.has(t.template)
  if (needsAi && !ctx.aiReady) return { ok: false, reason: '此任务需要先在「设置 → AI 模型」中配置 AI 服务商' }
  return { ok: true }
}
