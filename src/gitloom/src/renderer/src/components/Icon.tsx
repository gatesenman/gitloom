// Unified icon set: lucide-react, mapped from GitLoom's semantic icon names.
import React from 'react'
import {
  FilePen, FileDiff, History, GitGraph, GitBranch, FolderTree, Archive, Webhook, Sparkles, Settings, Plus, Minus,
  Folder, BookMarked, RefreshCw, ArrowDownToLine, ArrowUpFromLine, Check, X, Trash2, Undo2, RotateCw, Search,
  SquareTerminal, Code2, ExternalLink, Tag, GitMerge, Cloud, Lock, LockOpen, File, Eye, Sun, Moon, Copy, Ellipsis,
  TriangleAlert, ScrollText, Columns2, Rows3, Download, Play, Save, ChevronRight, Cherry, PanelLeftClose, PanelLeftOpen,
  Command, Minus as WinMin, Square, Copy as WinRestore, CircleCheck, CircleAlert, Info, GitCommitHorizontal, Keyboard,
  ChevronDown, Inbox, FolderOpen, FolderGit2, Package, Boxes, Database, Pin, PinOff, Star, Clock, LayoutDashboard,
  ListTree, List, LayoutList, ChevronsDownUp, ChevronsUpDown, EyeOff, Layers, GitPullRequestArrow, CircleDot, Unlink, Radar,
  StopCircle, Rows4, Rows2, FolderSearch, FolderPlus, SquareStack, GripVertical, ArrowUp, ArrowDown, CircleDashed, Hash, Link2,
  GitCompareArrows, Binary, FileSearch, HardDrive, ShieldAlert,
  Network, Workflow, Shapes, Box, Braces, SquareFunction, Radio, Route, Globe, Diamond, Flame, Activity, ListOrdered, Split, Repeat,
  CornerDownLeft, Zap, Component, FileCode2, Maximize, ImageDown, ClipboardCopy, Crosshair, Focus, Waypoints, Blocks, PanelRight,
  WandSparkles, ZoomIn, ZoomOut, MoveHorizontal, ShieldQuestion, Map as MapIcon, Footprints, ArrowLeftRight, LayoutGrid, ListChecks, FileText, ChevronLeft, Pause, BookOpen, ShieldCheck, type LucideIcon
} from 'lucide-react'

const MAP: Record<string, LucideIcon> = {
  'folder-open': FolderOpen, 'repo-normal': FolderGit2, 'repo-nested': Boxes, 'repo-submodule': Package, 'repo-worktree': FolderTree,
  'repo-bare': Database, pin: Pin, unpin: PinOff, star: Star, clock: Clock, dashboard: LayoutDashboard, tree: ListTree, list: List,
  grouped: LayoutList, 'collapse-all': ChevronsDownUp, 'expand-all': ChevronsUpDown, hide: EyeOff, layers: Layers, 'pr': GitPullRequestArrow,
  dot: CircleDot, unlink: Unlink, scan: Radar, stop: StopCircle, 'density-compact': Rows4, 'density-comfortable': Rows2,
  'folder-search': FolderSearch, 'folder-plus': FolderPlus, stack: SquareStack, grip: GripVertical, up: ArrowUp, down: ArrowDown,
  uninit: CircleDashed, hash: Hash, link: Link2,
  changes: FilePen, diff: FileDiff, history: History, graph: GitGraph, branch: GitBranch, worktree: FolderTree,
  stash: Archive, hook: Webhook, ai: Sparkles, settings: Settings, plus: Plus, minus: Minus, folder: Folder,
  repo: BookMarked, fetch: RefreshCw, pull: ArrowDownToLine, push: ArrowUpFromLine, check: Check, x: X, trash: Trash2,
  undo: Undo2, refresh: RotateCw, search: Search, terminal: SquareTerminal, code: Code2, external: ExternalLink,
  tag: Tag, merge: GitMerge, cloud: Cloud, lock: Lock, unlock: LockOpen, file: File, eye: Eye, sun: Sun, moon: Moon,
  copy: Copy, more: Ellipsis, warn: TriangleAlert, log: ScrollText, split: Columns2, inline: Rows3, download: Download,
  play: Play, save: Save, chevron: ChevronRight, 'chevron-down': ChevronDown, cherry: Cherry, 'sidebar-close': PanelLeftClose,
  'sidebar-open': PanelLeftOpen, command: Command, 'win-min': WinMin, 'win-max': Square, 'win-restore': WinRestore,
  ok: CircleCheck, error: CircleAlert, info: Info, commit: GitCommitHorizontal, keyboard: Keyboard, inbox: Inbox,
  rebase: GitMerge, bisect: Binary, tools: FileSearch, compare: GitCompareArrows, blame: FileSearch, lfs: HardDrive, signing: ShieldAlert, forge: Cloud,
  // 变更可视化
  viz: Waypoints, modules: Network, calls: Workflow, flow: Split, sequence: ListOrdered, state: Activity, classes: Shapes, impact: Flame,
  box: Box, braces: Braces, fn: SquareFunction, event: Radio, route: Route, globe: Globe, diamond: Diamond, repeat: Repeat,
  'ret': CornerDownLeft, zap: Zap, component: Component, 'file-code': FileCode2, fit: Maximize, image: ImageDown, 'clip-copy': ClipboardCopy,
  crosshair: Crosshair, focus: Focus, blocks: Blocks, panel: PanelRight, wand: WandSparkles, 'zoom-in': ZoomIn, 'zoom-out': ZoomOut,
  slider: MoveHorizontal, 'try': ShieldQuestion,
  codemap: MapIcon, tour: Footprints, swap: ArrowLeftRight, treemap: LayoutGrid, checklist: ListChecks, 'file-text': FileText, flame: Flame, 'chevron-left': ChevronLeft, pause: Pause, minimap: MapIcon, book: BookOpen, shield: ShieldCheck
}

export function Icon({ name, size = 16, className, style, strokeWidth = 1.75 }: { name: string; size?: number; className?: string; style?: React.CSSProperties; strokeWidth?: number }) {
  const C = MAP[name] ?? File
  return <C className={className} style={style} size={size} strokeWidth={strokeWidth} aria-hidden absoluteStrokeWidth={false} />
}
