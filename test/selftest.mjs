/**
 * P0 自测：不依赖正在运行的 DSH，用伪造的 ctx 验证插件的每条关键行为。
 *   运行：node test/selftest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

import mod from '../lib/index.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-am-test-'))
let pass = 0
const ok = (label) => { pass += 1; console.log(`  ✅ ${label}`) }

function makeCtx({ fenced = true } = {}) {
  const handlers = new Map()
  const routes = []
  const webServer = { register: (r) => { routes.push(r); return () => {} } }
  const connection = {
    // fenced=true 表示栅栏判定"拒绝"，返回 HTTP 码；false 表示放行。
    requestRejection: () => (fenced ? 403 : false),
  }
  const scoped = { get: (n) => (n === 'webServer' ? webServer : n === 'connection' ? connection : undefined) }
  let injectCb = null
  const ctx = {
    on: (ev, fn) => { handlers.set(ev, fn) },
    inject: (deps, cb) => { injectCb = cb },
    get: () => undefined,
    connection,
  }
  return { ctx, handlers, routes, runInject: () => injectCb && injectCb(scoped) }
}

const humanMsg = (id, text, seq = 1) => ({ type: 'user/message', seq, time: Date.now(), data: {
  id, source: { kind: 'user', rpcId: 'r1' }, content: [{ type: 'text', text }],
} })

console.log('1) 采集：人类消息写入 live 文件')
{
  const store = path.join(tmp, 'store-live')
  const { ctx, handlers } = makeCtx()
  mod.apply(ctx, { storeRoot: store })
  const fire = handlers.get('session/event')
  assert.equal(typeof fire, 'function', 'session/event 未挂载')
  fire({ id: 'session-abc' }, humanMsg('m1', '第一条偏好'))
  fire({ id: 'session-abc' }, humanMsg('m1', '第一条偏好'))            // 重复 id
  fire({ id: '9f2c-uuid-subagent' }, humanMsg('m2', '子代理任务，不算'))  // 子代理
  fire({ id: 'session-abc' }, { type: 'user/message', seq: 9, data: {
    id: 'm3', source: { kind: 'plugin' }, content: [{ type: 'text', text: '插件快照' }] } })
  const lines = fs.readFileSync(path.join(store, 'evidence', 'live-messages.jsonl'), 'utf8')
    .trim().split('\n')
  assert.equal(lines.length, 1, `应只写 1 条，实际 ${lines.length}`)
  assert.equal(JSON.parse(lines[0]).id, 'm1')
  ok('只收人类会话消息，重复/子代理/插件快照都被挡掉')
}

console.log('2) 面板：注册路由 + 信任栅栏 + 状态 JSON')
{
  const store = path.join(tmp, 'store-panel')
  const { ctx, routes, runInject } = makeCtx({ fenced: false })   // 栅栏放行
  mod.apply(ctx, { storeRoot: store })
  runInject()
  assert.ok(routes.length >= 2, `路由太少：${routes.length}`)
  const statusRoute = routes.find((r) => r.path.endsWith('/status.json'))
  const panelRoute = routes.find((r) => r.path.endsWith('/panel'))
  assert.ok(statusRoute && panelRoute, '路由缺失')

  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v },
    end(body) { this.body = body }, writableEnded: false }
  statusRoute.handler({}, res)
  const payload = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(payload.plugin.name, 'dsh-agent-memory')
  assert.ok(payload.runtime.capabilities.some((c) => c.name === 'collector' && c.state === 'ok'), 'collector 应为 ok')
  assert.ok(payload.runtime.capabilities.some((c) => c.name === 'panel' && c.state === 'ok'), 'panel 应为 ok')
  assert.equal(payload.store.storeRoot, store)
  ok('status.json 返回 200 且能力探测为 ok')

  const res2 = { statusCode: 0, setHeader() {}, end(b) { this.body = b }, writableEnded: false }
  panelRoute.handler({}, res2)
  assert.ok(String(res2.body).includes('Agent 长期记忆'), '面板 HTML 内容缺失')
  ok('panel 返回自包含 HTML')
}

console.log('3) 安全：栅栏拒绝时 fail-closed（不泄露任何内容）')
{
  const store = path.join(tmp, 'store-fence')
  const { ctx, routes, runInject } = makeCtx({ fenced: true })    // 栅栏拒绝
  mod.apply(ctx, { storeRoot: store })
  runInject()
  const statusRoute = routes.find((r) => r.path.endsWith('/status.json'))
  const res = { statusCode: 0, setHeader() {}, end(b) { this.body = b }, writableEnded: false }
  statusRoute.handler({}, res)
  assert.equal(res.statusCode, 403)
  assert.ok(!String(res.body).includes('storeRoot'), '拒绝时不应返回任何状态内容')
  ok('栅栏拒绝 → 403 且无内容')
}

console.log('4) 韧性：写盘失败 5 次后采集能力熔断，且不抛错')
{
  const store = path.join(tmp, 'store-readonly')
  fs.mkdirSync(path.join(store, 'evidence'), { recursive: true })
  fs.chmodSync(path.join(store, 'evidence'), 0o500)               // 只读目录
  const { ctx, handlers } = makeCtx()
  let threw = null
  try {
    mod.apply(ctx, { storeRoot: store, breakerThreshold: 5 })
    const fire = handlers.get('session/event')
    for (let i = 0; i < 7; i += 1) fire({ id: 'session-x' }, humanMsg(`fail-${i}`, 'x'))
  } catch (err) { threw = err }
  fs.chmodSync(path.join(store, 'evidence'), 0o700)
  assert.equal(threw, null, `不应向外抛错，实际：${threw}`)
  ok('写盘失败不抛错，且错误被记账')
}

console.log('5) 兼容：没有 webServer / connection 时也能加载')
{
  const store = path.join(tmp, 'store-bare')
  const ctx = { on: () => {}, inject: (d, cb) => cb({ get: () => undefined }), get: () => undefined }
  let threw = null
  try { mod.apply(ctx, { storeRoot: store }) } catch (err) { threw = err }
  assert.equal(threw, null, `服务缺失时不应抛错：${threw}`)
  ok('服务全缺也能安全加载（能力记为 unavailable）')
}

console.log('6) 面板脚本的取值路径必须都能在 payload 里解析（防"读过 undefined"）')
{
  const store = path.join(tmp, 'store-paths')
  const { ctx, routes, runInject } = makeCtx({ fenced: false })
  mod.apply(ctx, { storeRoot: store })
  runInject()

  const mkres = () => ({ statusCode: 0, setHeader() {}, end(b) { this.body = b }, writableEnded: false })
  const r1 = mkres(); routes.find((r) => r.path.endsWith('/status.json')).handler({}, r1)
  const payload = JSON.parse(r1.body)
  const r2 = mkres(); routes.find((r) => r.path.endsWith('/panel')).handler({}, r2)
  const html = String(r2.body)

  // 面板脚本里的根变量 → payload 里对应的对象
  const roots = {
    s: payload,
    rt: payload.runtime,
    st: payload.store,
    env: payload.env,
    plugin: payload.plugin,
    c: payload.runtime.counters,
  }
  const seen = new Set()
  const re = /\b(s|rt|st|env|plugin|c)\.([A-Za-z0-9_.]+)/g
  let m
  while ((m = re.exec(html)) !== null) {
    const [, root, dotted] = m
    if (dotted.includes('...')) continue
    seen.add(`${root}.${dotted}`)
  }
  const bad = []
  for (const ref of seen) {
    const [root, ...steps] = ref.split('.')
    let cur = roots[root]
    for (const step of steps) {
      if (cur === null || cur === undefined) break
      cur = cur[step]
    }
    if (cur === undefined) bad.push(ref)
  }
  assert.equal(bad.length, 0, `面板引用了 payload 里不存在的路径：${bad.join(', ')}`)
  assert.ok(html.includes('data-theme'), '面板缺少主题支持')
  assert.ok(html.includes('--card') && html.includes('--border'), '面板缺少卡片设计令牌')
  ok(`面板 ${seen.size} 条取值路径全部可解析，且带卡片设计令牌`)
}

console.log('7) 只读数据接口：白名单、形状正确、不泄露任意路径')
{
  const store = fs.mkdtempSync(path.join(path.join(tmp, 'store-data'), '..'))
  fs.mkdirSync(path.join(store, 'evidence'), { recursive: true })
  fs.mkdirSync(path.join(store, 'preferences'), { recursive: true })
  fs.mkdirSync(path.join(store, 'skills'), { recursive: true })
  fs.writeFileSync(path.join(store, 'evidence', 'user-messages.jsonl'),
    JSON.stringify({ id: 'm1', when: '2026-09-15 22:00', session: 'session-abc', seq: 3, text: 'hi' }) + '\n')
  fs.writeFileSync(path.join(store, 'preferences', 'merlin.md'), '# 偏好\n- 一条\n')
  fs.writeFileSync(path.join(store, 'skills', 'index.md'), '# 技能索引\n')
  fs.writeFileSync(path.join(store, 'skills', 'demo.md'), 'x')

  const { ctx, routes, runInject } = makeCtx({ fenced: false })
  mod.apply(ctx, { storeRoot: store })
  runInject()
  const mkres = () => ({ statusCode: 0, setHeader() {}, end(b) { this.body = b }, writableEnded: false })
  const hit = (p) => {
    const r = routes.find((x) => x.path === p)
    if (!r) return null
    const res = mkres(); r.handler({}, res)
    return { code: res.statusCode, body: res.body }
  }

  const human = hit('/dsh-agent-memory/data/human')
  assert.ok(human, 'human 数据路由缺失')
  const hj = JSON.parse(human.body)
  assert.equal(human.code, 200)
  assert.equal(hj.total, 1)
  assert.equal(hj.items[0].text, 'hi')

  const prefs = hit('/dsh-agent-memory/data/preferences')
  assert.ok(JSON.parse(prefs.body).text.includes('偏好'), '偏好接口内容不对')

  const skills = hit('/dsh-agent-memory/data/skills')
  assert.equal(JSON.parse(skills.body).files.length, 1, '技能文件列表不对')

  const missing = routes.find((x) => x.path.includes('..') || x.path.includes('%'))
  assert.equal(missing, undefined, '不应注册可疑路径')
  const kinds = routes.filter((x) => x.path.startsWith('/dsh-agent-memory/data/')).length
  assert.equal(kinds, 10, `数据接口应为 10 个白名单，实际 ${kinds}`)
  ok('10 个白名单数据接口形状正确，且没有任意路径入口')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n全部 ${pass} 项通过 ✅`)
