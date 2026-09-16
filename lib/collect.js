/**
 * 实时采集：把人类用户消息按到达顺序追加到 evidence/live-messages.jsonl。
 *
 * 与 python 定时器的分工：
 *   - 插件 = 实时快路径，只追加、只写自己的 live 文件；
 *   - memory-scan.py = 权威归并者，把 live 文件按消息 id 并入 user-messages.jsonl。
 * 这样即使插件重复启动、漏采或停用，也不会污染主证据。
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_TEXT = 4000
const SEEN_CAP = 5000

export function attachCollector(ctx, status, config) {
  if (typeof ctx.on !== 'function') {
    status.cap('collector', 'unavailable', 'ctx.on 不是函数（DSH 接口变化）')
    return
  }
  const dir = path.join(config.storeRoot, 'evidence')
  const file = path.join(dir, 'live-messages.jsonl')
  const seen = new Set()

  const handler = status.safe('collector', (session, event) => {
    status.markEvent(event?.time || Date.now())
    status.count('events')
    if (!event || event.type !== 'user/message') return

    const data = event.data ?? {}
    const source = data.source ?? {}
    if (source.kind !== 'user') return            // 插件快照/工具消息不算

    const id = data.id
    if (!id || seen.has(id)) return
    const sessionId = String(session?.id ?? '')
    // 纯 uuid 目录是子代理会话，其中的"用户消息"是代理自己下发的任务
    if (!sessionId.startsWith('session-')) return

    const parts = Array.isArray(data.content) ? data.content : []
    const text = parts
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
      .trim()
    if (!text) return

    seen.add(id)
    if (seen.size > SEEN_CAP) {
      // 防内存无界：超限就整体丢弃（下游按 id 去重，重复无害）
      seen.clear()
      seen.add(id)
    }

    const record = {
      id,
      session: sessionId,
      seq: event.seq ?? null,
      ts: event.time ?? null,
      text: text.slice(0, MAX_TEXT),
      collectedBy: 'dsh-agent-memory-plugin',
    }
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    status.count('messages')
    status.count('writes')
  })

  try {
    ctx.on('session/event', handler)
    status.cap('collector', 'ok', `已挂 session/event → ${file}`)
  } catch (err) {
    status.recordError('collector.attach', err)
    status.cap('collector', 'unavailable', `挂载失败：${err?.message ?? err}`)
  }
}
