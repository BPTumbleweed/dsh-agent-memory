/**
 * 运行状态登记：能力探测结果、计数器、错误与熔断、记忆库统计。
 *
 * 兼容性原则（见 maintenance/plugin-agent-memory-plan.md）：
 *   - 所有对 DSH/外部的调用都必须能被降级成"记录 + 继续"，绝不向外抛错；
 *   - 同一能力连续失败到阈值就熔断该能力，只停这一项，不影响 DSH 本体。
 */
import fs from 'node:fs'
import path from 'node:path'

const MAX_ERRORS = 20

export function createStatus(options = {}) {
  const breakerThreshold = Number(options.breakerThreshold) > 0
    ? Number(options.breakerThreshold) : 5
  const capabilities = new Map()
  const breakers = new Map()
  const errors = []
  const extraProviders = new Map()
  const counters = { events: 0, messages: 0, writes: 0, errors: 0, statusRequests: 0 }
  const startedAt = Date.now()
  let lastEventAt = 0

  function cap(name, state, detail = '') {
    capabilities.set(name, { name, state, detail, at: Date.now() })
  }

  function breaker(name) {
    let b = breakers.get(name)
    if (!b) { b = { failures: 0, tripped: false, reason: '', trippedAt: 0 }; breakers.set(name, b) }
    return b
  }

  const isTripped = (name) => breaker(name).tripped === true

  function recordError(where, err) {
    counters.errors += 1
    const message = err && err.message ? String(err.message) : String(err)
    errors.push({ at: Date.now(), where, message: message.slice(0, 400) })
    if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS)
    return message
  }

  /** 标记一次成功/失败；失败累计到阈值则熔断。 */
  function note(name, ok, detail = '') {
    const b = breaker(name)
    if (ok) {
      if (b.failures !== 0) { b.failures = 0 }
      return true
    }
    b.failures += 1
    b.reason = detail
    if (!b.tripped && b.failures >= breakerThreshold) {
      b.tripped = true
      b.trippedAt = Date.now()
      cap(name, 'tripped', `连续失败 ${b.failures} 次后熔断：${detail}`)
      try { console.warn(`[dsh-agent-memory] 能力「${name}」已熔断：${detail}`) } catch { /* ignore */ }
    }
    return false
  }

  /** 包装回调：熔断后直接跳过；同步/异步异常都吞掉并记账。 */
  function safe(name, fn) {
    return function wrapped(...args) {
      if (isTripped(name)) return undefined
      try {
        const out = fn.apply(this, args)
        if (out && typeof out.then === 'function') {
          return out.then(
            (value) => { note(name, true); return value },
            (err) => { recordError(name, err); note(name, false, err?.message ?? String(err)); return undefined },
          )
        }
        note(name, true)
        return out
      } catch (err) {
        recordError(name, err)
        note(name, false, err?.message ?? String(err))
        return undefined
      }
    }
  }

  const count = (key, delta = 1) => { counters[key] = (counters[key] ?? 0) + delta }
  /** 各能力注册自己的统计块（抛错也不影响状态快照）。 */
  const setStats = (name, fn) => { extraProviders.set(name, fn) }
  const markEvent = (ts) => { lastEventAt = ts || Date.now() }

  function snapshot() {
    return {
      startedAt,
      uptimeMs: Date.now() - startedAt,
      lastEventAt: lastEventAt || null,
      counters: { ...counters },
      extras: Object.fromEntries([...extraProviders.entries()].map(([k, fn]) => {
        try { return [k, fn()] } catch (e) { return [k, { error: String(e?.message ?? e) }] }
      })),
      capabilities: [...capabilities.values()],
      breakers: Object.fromEntries(
        [...breakers.entries()].map(([k, v]) => [k, {
          failures: v.failures, tripped: v.tripped,
          reason: v.reason, trippedAt: v.trippedAt || null,
        }]),
      ),
      recentErrors: errors.slice(-MAX_ERRORS),
    }
  }

  return { cap, safe, note, isTripped, recordError, count, markEvent, setStats, snapshot }
}

function readTextCapped(file, maxBytes = 1 << 20) {
  try {
    const st = fs.statSync(file)
    const fd = fs.openSync(file, 'r')
    try {
      const len = Math.min(st.size, maxBytes)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len))
      return buf.toString('utf8')
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

function sizeOf(file) {
  try { return fs.statSync(file).size } catch { return null }
}

function countLines(file) {
  const text = readTextCapped(file)
  if (text === null) return null
  let n = 0
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1
  return text.endsWith('\n') ? n : n + 1
}

/** 记忆库现状（供面板展示）；任何一项读不到就返回 null，不抛错。 */
export function collectStoreStats(storeRoot, dshHome) {
  let prefs = path.join(storeRoot, 'preferences', 'global.md')
  if (!fs.existsSync(prefs)) {
    const legacy = path.join(storeRoot, 'preferences', 'merlin.md')
    if (fs.existsSync(legacy)) prefs = legacy
  }
  const evidence = path.join(storeRoot, 'evidence', 'user-messages.jsonl')
  const live = path.join(storeRoot, 'evidence', 'live-messages.jsonl')
  const agentsMd = dshHome ? path.join(dshHome, 'AGENTS.md') : null
  let skills = null
  try {
    skills = fs.readdirSync(path.join(storeRoot, 'skills'))
      .filter((f) => f.endsWith('.md') && f !== 'index.md').length
  } catch { /* ignore */ }

  let pendingSignals = null
  try {
    pendingSignals = countLines(path.join(storeRoot, 'evidence', 'signals.jsonl'))
  } catch { /* ignore */ }

  // 归档台账：原始消息被压掉多少条、覆盖哪段时间（原文仍在 DSH 会话日志，可重建）
  let archived = null
  let archiveEvents = null
  let archiveLast = null
  try {
    const txt = readTextCapped(path.join(storeRoot, 'evidence', 'archive.jsonl'))
    const lines = (txt || '').split('\n').filter((l) => l.trim())
    archiveEvents = lines.length
    archived = 0
    for (const line of lines) {
      try { archived += Number(JSON.parse(line).dropped) || 0 } catch { /* ignore */ }
    }
    if (lines.length) {
      try { archiveLast = JSON.parse(lines[lines.length - 1]) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  return {
    storeRoot,
    preferencesBytes: sizeOf(prefs),
    preferencesLines: countLines(prefs),
    skills,
    evidenceMessages: countLines(evidence),
    liveMessages: countLines(live),
    liveBytes: sizeOf(live),
    agentsMdBytes: agentsMd ? sizeOf(agentsMd) : null,
    agentsMdPath: agentsMd,
    signalsTotal: pendingSignals,
    archived,
    archiveEvents,
    archiveLast,
  }
}
