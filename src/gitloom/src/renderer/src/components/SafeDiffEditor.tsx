// @monaco-editor/react disposes the text models BEFORE the diff editor on unmount, which throws
// "TextModel got disposed before DiffEditorWidget model got reset" every time a diff view is left (found by the 0.5.0
// regression run: switching tabs away from 变更 / 历史). Keep the models, detach them, then dispose in the right order.
import React, { useEffect, useRef } from 'react'
import { DiffEditor, type DiffEditorProps } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'

export function SafeDiffEditor(props: DiffEditorProps) {
  const ed = useRef<editor.IStandaloneDiffEditor | null>(null)
  useEffect(() => () => {
    const e = ed.current; ed.current = null
    if (!e) return
    const m = e.getModel()
    try { e.setModel(null) } catch { /* already gone */ }
    m?.original?.dispose(); m?.modified?.dispose()
  }, [])
  return <DiffEditor {...props} keepCurrentOriginalModel keepCurrentModifiedModel onMount={(e, monaco) => { ed.current = e; props.onMount?.(e, monaco) }} />
}
