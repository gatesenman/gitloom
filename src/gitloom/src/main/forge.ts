// GitHub + GitLab REST helpers. Tokens come from settings (encrypted at rest).
import type { ForgeIssue, ForgeKind, ForgePR, ForgeRemote, ForgeSettings } from '../shared/types'

function parseRemoteUrl(url: string): ForgeRemote | null {
  // git@github.com:owner/repo.git  |  https://github.com/owner/repo.git
  // git@gitlab.com:group/repo.git  |  https://gitlab.com/group/subgroup/repo.git
  let host = '', path = ''
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(url.trim())
  const https = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url.trim())
  if (ssh) { host = ssh[1]; path = ssh[2] }
  else if (https) { host = https[1]; path = https[2] }
  else return null
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const repo = parts.pop()!
  const owner = parts.join('/')
  const kind: ForgeKind = /gitlab/i.test(host) ? 'gitlab' : /github/i.test(host) ? 'github' : host.includes('gitlab') ? 'gitlab' : 'github'
  // default: github-like for github.com / gist; gitlab for gitlab*
  const k: ForgeKind = /gitlab/i.test(host) ? 'gitlab' : 'github'
  return { kind: k, owner, repo, host, url }
}

export function detectForge(remotes: { name: string; fetchUrl: string }[]): ForgeRemote | null {
  const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0]
  return origin ? parseRemoteUrl(origin.fetchUrl) : null
}

async function gh(token: string, path: string, init: RequestInit = {}, host = 'api.github.com'): Promise<unknown> {
  if (!token) throw new Error('未配置 GitHub Token（设置 → Forge）')
  const r = await fetch(`https://${host}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'GitLoom',
      ...(init.headers ?? {})
    }
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`GitHub ${r.status}: ${t.slice(0, 200)}`)
  }
  if (r.status === 204) return null
  return r.json()
}

async function gl(token: string, path: string, init: RequestInit = {}, base = 'https://gitlab.com'): Promise<unknown> {
  if (!token) throw new Error('未配置 GitLab Token（设置 → Forge）')
  const r = await fetch(`${base.replace(/\/$/, '')}/api/v4${path}`, {
    ...init,
    headers: {
      'PRIVATE-TOKEN': token,
      'Content-Type': 'application/json',
      ...(init.headers ?? {})
    }
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`GitLab ${r.status}: ${t.slice(0, 200)}`)
  }
  if (r.status === 204) return null
  return r.json()
}

function mapGhCi(status: string | null | undefined): ForgePR['ci'] {
  if (!status) return 'neutral'
  if (status === 'success') return 'success'
  if (status === 'pending' || status === 'expected') return 'pending'
  if (status === 'failure' || status === 'error') return 'failure'
  return 'neutral'
}

export async function listPRs(forge: ForgeRemote, settings: ForgeSettings): Promise<ForgePR[]> {
  if (forge.kind === 'github') {
    const data = await gh(settings.githubToken, `/repos/${forge.owner}/${forge.repo}/pulls?state=open&per_page=30`) as Array<Record<string, unknown>>
    const prs: ForgePR[] = []
    for (const p of data) {
      let ci: ForgePR['ci'] = 'neutral'
      try {
        const sha = (p.head as { sha: string }).sha
        const checks = await gh(settings.githubToken, `/repos/${forge.owner}/${forge.repo}/commits/${sha}/status`) as { state?: string }
        ci = mapGhCi(checks.state)
      } catch { /* no permission */ }
      prs.push({
        id: p.id as number, number: p.number as number, title: p.title as string, state: p.state as string,
        url: p.html_url as string, author: (p.user as { login: string })?.login ?? '',
        head: (p.head as { ref: string }).ref, base: (p.base as { ref: string }).ref,
        draft: !!p.draft, updatedAt: p.updated_at as string, ci
      })
    }
    return prs
  }
  const project = encodeURIComponent(`${forge.owner}/${forge.repo}`)
  const data = await gl(settings.gitlabToken, `/projects/${project}/merge_requests?state=opened&per_page=30`, {}, settings.gitlabBaseUrl) as Array<Record<string, unknown>>
  return data.map((p) => ({
    id: p.id as number, number: p.iid as number, title: p.title as string, state: p.state as string,
    url: p.web_url as string, author: (p.author as { username: string })?.username ?? '',
    head: p.source_branch as string, base: p.target_branch as string,
    draft: !!p.draft, updatedAt: p.updated_at as string, ci: 'neutral'
  }))
}

export async function createPR(forge: ForgeRemote, settings: ForgeSettings, input: { title: string; body?: string; head: string; base: string; draft?: boolean }): Promise<ForgePR> {
  if (forge.kind === 'github') {
    const p = await gh(settings.githubToken, `/repos/${forge.owner}/${forge.repo}/pulls`, {
      method: 'POST', body: JSON.stringify({ title: input.title, body: input.body ?? '', head: input.head, base: input.base, draft: !!input.draft })
    }) as Record<string, unknown>
    return {
      id: p.id as number, number: p.number as number, title: p.title as string, state: p.state as string,
      url: p.html_url as string, author: (p.user as { login: string })?.login ?? '',
      head: (p.head as { ref: string }).ref, base: (p.base as { ref: string }).ref,
      draft: !!p.draft, updatedAt: p.updated_at as string
    }
  }
  const project = encodeURIComponent(`${forge.owner}/${forge.repo}`)
  const p = await gl(settings.gitlabToken, `/projects/${project}/merge_requests`, {
    method: 'POST', body: JSON.stringify({ title: input.title, description: input.body ?? '', source_branch: input.head, target_branch: input.base, draft: !!input.draft })
  }, settings.gitlabBaseUrl) as Record<string, unknown>
  return {
    id: p.id as number, number: p.iid as number, title: p.title as string, state: p.state as string,
    url: p.web_url as string, author: (p.author as { username: string })?.username ?? '',
    head: p.source_branch as string, base: p.target_branch as string, draft: !!p.draft, updatedAt: p.updated_at as string
  }
}

export async function listIssues(forge: ForgeRemote, settings: ForgeSettings): Promise<ForgeIssue[]> {
  if (forge.kind === 'github') {
    const data = await gh(settings.githubToken, `/repos/${forge.owner}/${forge.repo}/issues?state=open&per_page=30`) as Array<Record<string, unknown>>
    return data.filter((i) => !i.pull_request).map((i) => ({
      id: i.id as number, number: i.number as number, title: i.title as string, state: i.state as string,
      url: i.html_url as string, author: (i.user as { login: string })?.login ?? '',
      labels: ((i.labels as Array<{ name: string }>) ?? []).map((l) => l.name), updatedAt: i.updated_at as string
    }))
  }
  const project = encodeURIComponent(`${forge.owner}/${forge.repo}`)
  const data = await gl(settings.gitlabToken, `/projects/${project}/issues?state=opened&per_page=30`, {}, settings.gitlabBaseUrl) as Array<Record<string, unknown>>
  return data.map((i) => ({
    id: i.id as number, number: i.iid as number, title: i.title as string, state: i.state as string,
    url: i.web_url as string, author: (i.author as { username: string })?.username ?? '',
    labels: ((i.labels as string[]) ?? []), updatedAt: i.updated_at as string
  }))
}

export { parseRemoteUrl }
