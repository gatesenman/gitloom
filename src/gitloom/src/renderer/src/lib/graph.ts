// Commit graph lane layout (GitKraken / Fork / VS Code Git Graph style).
// Input commits must be in topological/date order (children before parents).
export interface GraphCommit { hash: string; parents: string[] }

export interface GraphSegment {
  /** column at row top (y=0) or node (y=0.5) */
  x1: number; y1: number
  x2: number; y2: number
  color: number
}

export interface GraphRow {
  col: number
  color: number
  segments: GraphSegment[]
  /** number of lanes visible in this row (for width) */
  width: number
}

export interface GraphLayout { rows: GraphRow[]; maxCols: number }

export function layoutGraph(commits: GraphCommit[]): GraphLayout {
  const lanes: (string | null)[] = []
  const laneColor: number[] = []
  let nextColor = 0
  let maxCols = 0
  const rows: GraphRow[] = []
  const known = new Set(commits.map((c) => c.hash))

  const alloc = (avoid = -1): number => {
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === null && i !== avoid) return i
    lanes.push(null)
    laneColor.push(0)
    return lanes.length - 1
  }

  for (const c of commits) {
    const before = lanes.slice()
    const segments: GraphSegment[] = []
    let col = lanes.indexOf(c.hash)
    if (col === -1) {
      col = alloc()
      laneColor[col] = nextColor++
    }
    const color = laneColor[col]
    // top half: all lanes that point at this commit converge into the node
    for (let i = 0; i < before.length; i++) {
      const h = before[i]
      if (h === null) continue
      if (h === c.hash) {
        segments.push({ x1: i, y1: 0, x2: col, y2: 0.5, color: laneColor[i] })
        if (i !== col) lanes[i] = null
      }
    }
    lanes[col] = null
    const relocated = new Map<number, number>()
    // parents (ignore parents outside the loaded window → draw a short stub)
    const parents = c.parents
    parents.forEach((p, pi) => {
      const existing = lanes.indexOf(p)
      if (existing !== -1 && pi === 0 && existing > col && before[existing] === p) {
        // keep the parent on the leftmost lane: pull the other lane into ours
        lanes[existing] = null
        lanes[col] = p
        relocated.set(existing, col)
        segments.push({ x1: col, y1: 0.5, x2: col, y2: 1, color })
        return
      }
      if (existing !== -1) {
        segments.push({ x1: col, y1: 0.5, x2: existing, y2: 1, color: pi === 0 ? color : laneColor[existing] })
        return
      }
      let target: number
      if (pi === 0) { target = col; laneColor[col] = color }
      else { target = alloc(col); laneColor[target] = nextColor++ }
      lanes[target] = known.has(p) ? p : `__missing:${p}`
      segments.push({ x1: col, y1: 0.5, x2: target, y2: 1, color: laneColor[target] })
    })
    // pass-through lanes
    for (let i = 0; i < before.length; i++) {
      const h = before[i]
      if (h === null || h === c.hash) continue
      segments.push({ x1: i, y1: 0, x2: relocated.get(i) ?? i, y2: 1, color: laneColor[i] })
    }
    // missing parents end here (not in window): drop lane after a stub
    for (let i = 0; i < lanes.length; i++) {
      const h = lanes[i]
      if (h && h.startsWith('__missing:')) lanes[i] = null
    }
    // trim trailing empty lanes
    while (lanes.length && lanes[lanes.length - 1] === null) { lanes.pop(); laneColor.pop() }
    const width = Math.max(before.length, col + 1, ...segments.map((s) => Math.max(s.x1, s.x2) + 1))
    maxCols = Math.max(maxCols, width)
    rows.push({ col, color, segments, width })
  }
  return { rows, maxCols }
}

// Lane palette: starts with the brand accent, then evenly spaced hues tuned for both themes (≥3:1 on dark and light surfaces).
export const GRAPH_COLORS = ['#7b74ff', '#22b8a7', '#f0a020', '#ec5a7d', '#3b9cff', '#7cb342', '#b07cff', '#ff7a45', '#12b5cb', '#e066b0']
