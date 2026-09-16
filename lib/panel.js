/**
 * 可视化面板：自包含 HTML + 机器可读 JSON + 只读数据浏览，挂在 `ctx.webServer` 上。
 *
 * 安全：面板会显示记忆库内容，绝不能对外裸奔 —— 所有路由（含数据接口）都先过 DSH 的
 * 浏览器信任栅栏 `connection.requestRejection(req)`；栅栏不可用时**默认 fail-closed**。
 * 数据接口只暴露白名单里的几类文件，不可用它读任意路径。
 *
 * UI：对齐 DSH 界面（dsh-context 那套）—— 卡片 + 统计磁贴 + 状态圆点 + 进度条，
 * 明暗双主题。统计磁贴与记忆库条目都可点开，弹层里看到**实际存了什么**。
 *
 * 兼容：不参与 web 构建管线、不引前端依赖，只发内联 HTML + 读文件的 JSON。
 */
import fs from 'node:fs'
import path from 'node:path'
import { collectStoreStats } from './status.js'

const MAX_ITEMS = 200          // 弹层最多展示多少条
const MAX_READ_BYTES = 768 * 1024

const STYLE = `
  html[data-theme="light"]{
    color-scheme:light;
    --bg:#f5f6f7; --card:#ffffff; --card-2:#fafbfb; --text:#0f1115; --muted:#61666b;
    --faint:#81858c; --border:rgba(0,0,0,.10); --border-2:rgba(0,0,0,.06);
    --accent:#3b82f6; --ok:#22c55e; --warn:#f59e0b; --bad:#e5484d;
    --shadow:0 1px 2px rgba(0,0,0,.04); --modal-shadow:0 12px 40px rgba(0,0,0,.18);
    --code-bg:#0f1115; --code-fg:#e6e8eb;
  }
  html[data-theme="dark"]{
    color-scheme:dark;
    --bg:#151517; --card:#1c1c1f; --card-2:#202024; --text:#f9fafb; --muted:#cfd3d6;
    --faint:#adb2b8; --border:rgba(255,255,255,.12); --border-2:rgba(255,255,255,.07);
    --accent:#5b9dff; --ok:#3ddc84; --warn:#ffb020; --bad:#ff6b6b;
    --shadow:0 1px 2px rgba(0,0,0,.3); --modal-shadow:0 12px 40px rgba(0,0,0,.5);
    --code-bg:#0b0b0d; --code-fg:#e6e8eb;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font:13px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{padding:16px 18px 26px;max-width:1200px}
  .head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}
  .head h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}
  .head .right{display:flex;align-items:center;gap:10px;color:var(--faint);font-size:12px}
  .btn{appearance:none;border:1px solid var(--border);background:var(--card);color:var(--text);
    border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;box-shadow:var(--shadow)}
  .btn:hover{background:var(--card-2)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:10px;
    padding:14px 16px;box-shadow:var(--shadow)}
  .card.wide{grid-column:1/-1}
  .card h2{margin:0 0 12px;font-size:12px;font-weight:600;color:var(--muted);display:flex;
    justify-content:space-between;align-items:center;gap:10px}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px}
  .tile{border:1px solid var(--border-2);border-radius:8px;padding:8px 10px;background:var(--card-2);
    text-align:left;font:inherit;color:inherit;cursor:pointer;width:100%}
  .tile:hover{border-color:var(--accent)}
  .tile:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .tile .k{color:var(--faint);font-size:11px;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tile .v{font-size:18px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
  .rows{display:flex;flex-direction:column}
  .row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;
    padding:6px 4px;border-bottom:1px solid var(--border-2);background:none;border-left:0;
    border-right:0;border-top:0;font:inherit;color:inherit;text-align:left;width:100%}
  .row.click{cursor:pointer}
  .row.click:hover{background:var(--card-2)}
  .row.click:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .row:last-child{border-bottom:0}
  .row .k{color:var(--muted);font-size:12px;white-space:nowrap}
  .row .v{font-variant-numeric:tabular-nums;text-align:right;word-break:break-all}
  .cap{display:flex;gap:9px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border-2)}
  .cap:last-child{border-bottom:0}
  .dot{width:8px;height:8px;border-radius:50%;margin-top:5px;flex:0 0 auto;background:var(--faint)}
  .cap.ok .dot{background:var(--ok)} .cap.warn .dot{background:var(--warn)}
  .cap.bad .dot{background:var(--bad)}
  .cap .name{font-weight:600}
  .cap .st{color:var(--faint);font-size:11px;margin-left:6px}
  .detail{color:var(--faint);font-size:11.5px;word-break:break-all}
  .bar{height:10px;border-radius:6px;background:var(--card-2);border:1px solid var(--border-2);
    overflow:hidden;margin:2px 0 8px}
  .bar > i{display:block;height:100%;background:var(--accent)}
  .bar.warn > i{background:var(--warn)} .bar.bad > i{background:var(--bad)}
  .legend{display:flex;flex-wrap:wrap;gap:6px 16px;color:var(--muted);font-size:12px}
  .legend span{display:inline-flex;align-items:center;gap:6px}
  .legend i{width:8px;height:8px;border-radius:2px;display:inline-block}
  pre{background:var(--code-bg);color:var(--code-fg);border-radius:8px;padding:12px 14px;
    overflow:auto;font-size:12px;line-height:1.75;margin:0;white-space:pre-wrap;word-break:break-word;
    font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .muted{color:var(--faint)}
  .hint{color:var(--faint);font-size:11px;margin-top:8px}
  /* 详情弹层 */
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.34);display:flex;
    align-items:center;justify-content:center;padding:24px;z-index:50}
  .overlay[hidden]{display:none}
  .modal{background:var(--card);border:1px solid var(--border);border-radius:12px;
    box-shadow:var(--modal-shadow);width:min(920px,100%);max-height:82vh;display:flex;flex-direction:column}
  .mhead{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border-2)}
  .mhead strong{font-size:13px;font-weight:600}
  .mhead .sp{flex:1}
  .mbody{padding:12px 16px 18px;overflow:auto}
  .item{padding:8px 0;border-bottom:1px solid var(--border-2)}
  .item:last-child{border-bottom:0}
  .item .meta{color:var(--faint);font-size:11px;margin-bottom:3px;font-variant-numeric:tabular-nums}
  .item .text{white-space:pre-wrap;word-break:break-word}
`

const DATA_KINDS = [
  { id: 'human', title: '证据库 · 人类用户消息', file: (c) => path.join(c.storeRoot, 'evidence', 'user-messages.jsonl'), format: 'jsonl' },
  { id: 'live', title: '插件实时采集（尚未归并）', file: (c) => path.join(c.storeRoot, 'evidence', 'live-messages.jsonl'), format: 'jsonl' },
  { id: 'signals', title: '偏好信号（待沉淀候选）', file: (c) => path.join(c.storeRoot, 'evidence', 'signals.jsonl'), format: 'jsonl' },
  { id: 'preferences', title: '全局记忆 preferences/global.md（每个会话都注入）', file: (c) => globalPrefFile(c.storeRoot), format: 'text' },
  { id: 'sessionIndex', title: '对话记忆索引 sessions/index.json', file: (c) => path.join(c.storeRoot, 'sessions', 'index.json'), format: 'text' },
  { id: 'archive', title: '归档台账（原始消息只留工作集，原文可重建）', file: (c) => path.join(c.storeRoot, 'evidence', 'archive.jsonl'), format: 'jsonl' },
  { id: 'prefEvidence', title: '偏好 · 证据明细（不注入，可追溯每条依据）', file: (c) => path.join(c.storeRoot, 'preferences', 'evidence.md'), format: 'text' },
  { id: 'digest', title: '记忆摘要 digest.md', file: (c) => path.join(c.storeRoot, 'digest.md'), format: 'text' },
  { id: 'agents', title: '自动注入体 $DSH_HOME/AGENTS.md', file: (c) => (c.dshHome ? path.join(c.dshHome, 'AGENTS.md') : null), format: 'text' },
  { id: 'skills', title: '技能库', file: (c) => path.join(c.storeRoot, 'skills', 'index.md'), format: 'skills' },
  { id: 'journal', title: '记忆库日志', file: (c) => latestFile(path.join(c.storeRoot, 'journal')), format: 'text' },
]

function globalPrefFile(storeRoot) {
  const g = path.join(storeRoot, 'preferences', 'global.md')
  if (fs.existsSync(g)) return g
  return path.join(storeRoot, 'preferences', 'merlin.md')
}

function latestFile(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    return files.length ? path.join(dir, files[files.length - 1]) : null
  } catch { return null }
}

function readCapped(file, maxBytes = MAX_READ_BYTES) {
  try {
    const st = fs.statSync(file)
    const fd = fs.openSync(file, 'r')
    try {
      const len = Math.min(st.size, maxBytes)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len))
      return { text: buf.toString('utf8'), bytes: st.size, truncated: st.size > maxBytes, mtime: st.mtimeMs }
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

function readJsonlTail(file) {
  const got = readCapped(file)
  if (!got) return null
  const lines = got.text.split('\n').filter((l) => l.trim())
  let total = lines.length
  if (got.truncated) {
    // 被截断时总数不准，只报"至少"
    total = lines.length
  }
  return { lines, total, bytes: got.bytes, truncated: got.truncated, mtime: got.mtime }
}

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,96}$/

/** 剥掉会话文件开头的 YAML frontmatter（在服务端做，前端不碰正则）。 */
function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  return end === -1 ? text : text.slice(end + 4).replace(/^\n/, '')
}

function buildSessionData(config, sid) {
  if (!sid || !SESSION_ID_RE.test(sid) || sid.includes('..')) {
    return { kind: 'session', title: '本对话记忆', error: '缺少或非法的会话 id' }
  }
  const file = path.join(config.storeRoot, 'sessions', `${sid}.md`)
  const got = readCapped(file)
  if (!got) {
    return { kind: 'session', title: '本对话记忆', session: sid, path: file,
      error: '这个对话还没有专属记忆（用 memory-note.py --scope session 记一条）' }
  }
  return { kind: 'session', title: '本对话记忆', session: sid, path: file,
    bytes: got.bytes, mtime: got.mtime, overBudget: got.bytes > (config.sessionInjectMax || 2048),
    text: stripFrontmatter(got.text) }
}

function buildData(kind, config) {
  const spec = DATA_KINDS.find((k) => k.id === kind)
  if (!spec) return null
  const file = spec.file(config)
  if (!file) return { kind, title: spec.title, error: '该项在当前配置下不可用' }

  if (spec.format === 'skills') {
    const idx = readCapped(file)
    let files = []
    try {
      files = fs.readdirSync(path.dirname(file))
        .filter((f) => f.endsWith('.md') && f !== 'index.md')
        .sort()
        .map((f) => {
          let bytes = null
          try { bytes = fs.statSync(path.join(path.dirname(file), f)).size } catch { /* ignore */ }
          return { name: f, bytes }
        })
    } catch { /* ignore */ }
    return { kind, title: spec.title, path: file, bytes: idx?.bytes ?? null,
      text: idx?.text ?? '（尚未建立）', files }
  }

  if (spec.format === 'text') {
    const got = readCapped(file)
    if (!got) return { kind, title: spec.title, path: file, error: '文件不存在' }
    return { kind, title: spec.title, path: file, bytes: got.bytes,
      mtime: got.mtime, truncated: got.truncated, text: got.text }
  }

  const got = readJsonlTail(file)
  if (!got) return { kind, title: spec.title, path: file, error: '文件不存在（还没有数据）' }
  const parsed = []
  for (const line of got.lines) {
    try { parsed.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
  }
  const items = parsed.slice(-MAX_ITEMS).reverse().map((r) => ({
    when: r.when || (r.ts ? new Date(r.ts).toLocaleString() : ''),
    session: r.session || '',
    seq: r.seq ?? null,
    text: r.text || '',
  }))
  return { kind, title: spec.title, path: file, bytes: got.bytes, mtime: got.mtime,
    total: got.total, shown: items.length, truncated: got.truncated, items }
}

const HTML = (prefix, storeRoot, sessionId) => {
  // 命令块按实际 storeRoot 推导，避免把某台机器的绝对路径写进包里
  const BIN = path.join(storeRoot, 'bin')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent 记忆 · 工作状态</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <h1>Agent 长期记忆 · 工作状态</h1>
    <div class="right">
      <span id="stamp">—</span>
      <button class="btn" id="refresh" type="button">刷新</button>
    </div>
  </div>
  <div class="grid">
    <div class="card">
      <h2>存储工作集 <span class="muted" style="font-weight:400">原始消息只在未沉淀期间保留 · 点方块看内容</span></h2>
      <div class="tiles" id="tiles"></div>
    </div>
    <div class="card">
      <h2>插件信息</h2>
      <div class="rows" id="pluginRows"></div>
    </div>
    <div class="card">
      <h2>能力探测</h2>
      <div id="caps"></div>
    </div>
    <div class="card">
      <h2>本对话记忆 <span class="muted" id="sessLabel">只注入这个会话</span></h2>
      <div id="sessionBody" class="muted">加载中…</div>
    </div>
    <div class="card">
      <h2>记忆库 <span class="muted" style="font-weight:400">点条目看内容</span></h2>
      <div class="rows" id="storeRows"></div>
    </div>
    <div class="card wide">
      <h2><span>注入体预算</span><span class="muted" id="budgetText">—</span></h2>
      <div class="bar" id="budgetBar"><i style="width:0%"></i></div>
      <div class="legend" id="budgetLegend"></div>
      <div class="hint">注入体 = 每个会话首次请求都会带上的内容，越大越贵。点此 <button class="btn" data-kind="agents" style="padding:2px 8px">查看注入全文</button></div>
    </div>
    <div class="card wide">
      <h2>运行计数</h2>
      <div class="tiles" id="counterTiles"></div>
    </div>
    <div class="card wide">
      <h2><span>最近错误</span><span class="muted" id="errCount">—</span></h2>
      <div id="errors" class="muted">—</div>
    </div>
    <div class="card wide">
      <h2>常用命令</h2>
      <pre>python3 ${BIN}/memory-note.py "一句话偏好" --section "做事方式"
python3 ${BIN}/memory-scan.py
python3 ${BIN}/memory-scan.py --mark-distilled
systemctl list-timers dsh-agent-memory.timer</pre>
    </div>
  </div>
</div>

<div class="overlay" id="overlay" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="mTitle">
    <div class="mhead">
      <strong id="mTitle">—</strong>
      <span class="muted" id="mMeta"></span>
      <span class="sp"></span>
      <button class="btn" id="mClose" type="button">关闭</button>
    </div>
    <div class="mbody" id="mBody"></div>
  </div>
</div>

<script>
(function(){
  var P = ${JSON.stringify(prefix)};
  var SID = ${JSON.stringify(sessionId || '')};
  var KINDS = ${JSON.stringify(Object.fromEntries(DATA_KINDS.map((k) => [k.id, k.title])))};

  try {
    var q = new URLSearchParams(location.search).get('theme');
    if (q !== 'light' && q !== 'dark') {
      q = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', q);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }

  var $ = function(id){ return document.getElementById(id); };
  function esc(v){
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function dash(v){ return (v === null || v === undefined || v === '') ? '<span class="muted">—</span>' : esc(v); }
  function bytes(n){
    if (n === null || n === undefined) return null;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }
  function tiles(id, pairs){
    $(id).innerHTML = pairs.map(function(p){
      var kind = p[2] || '';
      var tag = kind ? 'button' : 'div';
      var attrs = kind ? ' type="button" class="tile" data-kind="' + kind + '"' : ' class="tile"';
      return '<' + tag + attrs + '><div class="k">' + esc(p[0]) + '</div><div class="v">' + dash(p[1]) + '</div></' + tag + '>';
    }).join('');
  }
  function rows(id, pairs){
    $(id).innerHTML = pairs.map(function(p){
      var kind = p[2] || '';
      var tag = kind ? 'button' : 'div';
      var attrs = kind ? ' type="button" class="row click" data-kind="' + kind + '"' : ' class="row"';
      return '<' + tag + attrs + '><span class="k">' + esc(p[0]) + '</span><span class="v">' + dash(p[1]) + '</span></' + tag + '>';
    }).join('');
  }
  function stamp(ms){
    if (!ms) return '—';
    try { return new Date(ms).toLocaleTimeString(); } catch (e) { return '—'; }
  }
  function dur(ms){
    var s = Math.round((ms || 0) / 1000);
    if (s < 60) return s + ' 秒';
    if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(s / 3600) + ' 时 ' + Math.floor((s % 3600) / 60) + ' 分';
  }

  /* ---------- 详情弹层 ---------- */
  function closeModal(){ $('overlay').hidden = true; $('mBody').innerHTML = ''; }
  function openModal(kind){
    $('overlay').hidden = false;
    $('mTitle').textContent = KINDS[kind] || kind;
    $('mMeta').textContent = '读取中…';
    $('mBody').innerHTML = '<div class="muted">加载中…</div>';
    fetch(P + '/data/' + encodeURIComponent(kind), { cache: 'no-store' })
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(d){
        var meta = [];
        if (d.total != null) meta.push('共 ' + d.total + ' 条');
        if (d.shown != null && d.shown !== d.total) meta.push('显示最近 ' + d.shown + ' 条');
        if (d.files) meta.push(d.files.length + ' 个技能文件');
        if (d.bytes != null) meta.push(bytes(d.bytes));
        if (d.truncated) meta.push('文件过大，仅读末尾');
        if (d.mtime) meta.push(new Date(d.mtime).toLocaleString());
        $('mMeta').textContent = meta.join(' · ');
        $('mBody').innerHTML = renderData(d);
      })
      .catch(function(e){
        $('mMeta').textContent = '';
        $('mBody').innerHTML = '<div style="color:var(--bad)">加载失败：' + esc(e && e.message || e) + '</div>';
      });
  }
  function renderData(d){
    if (d.error) return '<div class="muted">' + esc(d.error) + '</div>';
    if (d.items) {
      if (!d.items.length) return '<div class="muted">（暂无记录）</div>';
      return d.items.map(function(it){
        var m = [];
        if (it.when) m.push(it.when);
        if (it.session) m.push(it.session.slice(0, 20));
        if (it.seq != null) m.push('seq ' + it.seq);
        return '<div class="item"><div class="meta">' + esc(m.join(' · ')) + '</div>' +
               '<div class="text">' + esc(it.text) + '</div></div>';
      }).join('');
    }
    var head = d.path ? '<div class="muted" style="margin-bottom:8px">' + esc(d.path) + '</div>' : '';
    var skills = '';
    if (d.files && d.files.length) {
      skills = '<div class="rows" style="margin-bottom:12px">' + d.files.map(function(f){
        return '<div class="row"><span class="k">' + esc(f.name) + '</span><span class="v">' + dash(bytes(f.bytes)) + '</span></div>';
      }).join('') + '</div>';
    }
    return head + skills + '<pre>' + esc(d.text || '（空）') + '</pre>';
  }
  document.addEventListener('click', function(ev){
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-kind]') : null;
    if (el) { openModal(el.getAttribute('data-kind')); return; }
    if (ev.target && ev.target.id === 'overlay') closeModal();
  });
  $('mClose').addEventListener('click', closeModal);
  document.addEventListener('keydown', function(ev){ if (ev.key === 'Escape') closeModal(); });

  /* ---------- 主渲染 ---------- */
  function render(s){
    var rt = (s && s.runtime) || {};
    var st = (s && s.store) || {};
    var env = (s && s.env) || {};
    var plugin = (s && s.plugin) || {};
    var c = rt.counters || {};
    var lt = rt.lastEventAt;

    $('stamp').textContent = '最后事件 ' + stamp(lt) + ' · 每 5 秒自动刷新';
    tiles('tiles', [
      ['实时未归并', st.liveMessages, 'live'],
      ['待归纳消息', st.evidenceMessages, 'human'],
      ['偏好信号', st.signalsTotal, 'signals'],
      ['已归档', st.archived, 'archive']
    ]);
    rows('pluginRows', [
      ['插件版本', (plugin.name || 'dsh-agent-memory') + ' v' + (plugin.version || '—')],
      ['DSH 版本', env.dsh || '未探测到'],
      ['Node', env.node],
      ['已运行', dur(rt.uptimeMs)],
      ['最后事件', stamp(lt)]
    ]);
    var caps = rt.capabilities || [];
    $('caps').innerHTML = caps.map(function(x){
      var cls = x.state === 'ok' ? 'ok' : (x.state === 'tripped' ? 'bad' : 'warn');
      return '<div class="cap ' + cls + '"><span class="dot"></span><div>' +
        '<span class="name">' + esc(x.name) + '</span><span class="st">' + esc(x.state) + '</span>' +
        '<div class="detail">' + esc(x.detail || '') + '</div></div></div>';
    }).join('') || '<div class="muted">（无）</div>';

    var pref = st.preferencesLines != null
      ? st.preferencesLines + ' 行 · ' + bytes(st.preferencesBytes) : null;
    rows('storeRows', [
      ['偏好文件', pref, 'preferences'],
      ['技能数', st.skills, 'skills'],
      ['AGENTS.md', bytes(st.agentsMdBytes), 'agents'],
      ['归档台账', (st.archiveEvents ? st.archiveEvents + ' 次 / ' + (st.archived || 0) + ' 条' : '暂无'), 'archive'],
      ['偏好证据明细', '不注入', 'prefEvidence'],
      ['记忆摘要', 'digest.md', 'digest'],
      ['记忆库日志', 'journal', 'journal'],
      ['记忆库路径', st.storeRoot]
    ]);
    var used = st.agentsMdBytes || 0;
    var limit = env.agentsWarnBytes || 20000;
    var pct = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0;
    $('budgetBar').className = pct >= 100 ? 'bar bad' : (pct >= 80 ? 'bar warn' : 'bar');
    $('budgetBar').firstElementChild.style.width = pct + '%';
    $('budgetText').textContent = bytes(used) + ' / ' + bytes(limit) + '（' + pct + '%）';
    $('budgetLegend').innerHTML =
      '<span><i style="background:var(--accent)"></i>已用 ' + bytes(used) + '</span>' +
      '<span><i style="background:var(--border)"></i>剩余 ' + bytes(Math.max(0, limit - used)) + '</span>';
    tiles('counterTiles', [
      ['事件', c.events], ['人类消息', c.messages], ['写盘', c.writes],
      ['错误', c.errors], ['面板请求', c.statusRequests]
    ]);
    var errs = rt.recentErrors || [];
    $('errCount').textContent = errs.length ? errs.length + ' 条' : '无 ✅';
    $('errors').innerHTML = errs.length
      ? '<pre>' + errs.map(function(e){
          return esc(stamp(e.at) + '  [' + (e.where || '') + ']  ' + (e.message || ''));
        }).join('\\n') + '</pre>'
      : '<span class="muted">无 ✅</span>';
  }
  function renderSession(){
    var sid = SID;
    var el = $('sessionBody');
    if (!sid) { el.innerHTML = '<span class="muted">未识别到当前会话（从会话头部「记忆」页签打开可自动识别）</span>'; return; }
    $('sessLabel').textContent = sid.slice(0, 18) + '… 只注入这个会话';
    fetch(P + '/data/session?id=' + encodeURIComponent(sid), { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.error) { el.innerHTML = '<span class="muted">' + esc(d.error) + '</span>'; return; }
        el.innerHTML = '<div class="muted" style="margin-bottom:8px">' + esc(bytes(d.bytes)) +
          (d.overBudget ? ' <span style="color:var(--warn)">· 超注入预算，会被截断</span>' : '') +
          '</div><pre>' + esc(String(d.text || '')) + '</pre>';
      })
      .catch(function(e){ el.innerHTML = '<span style="color:var(--bad)">' + esc(String(e)) + '</span>'; });
  }
  function tick(){
    fetch(P + '/status.json', { cache: 'no-store' }).then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(render).catch(function(e){
      $('stamp').innerHTML = '<span style="color:var(--bad)">面板取值失败：' + esc(e && e.message || e) + '</span>';
    });
  }
  $('refresh').addEventListener('click', tick);
  tick();
  renderSession();
  setInterval(tick, 5000);
  setInterval(renderSession, 10000);
})();
</script>
</body></html>`
}

export function attachPanel(ctx, status, config) {
  let webServer = null
  try {
    webServer = (typeof ctx.get === 'function' ? ctx.get('webServer') : null) || ctx.webServer || null
  } catch { /* ignore */ }

  if (!webServer || typeof webServer.register !== 'function') {
    status.cap('panel', 'unavailable', 'webServer.register 不可用（DSH 接口变化或非 web 环境）')
    return
  }

  const prefix = config.routePrefix || '/dsh-agent-memory'
  const allowUnfenced = config.allowUnfencedPanel === true

  /** 信任栅栏：默认 fail-closed，宁可不给看，也不裸奔。 */
  function rejected(req, res) {
    try {
      const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : null) || ctx.connection
      if (!conn || typeof conn.requestRejection !== 'function') return !allowUnfenced
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      return !allowUnfenced
    }
  }

  const register = status.safe('panel', (route) => {
    const inner = route.handler
    const wrapped = {
      ...route,
      handler: async (req, res) => {
        if (rejected(req, res)) {
          try {
            if (!res.writableEnded) {
              res.statusCode = res.statusCode >= 400 ? res.statusCode : 403
              res.setHeader?.('content-type', 'text/plain; charset=utf-8')
              res.end('trust fence unavailable: panel is fail-closed')
            }
          } catch { /* ignore */ }
          return
        }
        try { await inner(req, res) } catch (err) {
          status.recordError('panel.handler', err)
          try { res.statusCode = 500; res.end('panel error') } catch { /* ignore */ }
        }
      },
    }
    return webServer.register(wrapped)
  })

  const send = (res, code, type, body) => {
    res.statusCode = code
    res.setHeader?.('content-type', type)
    res.setHeader?.('cache-control', 'no-store')
    res.end(body)
  }

  try {
    register({
      kind: 'exact',
      path: `${prefix}/status.json`,
      handler: (req, res) => {
        status.count('statusRequests')
        const payload = {
          plugin: { name: 'dsh-agent-memory', version: config.pluginVersion || '0.1.0' },
          runtime: status.snapshot(),
          store: collectStoreStats(config.storeRoot, config.dshHome),
          env: {
            node: process.version,
            dsh: config.dshVersion || null,
            dshHome: config.dshHome || null,
            storeRoot: config.storeRoot,
            agentsWarnBytes: config.agentsWarnBytes || 20000,
          },
        }
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(payload, null, 2))
      },
    })

    // 只读数据接口：白名单种类，逐条注册成固定路径（不依赖路由参数 API）
    for (const spec of DATA_KINDS) {
      register({
        kind: 'exact',
        path: `${prefix}/data/${spec.id}`,
        handler: (req, res) => {
          let data = null
          try { data = buildData(spec.id, config) } catch (err) {
            status.recordError('panel.data', err)
            send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: String(err?.message ?? err) }))
            return
          }
          if (!data) {
            send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'unknown kind' }))
            return
          }
          send(res, 200, 'application/json; charset=utf-8', JSON.stringify(data))
        },
      })
    }

    register({
      kind: 'exact',
      path: `${prefix}/data/session`,
      handler: (req, res) => {
        let sid = ''
        try {
          sid = new URL(req.url || '/', 'http://localhost').searchParams.get('id') || ''
        } catch { /* ignore */ }
        let data = null
        try { data = buildSessionData(config, sid) } catch (err) {
          status.recordError('panel.data', err)
          send(res, 500, 'application/json; charset=utf-8',
               JSON.stringify({ error: String(err?.message ?? err) }))
          return
        }
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(data))
      },
    })

    register({
      kind: 'exact',
      path: `${prefix}/panel`,
      handler: (req, res) => {
        let sid = ''
        try {
          sid = new URL(req.url || '/', 'http://localhost').searchParams.get('session') || ''
        } catch { /* ignore */ }
        send(res, 200, 'text/html; charset=utf-8', HTML(prefix, config.storeRoot, sid))
      },
    })
    status.cap('panel', 'ok',
      `已注册 ${prefix}/panel、/status.json 与 ${DATA_KINDS.length} 个只读数据接口`)
  } catch (err) {
    status.recordError('panel.register', err)
    status.cap('panel', 'unavailable', `注册失败：${err?.message ?? err}`)
  }
}
