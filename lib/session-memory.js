/**
 * 会话级记忆注入：把 `<storeRoot>/sessions/<会话id>.md` 注入到**它自己那个会话**里。
 *
 * 为什么需要插件来做：官方 `agent-instructions` 的注入维度是"工作目录"，而所有对话共用
 * 同一个目录，表达不了"只对这个对话有效"。DSH 核心里按会话注入的正规位置是
 * `agent/pre-step` 瀑布钩子——handler 返回 `{ kind: "enter", messages }` 即可改这一轮的
 * 消息序列（官方 `dsh-agent` 自身与第三方 `graph-memory` 都这么用）。
 *
 * 兼容性处理（这层是内部接口，是本插件最脆的一环）：
 *   - 逐项特性探测：没有 `agent/created` / `agent.ctx.on` 就记 unavailable，不报错；
 *   - 包在熔断器里：连续失败到阈值只停"会话注入"，全局注入与记忆库不受影响；
 *   - 非破坏式：先 `await next()` 拿官方结果，再往里插，绝不吞掉别人的处理器；
 *   - 有预算上限（默认 2 KB），超了截断并在面板提示。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_MAX_BYTES = 2048
const HEADER = '[本对话记忆 · 仅在本会话有效]\n'

function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end === -1) return text
  return text.slice(end + 4)
}

/** 插到"最后一条用户消息"之前：让用户当下的指令仍然是最后说的话。 */
function insertBeforeLastUser(messages, msg) {
  if (!Array.isArray(messages) || messages.length === 0) return [msg]
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === 'user') {
      return [...messages.slice(0, i), msg, ...messages.slice(i)]
    }
  }
  return [...messages, msg]
}

export function attachSessionMemory(ctx, status, config) {
  const sessionsDir = path.join(config.storeRoot, 'sessions')
  const maxBytes = Number(config.sessionInjectMax) > 0
    ? Number(config.sessionInjectMax) : DEFAULT_MAX_BYTES
  const attached = new WeakSet()
  const cache = new Map()
  const stats = { injected: 0, skipped: 0, truncated: 0, lastBytes: 0, lastSession: null }

  function readSessionMemory(sessionId) {
    if (!sessionId) return null
    const file = path.join(sessionsDir, `${sessionId}.md`)
    let st
    try {
      st = fs.statSync(file)
    } catch {
      return null
    }
    const hit = cache.get(sessionId)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
    let body = ''
    try {
      body = fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
    let text = stripFrontmatter(body).trim()
    if (!text) return null
    if (Buffer.byteLength(text) > maxBytes) {
      text = `${text.slice(0, maxBytes)}\n…（本对话记忆超过 ${maxBytes} B 上限，已截断）`
      stats.truncated += 1
    }
    cache.set(sessionId, { mtimeMs: st.mtimeMs, size: st.size, text })
    return text
  }

  const makeMessage = (text) => ({
    id: randomUUID(),
    role: 'user',
    source: { kind: 'plugin', plugin: 'dsh-agent-memory', form: 'session-memory' },
    content: [{ type: 'text', text: HEADER + text }],
  })

  const stepHandler = status.safe('sessionMemory', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision
    const agent = payload && payload.agent
    const sessionId = agent?.session?.id
    const text = readSessionMemory(sessionId)
    if (!text) {
      stats.skipped += 1
      return decision
    }
    stats.injected += 1
    stats.lastBytes = Buffer.byteLength(text)
    stats.lastSession = sessionId
    return { ...decision, messages: insertBeforeLastUser(decision.messages, makeMessage(text)) }
  })

  function attachToAgent(agent) {
    if (!agent || typeof agent !== 'object' || attached.has(agent)) return
    const agentCtx = agent.ctx
    if (!agentCtx || typeof agentCtx.on !== 'function') return
    attached.add(agent)
    agentCtx.on('agent/pre-step', stepHandler)
  }

  try {
    if (typeof ctx.on !== 'function') {
      status.cap('sessionMemory', 'unavailable', 'ctx.on 不可用（DSH 接口变化）')
      return
    }
    ctx.on('agent/created', ({ agent }) => {
      try { attachToAgent(agent) } catch (err) { status.recordError('sessionMemory.attach', err) }
    })
    // 重载/续跑时的兜底：新会话开始时再挂一次（attachToAgent 自带去重）
    ctx.on('agent/session-start', ({ agent }) => {
      try { attachToAgent(agent) } catch (err) { status.recordError('sessionMemory.attach', err) }
    })
    status.cap('sessionMemory', 'ok',
      `已挂 agent/created + agent/session-start（目录 ${sessionsDir}，上限 ${maxBytes} B）`)
  } catch (err) {
    status.recordError('sessionMemory.attach', err)
    status.cap('sessionMemory', 'unavailable', `挂载失败：${err?.message ?? err}`)
    return
  }

  status.setStats('sessionMemory', () => ({
    ...stats,
    dir: sessionsDir,
    maxBytes,
    cached: cache.size,
  }))
}
