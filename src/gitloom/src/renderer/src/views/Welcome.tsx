// Onboarding: pick a folder → recursive scan (live progress, cancel) → project tree.
import React from 'react'
import { app, git } from '../api'
import { useApp } from '../state'
import { Icon } from '../components/Icon'
import { Kbd, Spinner, useDialog } from '../components/ui'
import logo from '../assets/logo.svg'

export default function Welcome() {
  const { addProject, addRepos, settings, run, scan, cancelScan, project } = useApp()
  const dialog = useDialog()
  const pick = async () => { const dir = await app.pickFolder('选择项目文件夹（将递归扫描其中的所有仓库）'); if (dir) await addProject(dir) }
  const single = async () => {
    const dir = await app.pickFolder('选择一个 Git 仓库')
    if (!dir) return
    if (await git.isRepo(dir)) return addRepos([dir])
    if (await dialog({ title: '不是 Git 仓库', message: `要在 ${dir} 初始化新仓库吗？`, okText: '初始化' })) { await run('初始化', () => git.init(dir)); await addRepos([dir]) }
  }
  const step = scan ? 2 : 1
  if (scan && project) {
    return (
      <div className="welcome onboarding">
        <Steps step={2} />
        <div className="scan-hero">
          <div className="radar"><span /><span /><span /><Icon name="scan" size={30} /></div>
          <h2>正在扫描 {project.name}</h2>
          <p className="muted">递归查找仓库、子模块、工作树与裸仓库 · 深度 {settings?.scanDepth ?? 6} · 已忽略 {(settings?.scanIgnore ?? []).slice(0, 4).join('、')} 等</p>
          <div className="scan-stats"><div><b>{scan.found}</b><span>个仓库</span></div><div><b>{scan.dirs}</b><span>个文件夹</span></div></div>
          <div className="scan-cur" title={scan.current}><Spinner size={11} /> {scan.current.replace(project.root, '…') || '准备中…'}</div>
          <div className="progress indeterminate wide"><i /></div>
          <button className="btn" onClick={cancelScan}><Icon name="stop" size={14} />取消扫描</button>
        </div>
      </div>
    )
  }
  return (
    <div className="welcome onboarding">
      <img src={logo} width={76} alt="" />
      <h1>GitLoom 织线</h1>
      <p>为“一个项目里有很多仓库”而设计：嵌套仓库、子模块、工作树、裸仓库，一棵树里全部看清，一次操作批量完成。</p>
      <Steps step={step} />
      <div className="welcome-actions">
        <button className="btn btn-primary btn-lg" onClick={pick}><Icon name="folder-search" />选择项目文件夹并扫描</button>
        <button className="btn btn-lg" onClick={single}><Icon name="repo" />打开单个仓库</button>
      </div>
      <div className="hint" style={{ marginTop: 4 }}><Kbd keys={['Mod', 'P']} /> 快速打开仓库 · <Kbd keys={['Mod', 'K']} /> 命令面板 · <Kbd keys={['Mod', 'B']} /> 收起侧边栏</div>
    </div>
  )
}

function Steps({ step }: { step: number }) {
  const items = [
    { icon: 'folder-plus', t: '选择文件夹', d: '任意 IDE 项目或工作目录' },
    { icon: 'scan', t: '递归扫描', d: '深度、忽略列表可在设置中调整；符号链接防循环' },
    { icon: 'tree', t: '浏览项目树', d: '状态汇总到父文件夹，批量抓取 / 拉取 / 推送' }
  ]
  return (
    <ol className="steps">
      {items.map((it, i) => (
        <li key={i} className={i + 1 < step ? 'done' : i + 1 === step ? 'cur' : ''}>
          <span className="st-ic">{i + 1 < step ? <Icon name="check" size={14} /> : <Icon name={it.icon} size={15} />}</span>
          <span><b>{i + 1}. {it.t}</b><small>{it.d}</small></span>
        </li>
      ))}
    </ol>
  )
}
