/**
 * dsh-agent-memory —— Merlin 的 DSH 长期记忆插件（P0）
 *
 * 职责边界（刻意划窄，为了扛住 DSH 升级）：
 *   ✅ 实时采集对话证据（session/event → evidence/live-messages.jsonl）
 *   ✅ 工作状态面板（/dsh-agent-memory/panel 与 /status.json）
 *   ⏳ 记忆工具 memory_*（P1）
 *   ❌ 偏好注入 —— 继续由官方 @deepseek-ai/dsh-agent-instructions + $DSH_HOME/AGENTS.md 负责，
 *      本插件不抢注入，避免依赖 agent/pre-step + agent.inbox 这类内部接口。
 *
 * 兼容性六条：零运行时依赖 / 能力逐个探测 / 回调全包 try-catch / 失败熔断 /
 * 只写自己的目录 / 启动即自检并把版本与探测结果暴露到面板。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createStatus } from './status.js'
import { attachCollector } from './collect.js'
import { attachPanel } from './panel.js'

const PLUGIN_VERSION = '0.1.0'

/** 尽力而为地探测 DSH 版本：探不到就返回 null，绝不因此失败。 */
function detectDshVersion() {
  const read = (file) => {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
      return pkg?.version ? `v${pkg.version}` : null
    } catch { return null }
  }
  // ① 直接解析依赖（最稳，不依赖安装布局）
  try {
    const req = createRequire(import.meta.url)
    const v = read(req.resolve('@deepseek-ai/dsh/package.json'))
    if (v) return v
  } catch { /* 继续 */ }
  // ② 按 Node 安装前缀推断，而不是写死某个版本号目录
  const prefix = path.resolve(path.dirname(process.execPath), '..')
  for (const rel of ['lib/node_modules', 'lib64/node_modules']) {
    const v = read(path.join(prefix, rel, '@deepseek-ai', 'dsh', 'package.json'))
    if (v) return v
  }
  return null
}

export default {
  name: 'dsh-agent-memory',
  // 刻意留空：不把任何服务作为硬依赖，缺了也不阻止 DSH 启动。
  inject: [],
  apply(ctx, rawConfig = {}) {
    // 通用默认值：不写死任何人的绝对路径（本机实例的路径在 profile patch 里覆盖）
    const dshHome = rawConfig.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const config = {
      storeRoot: rawConfig.storeRoot || path.join(dshHome, 'agent-memory'),
      dshHome,
      routePrefix: rawConfig.routePrefix || '/dsh-agent-memory',
      breakerThreshold: rawConfig.breakerThreshold || 5,
      allowUnfencedPanel: rawConfig.allowUnfencedPanel === true,
      agentsWarnBytes: rawConfig.agentsWarnBytes || 20000,
      pluginVersion: PLUGIN_VERSION,
      dshVersion: detectDshVersion(),
    }

    const status = createStatus({
      breakerThreshold: config.breakerThreshold,
    })
    status.cap('plugin', 'ok', `v${PLUGIN_VERSION} 已加载（DSH ${config.dshVersion ?? '版本未知'}）`)

    // 采集：只依赖核心的 ctx.on，探到就挂，探不到记为 unavailable。
    try {
      attachCollector(ctx, status, config)
    } catch (err) {
      status.recordError('collector', err)
      status.cap('collector', 'unavailable', String(err?.message ?? err))
    }

    // 面板：webServer/connection 是可选依赖，用 ctx.inject 等它们就绪；
    // 拿不到时不报错、只在状态里标注 —— 这就是"缺服务也能活"的实现方式。
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer', 'connection'], (scoped) => {
          try { attachPanel(scoped, status, config) }
          catch (err) { status.recordError('panel', err); status.cap('panel', 'unavailable', String(err?.message ?? err)) }
        })
        status.cap('panel', 'pending', '等待 webServer/connection 就绪')
      } else {
        status.cap('panel', 'unavailable', 'ctx.inject 不可用（DSH 接口变化）')
      }
    } catch (err) {
      status.recordError('panel.attach', err)
      status.cap('panel', 'unavailable', String(err?.message ?? err))
    }

    // 预留给 P1/P2：工具与兜底注入
    status.cap('tools', 'pending', 'P1 未实现（当前用 memory-note.py 等 CLI）')
    status.cap('injectFallback', 'disabled', '默认关闭；注入由官方 agent-instructions 负责')

    try { ctx.set?.('agentMemoryStatus', status) } catch { /* 可选服务，失败无妨 */ }
    try { console.log(`[dsh-agent-memory] v${PLUGIN_VERSION} 已加载：storeRoot=${config.storeRoot}`) } catch { /* ignore */ }
  },
}
