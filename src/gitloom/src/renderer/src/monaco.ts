// Local (offline) Monaco setup: core editor + Monarch syntax highlighting for all basic languages.
// We intentionally skip the heavy language services (TS/JSON/CSS workers) – diffs are read-only.
// @ts-ignore - no type declarations for the ESM entry
import * as monacoCore from 'monaco-editor/esm/vs/editor/edcore.main'
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'

const monaco = monacoCore as typeof Monaco
;(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() }

// Editor themes derived from the app design tokens (styles.css) so diff views blend with surrounding surfaces.
monaco.editor.defineTheme('gitloom-dark', {
  base: 'vs-dark', inherit: true,
  rules: [
    { token: 'comment', foreground: '6f7385', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'b4a6ff' }, { token: 'keyword.flow', foreground: 'b4a6ff' },
    { token: 'string', foreground: '7ee0b5' }, { token: 'number', foreground: 'f5b86b' },
    { token: 'type', foreground: '6cc7ff' }, { token: 'type.identifier', foreground: '6cc7ff' },
    { token: 'tag', foreground: 'ff8fa8' }, { token: 'attribute.name', foreground: 'f5b86b' }, { token: 'attribute.value', foreground: '7ee0b5' },
    { token: 'delimiter', foreground: '9b9daa' }, { token: 'identifier', foreground: 'e3e4ea' }, { token: 'variable', foreground: 'e3e4ea' },
    { token: 'regexp', foreground: 'ff9e64' }, { token: 'key', foreground: '8fb8ff' }
  ],
  colors: {
    'editor.background': '#111216', 'editor.foreground': '#e3e4ea', 'editorGutter.background': '#111216',
    'editor.lineHighlightBackground': '#ffffff07', 'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#4d505d', 'editorLineNumber.activeForeground': '#9b9daa',
    'editor.selectionBackground': '#7b74ff44', 'editor.inactiveSelectionBackground': '#7b74ff22',
    'editorIndentGuide.background1': '#ffffff0a', 'editorWhitespace.foreground': '#ffffff14',
    'diffEditor.insertedTextBackground': '#3fb95047', 'diffEditor.removedTextBackground': '#f26d6d47',
    'diffEditor.insertedLineBackground': '#2ea0431a', 'diffEditor.removedLineBackground': '#f8514918',
    'diffEditorGutter.insertedLineBackground': '#2ea04330', 'diffEditorGutter.removedLineBackground': '#f851492c',
    'diffEditorOverview.insertedForeground': '#3fb950aa', 'diffEditorOverview.removedForeground': '#f26d6daa',
    'diffEditor.diagonalFill': '#ffffff0c', 'diffEditor.border': '#ffffff12',
    'diffEditor.unchangedRegionBackground': '#18191f', 'diffEditor.unchangedRegionForeground': '#9b9daa',
    'diffEditor.unchangedCodeBackground': '#ffffff05', 'diffEditor.move.border': '#7b74ff88',
    'scrollbarSlider.background': '#ffffff14', 'scrollbarSlider.hoverBackground': '#ffffff24', 'scrollbarSlider.activeBackground': '#ffffff30',
    'editorOverviewRuler.border': '#00000000', 'scrollbar.shadow': '#00000000', 'widget.shadow': '#00000080',
    'editorWidget.background': '#252731', 'editorWidget.border': '#ffffff1d'
  }
})
monaco.editor.defineTheme('gitloom-light', {
  base: 'vs', inherit: true,
  rules: [
    { token: 'comment', foreground: '8a8d9c', fontStyle: 'italic' },
    { token: 'keyword', foreground: '5b40d6' }, { token: 'keyword.flow', foreground: '5b40d6' },
    { token: 'string', foreground: '0f7a52' }, { token: 'number', foreground: 'b45309' },
    { token: 'type', foreground: '0b6bcb' }, { token: 'type.identifier', foreground: '0b6bcb' },
    { token: 'tag', foreground: 'c02656' }, { token: 'attribute.name', foreground: 'b45309' }, { token: 'attribute.value', foreground: '0f7a52' },
    { token: 'delimiter', foreground: '5d6072' }, { token: 'identifier', foreground: '1b1d2a' }, { token: 'key', foreground: '0b6bcb' }
  ],
  colors: {
    'editor.background': '#ffffff', 'editor.foreground': '#1b1d2a', 'editorGutter.background': '#ffffff',
    'editor.lineHighlightBackground': '#1b1d2a06', 'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#a6a8b6', 'editorLineNumber.activeForeground': '#5d6072',
    'editor.selectionBackground': '#5b52e833', 'editor.inactiveSelectionBackground': '#5b52e81a',
    'diffEditor.insertedTextBackground': '#2ea04338', 'diffEditor.removedTextBackground': '#cf222e2e',
    'diffEditor.insertedLineBackground': '#2ea04314', 'diffEditor.removedLineBackground': '#cf222e0f',
    'diffEditorGutter.insertedLineBackground': '#2ea04326', 'diffEditorGutter.removedLineBackground': '#cf222e1f',
    'diffEditor.diagonalFill': '#1b1d2a0d', 'diffEditor.border': '#1b1d2a14',
    'diffEditor.unchangedRegionBackground': '#f2f2f5', 'diffEditor.unchangedRegionForeground': '#5d6072',
    'scrollbarSlider.background': '#1b1d2a1a', 'scrollbarSlider.hoverBackground': '#1b1d2a2a',
    'editorOverviewRuler.border': '#00000000', 'scrollbar.shadow': '#00000000'
  }
})

loader.config({ monaco })
export { monaco }
