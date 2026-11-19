// worker_threads entry: tree-sitter parsing off the main process. Messages: {id, items} → progress* → {id, facts}.
import { parentPort, workerData } from 'worker_threads'
import { FactParser } from './parser'
import type { ParseItem } from './service'

const parser = new FactParser(workerData.grammarDir as string, workerData.runtimeWasm as string | undefined)
parentPort!.on('message', async (msg: { id: number; items: ParseItem[] }) => {
  try {
    const facts = []
    for (let i = 0; i < msg.items.length; i++) {
      const it = msg.items[i]
      facts.push(await parser.parse(it.path, it.lang, it.src))
      if (i % 25 === 24) parentPort!.postMessage({ id: msg.id, progress: i + 1 })
    }
    parentPort!.postMessage({ id: msg.id, facts })
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, error: (e as Error).message })
  }
})
