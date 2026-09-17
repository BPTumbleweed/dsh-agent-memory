#!/usr/bin/env python3
"""Incremental scanner that feeds the agent's own long-term memory.

It never edits `preferences/` or `skills/` itself — those are distilled by the
agent. This script's job is to keep the *raw material* complete and cheap to
read:

    sessions/*.jsonl.zstd  ──►  evidence/user-messages.jsonl   (append only)
                               evidence/signals.md             (regenerated)
                               evidence/tool-usage.json        (counters)
                               inbox/<stamp>-scan.md           (this run)
                               digest.md                       (session-start brief)
                               state.json                      (scan cursor)

It is idempotent and safe to run from a timer: a transcript is only re-read
when its size/mtime changed, and only events with `seq` greater than the last
recorded one are emitted. User messages are additionally de-duplicated by id,
so the dual-format sessions (v3 + legacy) cannot double-count.

Usage:
    python3 bin/memory-scan.py [--root DIR] [--dsh-home DIR] [--sessions DIR]
                               [--full] [--rebuild] [--mark-distilled] [--quiet]

记忆库根目录解析顺序：--root > $AGENT_MEMORY_ROOT > $DSH_HOME/agent-memory
DSH 主目录：          --dsh-home > $DSH_HOME > ~/.dsh
会话日志目录：        --sessions > $DSH_HOME/sessions/<按当前工作目录推断> 
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile

def _path_env(name: str, default: str) -> str:
    v = os.environ.get(name)
    return os.path.abspath(os.path.expanduser(v if v else default))


def _detect_store_from_script() -> str | None:
    """脚本被放在某个记忆库里（<store>/bin/xxx.py）时，默认就用那个库。

    这样"把 bin/ 放进自己的 store"和"从仓库直接跑"两种用法都成立：
    前者自动认路，后者回落到 $DSH_HOME/agent-memory。
    注意用 abspath 而不是 realpath —— 软链接也算"放在这个库里"。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    cand = os.path.dirname(here)
    if (os.path.isdir(os.path.join(cand, "preferences"))
            or os.path.isdir(os.path.join(cand, "evidence"))):
        return cand
    return None


DSH_HOME = _path_env("DSH_HOME", "~/.dsh")
# 记忆库根目录：--root > $AGENT_MEMORY_ROOT > 脚本所在库 > $DSH_HOME/agent-memory
_DETECTED = _detect_store_from_script()
MEM = _path_env("AGENT_MEMORY_ROOT", _DETECTED or os.path.join(DSH_HOME, "agent-memory"))
WS = os.path.dirname(MEM)
# DSH 每个项目一个会话目录，名字由项目 cwd 变形而来；configure() 里确定具体目录
SESS_ROOT = os.path.join(DSH_HOME, "sessions")

STATE = os.path.join(MEM, "state.json")
EVIDENCE = os.path.join(MEM, "evidence")
INBOX = os.path.join(MEM, "inbox")
MESSAGES = os.path.join(EVIDENCE, "user-messages.jsonl")
AGENT_PROMPTS = os.path.join(EVIDENCE, "agent-prompts.jsonl")
SIGNALS = os.path.join(EVIDENCE, "signals.md")
SIGNALS_JSONL = os.path.join(EVIDENCE, "signals.jsonl")
AGENTS_MD = os.path.join(DSH_HOME, "AGENTS.md")
TOOLUSE = os.path.join(EVIDENCE, "tool-usage.json")
DIGEST = os.path.join(MEM, "digest.md")

MAX_INBOX_FILES = 50
LIVE_KEEP = 200                # live 文件归并后最多保留多少行（防无界增长）
EVIDENCE_KEEP = 120            # 原始消息只留最近多少条（工作集，不是档案）
SIGNALS_KEEP = 100             # 偏好信号只留最近多少条
ARCHIVE = os.path.join(EVIDENCE, "archive.jsonl")
# 注入体警戒线：AGENTS.md 每次会话都进上下文，超线就提醒精简。
# 2026-09-17 从 6000 调至 8000：一次精简后基线 5.8 KB，6000 只剩 4% 余量，
# 随便加一条新条目就报警，警报反而失去「该精简了」的提示意义。调高后仍余约 2.2 KB。
AGENTS_WARN_BYTES = 8000
SESSION_KEEP_DAYS = 90         # 会话记忆多久没更新就归档（不删除）
SESSION_INJECT_MAX = 2048      # 单个会话记忆注入上限（字节），插件侧同此默认

# Chinese + English phrasings that usually carry a standing instruction.
SIGNAL_RE = re.compile(
    r"(以后|下次|每次|总是|一直|永远|再也|不要再|别再|不用再|记住|记一下|偏好|习惯|"
    r"我喜欢|我希望|我想要|请务必|务必|必须|默认|约定|规则|注意|千万|别忘|"
    r"from now on|always|never|prefer|remember|don'?t|do not|make sure)",
    re.IGNORECASE,
)

MAX_SIGNALS = 300
MAX_USER_TEXT = 4000          # per message stored in evidence
DIGEST_PREFS_LIMIT = 12000    # bytes of preferences/merlin.md inlined in digest


def sessions_root_for(dsh_home: str, explicit: str | None = None, cwd: str | None = None) -> str:
    """定位会话日志目录：DSH 把每个项目的会话放在 <dsh_home>/sessions/<cwd 变形>/。"""
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    base = os.path.join(dsh_home, "sessions")
    cwd = os.path.abspath(cwd or os.getcwd())
    guess = os.path.join(base, "--" + cwd.strip("/").replace("/", "-") + "--")
    if os.path.isdir(guess):
        return guess
    try:
        dirs = sorted(d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d)))
    except OSError:
        return guess
    if len(dirs) == 1:
        print(f"注意：按当前目录推断的会话目录不存在，改用唯一候选 {dirs[0]}", file=sys.stderr)
        return os.path.join(base, dirs[0])
    if dirs:
        print(f"!! 会话目录有多个候选，且都与当前目录不匹配：{', '.join(dirs)}\n"
              f"   请用 --sessions 指定其中之一（当前按 {os.path.basename(guess)} 处理）",
              file=sys.stderr)
    return guess


def configure(root: str | None = None, dsh_home: str | None = None,
              sessions: str | None = None) -> None:
    """按命令行参数重算所有路径全局量。"""
    global DSH_HOME, MEM, WS, SESS_ROOT, STATE, EVIDENCE, INBOX, MESSAGES, \
        AGENT_PROMPTS, SIGNALS, SIGNALS_JSONL, AGENTS_MD, TOOLUSE, DIGEST, ARCHIVE
    if dsh_home:
        DSH_HOME = os.path.abspath(os.path.expanduser(dsh_home))
    if root:
        MEM = os.path.abspath(os.path.expanduser(root))
    elif not os.environ.get("AGENT_MEMORY_ROOT"):
        MEM = _detect_store_from_script() or os.path.join(DSH_HOME, "agent-memory")
    WS = os.path.dirname(MEM)
    SESS_ROOT = sessions_root_for(DSH_HOME, sessions)
    STATE = os.path.join(MEM, "state.json")
    EVIDENCE = os.path.join(MEM, "evidence")
    INBOX = os.path.join(MEM, "inbox")
    MESSAGES = os.path.join(EVIDENCE, "user-messages.jsonl")
    AGENT_PROMPTS = os.path.join(EVIDENCE, "agent-prompts.jsonl")
    SIGNALS = os.path.join(EVIDENCE, "signals.md")
    SIGNALS_JSONL = os.path.join(EVIDENCE, "signals.jsonl")
    AGENTS_MD = os.path.join(DSH_HOME, "AGENTS.md")
    TOOLUSE = os.path.join(EVIDENCE, "tool-usage.json")
    DIGEST = os.path.join(MEM, "digest.md")
    ARCHIVE = os.path.join(EVIDENCE, "archive.jsonl")
    # 全新库也能跑：把标准骨架建出来（缺目录不是错误）
    for d in (MEM, os.path.join(MEM, "preferences"), EVIDENCE,
              os.path.join(MEM, "sessions"), os.path.join(MEM, "journal"), INBOX):
        try:
            os.makedirs(d, exist_ok=True)
        except OSError:
            pass


def now() -> dt.datetime:
    return dt.datetime.now().astimezone()


def read_text(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def demote(text: str, by: int = 2) -> str:
    """Push headings down so an embedded file nests under its host document."""
    return re.sub(r"^(#{1,4}) ", lambda m: "#" * (len(m.group(1)) + by) + " ",
                  text, flags=re.MULTILINE)


def write_if_changed(path: str, text: str) -> bool:
    if read_text(path) == text:
        return False
    try:  # 目标目录可能还不存在（例如全新的 $DSH_HOME）
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except OSError:
        pass
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)
    return True


def load_state() -> dict:
    try:
        with open(STATE, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "files": {}, "runs": []}


def save_state(state: dict) -> None:
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def load_message_ids() -> set[str]:
    ids: set[str] = set()
    for path in (MESSAGES, AGENT_PROMPTS):
        try:
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        ids.add(json.loads(line)["id"])
                    except (json.JSONDecodeError, KeyError):
                        continue
        except OSError:
            pass
    return ids


def load_redactor():
    """脱敏器：用同目录的 redact.py；加载失败就退化为"不脱敏"并告警。"""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from redact import Redactor
        r = Redactor(store_root=MEM, dsh_home=DSH_HOME)
        r.harvest()
        return r.redact
    except Exception as exc:  # noqa: BLE001 - 绝不因为脱敏器挂了就停止采集
        print(f"!! 脱敏器加载失败，证据将保留原文：{exc}", file=sys.stderr)
        return None


def iter_events(path: str):
    proc = subprocess.Popen(["zstd", "-dc", path], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL)
    assert proc.stdout is not None
    for raw in proc.stdout:
        raw = raw.strip()
        if not raw:
            continue
        try:
            yield json.loads(raw)
        except json.JSONDecodeError:
            continue
    proc.wait()


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(p.get("text") or "" for p in content
                     if isinstance(p, dict) and p.get("type") == "text")


def pick_transcripts(sess_dir: str) -> list[str]:
    out = [os.path.join(sess_dir, f) for f in
           ("session.v3.jsonl.zstd", "session.jsonl.zstd")
           if os.path.isfile(os.path.join(sess_dir, f))]
    return out


def compact_jsonl(path: str, keep: int, label: str) -> int:
    """把 jsonl 压到最近 keep 行，并在 archive.jsonl 记一行归档说明。

    只保留"工作集"：原始消息的权威副本在 DSH 会话日志里，随时可 --rebuild 重建，
    所以这里压掉旧数据不会丢信息，只是不再重复存一份。
    """
    try:
        with open(path, encoding="utf-8") as fh:
            lines = [l for l in fh.read().split("\n") if l.strip()]
    except OSError:
        return 0
    if len(lines) <= keep:
        return 0
    dropped, kept = lines[:-keep], lines[-keep:]

    def when_of(line):
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            return ""
        return str(r.get("when") or "")

    first, last = when_of(dropped[0]), when_of(dropped[-1])
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(kept) + "\n")
    try:
        with open(ARCHIVE, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "at": now().strftime("%Y-%m-%d %H:%M"),
                "label": label, "dropped": len(dropped),
                "from": first, "to": last, "kept": len(kept),
                "note": "原文仍在 DSH 会话日志，可 memory-scan.py --rebuild 重建",
            }, ensure_ascii=False) + "\n")
    except OSError:
        pass
    return len(dropped)


def scan(full: bool, quiet: bool) -> int:
    state = load_state()
    redactor = load_redactor()
    seen = load_message_ids()
    files_state = state.setdefault("files", {})
    tooluse = {}
    try:
        with open(TOOLUSE, encoding="utf-8") as fh:
            tooluse = json.load(fh)
    except (OSError, json.JSONDecodeError):
        pass
    if full:
        files_state.clear()

    new_msgs: list[dict] = []
    new_agent_msgs: list[dict] = []
    new_signals: list[dict] = []
    sessions_seen: dict[str, dict] = {}
    scanned_files = 0
    titles: dict[str, str] = {}

    if not os.path.isdir(SESS_ROOT):
        # 没有会话日志不该让整条流水线停摆：后面的会话索引、摘要、AGENTS.md 照常生成
        print(f"提示：会话目录不存在（{SESS_ROOT}），本轮跳过会话扫描", file=sys.stderr)

    for name in (sorted(os.listdir(SESS_ROOT)) if os.path.isdir(SESS_ROOT) else []):
        sess_dir = os.path.join(SESS_ROOT, name)
        if not os.path.isdir(sess_dir):
            continue
        for path in pick_transcripts(sess_dir):
            rel = os.path.relpath(path, SESS_ROOT)
            st = os.stat(path)
            prev = files_state.get(rel, {})
            if (not full and prev.get("size") == st.st_size
                    and prev.get("mtime") == int(st.st_mtime)):
                continue
            scanned_files += 1
            last_seq = -1 if full else prev.get("last_seq", -1)
            max_seq = last_seq
            title = prev.get("title")
            created = prev.get("created")
            for ev in iter_events(path):
                seq = ev.get("seq")
                etype = ev.get("type")
                if etype == "session":
                    created = created or ev.get("createdAt")
                elif etype == "session/title":
                    t = (ev.get("data") or {}).get("title")
                    if t:
                        title = t
                if isinstance(seq, int):
                    max_seq = max(max_seq, seq)
                    if seq <= last_seq:
                        continue
                if etype == "user/message":
                    data = ev.get("data") or {}
                    if (data.get("source") or {}).get("kind") != "user":
                        continue
                    mid = data.get("id")
                    text = text_of(data.get("content")).strip()
                    if not text or (mid and mid in seen):
                        continue
                    if mid:
                        seen.add(mid)
                    when = ev.get("time")
                    # 本库不留明文密钥：存进证据/报告前先按导出脚本同一套规则脱敏。
                    for_signals = text
                    if redactor:
                        text, _n = redactor(text)
                    rec = {
                        "id": mid,
                        "session": name,
                        "file": os.path.basename(path),
                        "seq": seq,
                        "ts": when,
                        "when": (dt.datetime.fromtimestamp(when / 1000)
                                 .astimezone().strftime("%Y-%m-%d %H:%M")
                                 if isinstance(when, (int, float)) else ""),
                        "text": text[:MAX_USER_TEXT],
                    }
                    # Plain-uuid session dirs are sub-agent sessions: their
                    # "user" turns are prompts written by an agent, not by the
                    # human. Keep them apart so they cannot pollute preferences.
                    if not name.startswith("session-"):
                        rec["origin"] = "agent"
                        new_agent_msgs.append(rec)
                        continue
                    rec["origin"] = "human"
                    new_msgs.append(rec)
                    sessions_seen[name] = {"when": rec["when"], "title": title}
                    if SIGNAL_RE.search(for_signals):
                        new_signals.append({
                            "id": mid, "when": rec["when"], "ts": when,
                            "session": name, "text": rec["text"][:600],
                        })
                elif etype == "tool/call":
                    nm = (ev.get("data") or {}).get("name")
                    if nm:
                        tooluse[nm] = tooluse.get(nm, 0) + 1
            files_state[rel] = {
                "size": st.st_size, "mtime": int(st.st_mtime),
                "last_seq": max_seq, "title": title, "created": created,
            }

    # ---- 归并插件实时采集的文件 ------------------------------------------
    # 插件是"实时快路径"，本脚本是"权威归并者"：按消息 id 去重并入主证据，
    # 然后把 live 文件裁到最近 LIVE_KEEP 行（已并入的不会重复，因为按 id 去重）。
    live_path = os.path.join(EVIDENCE, "live-messages.jsonl")
    merged = 0
    try:
        with open(live_path, encoding="utf-8") as fh:
            live_lines = [l for l in fh.read().split("\n") if l.strip()]
        for line in live_lines:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            mid = r.get("id")
            if not mid or mid in seen:
                continue
            text = str(r.get("text") or "")
            if not text:
                continue
            if redactor:
                text, _n = redactor(text)
            seen.add(mid)
            new_msgs.append({
                "id": mid,
                "session": r.get("session") or "",
                "file": "live",
                "seq": r.get("seq"),
                "ts": r.get("ts"),
                "when": (dt.datetime.fromtimestamp(r["ts"] / 1000).astimezone()
                         .strftime("%Y-%m-%d %H:%M") if isinstance(r.get("ts"), (int, float)) else ""),
                "text": text[:MAX_USER_TEXT],
                "origin": "human",
            })
            merged += 1
        if len(live_lines) > LIVE_KEEP:
            with open(live_path, "w", encoding="utf-8") as fh:
                for line in live_lines[-LIVE_KEEP:]:
                    fh.write(line + "\n")
    except OSError:
        pass

    # ---- write evidence -------------------------------------------------
    os.makedirs(EVIDENCE, exist_ok=True)
    with open(MESSAGES, "a", encoding="utf-8") as fh:
        for rec in new_msgs:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    with open(AGENT_PROMPTS, "a", encoding="utf-8") as fh:
        for rec in new_agent_msgs:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    with open(TOOLUSE, "w", encoding="utf-8") as fh:
        json.dump(tooluse, fh, ensure_ascii=False, indent=1, sort_keys=True)

    # signals file: newest first, capped
    old_signals: list[dict] = []
    try:
        with open(SIGNALS, encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r"- `([^`]*)` \[([^\]]*)\] (.*)", line.rstrip("\n"))
                if m:
                    old_signals.append({"when": m.group(1), "session": m.group(2),
                                        "text": m.group(3)})
    except OSError:
        pass
    all_signals = list(reversed(new_signals)) + old_signals
    all_signals = all_signals[:MAX_SIGNALS]
    with open(SIGNALS, "w", encoding="utf-8") as fh:
        fh.write("# 偏好信号（由 memory-scan.py 维护，最新在前）\n\n")
        fh.write("命中「以后/每次/不要/记住/偏好/习惯/务必…」等措辞的用户原话，"
                 "是沉淀 `preferences/merlin.md` 的候选。\n\n")
        for rec in all_signals:
            flat = " ".join(rec["text"].split())
            fh.write(f"- `{rec['when']}` [{rec['session']}] {flat}\n")
    with open(SIGNALS_JSONL, "a", encoding="utf-8") as fh:
        for rec in new_signals:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    # ---- 压缩：原始消息只是"工作集"，不是档案 -------------------------------
    # 原文本来就在 DSH 会话日志里（$DSH_HOME/sessions），本库再存一份纯属冗余。
    # 因此只保留最近 EVIDENCE_KEEP 条未沉淀的原始材料，更早的压掉，
    # 并在 archive.jsonl 记一行"归档了多少条、覆盖哪段时间"，需要时可 --rebuild 重建。
    compacted = compact_jsonl(MESSAGES, EVIDENCE_KEEP, "人类消息")
    compacted_signals = compact_jsonl(SIGNALS_JSONL, SIGNALS_KEEP, "偏好信号")

    # ---- 会话记忆：维护索引 + 归档过期 --------------------------------------
    sess_dir = os.path.join(MEM, "sessions")
    sess_index: dict[str, dict] = {}
    archived_sessions = 0
    if os.path.isdir(sess_dir):
        now_ts = now().timestamp()
        for fname in sorted(os.listdir(sess_dir)):
            if not fname.endswith(".md"):
                continue
            sid = fname[:-3]
            fpath = os.path.join(sess_dir, fname)
            try:
                st = os.stat(fpath)
                body = read_text(fpath)
            except OSError:
                continue
            age_days = (now_ts - st.st_mtime) / 86400
            if age_days > SESSION_KEEP_DAYS:
                adir = os.path.join(sess_dir, "archive")
                os.makedirs(adir, exist_ok=True)
                try:
                    os.replace(fpath, os.path.join(adir, fname))
                    archived_sessions += 1
                except OSError:
                    pass
                continue
            title = ""
            for line in body.split("\n")[:12]:
                if line.startswith("title:"):
                    title = line.split(":", 1)[1].strip()
            created = ""
            for line in body.split("\n")[:12]:
                if line.startswith("created:"):
                    created = line.split(":", 1)[1].strip()
            sess_index[sid] = {
                "session": sid,
                "title": title,
                "created": created,
                "updated": dt.datetime.fromtimestamp(st.st_mtime).astimezone()
                            .strftime("%Y-%m-%d"),
                "entries": sum(1 for l in body.split("\n") if l.startswith("- ")),
                "bytes": st.st_size,
                "overBudget": st.st_size > SESSION_INJECT_MAX,
            }
        try:
            tmp = os.path.join(sess_dir, "index.json.tmp")
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(sess_index, fh, ensure_ascii=False, indent=1, sort_keys=True)
            os.replace(tmp, os.path.join(sess_dir, "index.json"))
        except OSError:
            pass

    # ---- per-run inbox report (only when something actually changed) ------
    os.makedirs(INBOX, exist_ok=True)
    stamp = now().strftime("%Y%m%d-%H%M")
    report = os.path.join(INBOX, f"{stamp}-scan.md")
    lines = [f"# 扫描报告 {stamp}", "",
             f"- 重读日记文件：{scanned_files}",
             f"- 新增用户消息：{len(new_msgs)}",
             f"- 其中偏好信号：{len(new_signals)}",
             f"- 子代理任务消息（不计入偏好）：{len(new_agent_msgs)}",
             f"- 覆盖会话：{len({r['session'] for r in new_msgs})}", ""]
    if new_signals:
        lines += ["## 偏好信号候选", ""]
        for rec in reversed(new_signals):
            lines.append(f"- `{rec['when']}` [{rec['session']}] "
                         f"{' '.join(rec['text'].split())[:400]}")
        lines += ["", "→ 请把其中**长期有效**的部分沉淀进 "
                      "`preferences/merlin.md`，其余丢弃；"
                      "处理完运行 `memory-scan.py --mark-distilled` 归零计数。", ""]
    if new_msgs:
        lines += ["## 全部新增用户消息", ""]
        for rec in new_msgs:
            flat = " ".join(rec["text"].split())
            lines.append(f"- `{rec['when']}` [{rec['session']}] {flat[:300]}")
        lines.append("")
    if new_agent_msgs:
        lines += ["## 新增子代理任务消息（仅供参考，勿作偏好证据）", ""]
        for rec in new_agent_msgs:
            flat = " ".join(rec["text"].split())
            lines.append(f"- `{rec['when']}` [{rec['session']}] {flat[:200]}")
        lines.append("")
    if not new_msgs and not new_agent_msgs and not scanned_files:
        lines.append("_没有新内容。_ ")
    if new_msgs or new_agent_msgs:
        with open(report, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    else:
        # Nothing conversational happened: keep the run in state.json's run
        # log and point the digest at the newest report that has content.
        existing = sorted(f for f in os.listdir(INBOX) if f.endswith("-scan.md"))
        report = (os.path.join(INBOX, existing[-1]) if existing
                  else os.path.join(INBOX, "README.md"))
        if not existing:
            with open(report, "w", encoding="utf-8") as fh:
                fh.write("# 扫描报告\n\n_暂无新增内容。_\n")
    # keep the inbox bounded
    reports = sorted(f for f in os.listdir(INBOX) if f.endswith("-scan.md"))
    for old in reports[:-MAX_INBOX_FILES]:
        try:
            os.remove(os.path.join(INBOX, old))
        except OSError:
            pass

    # ---- digest ----------------------------------------------------------
    total_msgs = sum(1 for _ in open(MESSAGES, encoding="utf-8")) \
        if os.path.isfile(MESSAGES) else 0
    prefs = os.path.join(MEM, "preferences", "global.md")
    if not os.path.isfile(prefs):
        legacy = os.path.join(MEM, "preferences", "merlin.md")
        if os.path.isfile(legacy):
            prefs = legacy
    skills_idx = os.path.join(MEM, "skills", "index.md")
    # 技能只列名字（一行），不再内联整张索引表：注入体与 digest 都要保持精简。
    try:
        _names = sorted(
            f[:-3] for f in os.listdir(os.path.join(MEM, "skills"))
            if f.endswith(".md") and f != "index.md"
        )
    except OSError:
        _names = []
    skills_line = " · ".join(_names) if _names else "（尚未建立）"
    def read(p, limit=None):
        try:
            with open(p, encoding="utf-8") as fh:
                t = fh.read()
        except OSError:
            return "_(尚未建立)_"
        if limit and len(t) > limit:
            t = t[:limit] + "\n\n…（已截断，见原文件）\n"
        # Demote headings so the embedded file nests under the digest's section.
        return re.sub(r"^(#{1,4}) ", lambda m: "#" * (len(m.group(1)) + 2) + " ",
                      t, flags=re.MULTILINE)
    try:
        pending = sorted(f for f in os.listdir(INBOX) if f.endswith("-scan.md"))[-1:]
    except OSError:
        pending = []
    try:
        jrn = sorted(f for f in os.listdir(os.path.join(MEM, "journal"))
                     if f.endswith(".md"))[-1:]
    except OSError:
        jrn = []

    # Signals newer than the last distillation are the agent's to-do list.
    last_distill = state.get("last_distill_at")
    todo: list[dict] = []
    try:
        with open(SIGNALS_JSONL, encoding="utf-8") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if last_distill and (rec.get("when") or "") <= last_distill:
                    continue
                todo.append(rec)
    except OSError:
        pass
    todo = todo[-8:]
    if todo:
        todo_block = "\n".join(
            f"- `{r.get('when','')}` [{r.get('session','')}] "
            f"{' '.join((r.get('text') or '').split())[:300]}" for r in reversed(todo))
        todo_block += ("\n\n→ 把**长期有效**的沉淀进 `preferences/merlin.md` 或 "
                       "`skills/`，然后运行 "
                       "`python3 agent-memory/bin/memory-scan.py --mark-distilled`。")
    else:
        todo_block = "（无。上次沉淀时间：" + (last_distill or "尚未标记") + "）"
    digest_text = f"""<!-- 由 bin/memory-scan.py 自动生成，请勿手改 -->
# Agent 记忆摘要

- 生成时间：{now():%Y-%m-%d %H:%M:%S %Z}
- 证据规模：{total_msgs} 条用户消息
- 最新扫描报告：`inbox/{pending[0] if pending else '—'}`
- 最新日志：`journal/{jrn[0] if jrn else '—'}`
- 扫描游标：`state.json`（{len(files_state)} 个日记文件）

## 零、待沉淀偏好信号（{len(todo)} 条）

{todo_block}

## 一、用户偏好（精简版；证据明细见 preferences/evidence.md）

{read(prefs, DIGEST_PREFS_LIMIT)}

## 二、技能库

`skills/`：{skills_line}

索引与用法：`{os.path.relpath(skills_idx, WS)}`

## 三、记忆库维护规程

1. 会话开始时先读本文件（`agent-memory/digest.md`）。
2. 会话中出现**长期有效**的偏好/约定时，立刻用
   `python3 agent-memory/bin/memory-note.py "<一句话>" --section "<小节>"` 落笔。
3. 会话结束前执行 `python3 agent-memory/bin/memory-scan.py`，
   处理 `inbox/` 里新出现的候选（沉淀或丢弃），再 `--mark-distilled` 清零。
4. 可复用的操作流程沉淀为 `skills/<name>.md` 并登记到 `skills/index.md`。
"""
    # 空闲时不要每分钟重写同一份文件：忽略时间戳行后内容未变就跳过写盘。
    try:
        with open(DIGEST, encoding="utf-8") as fh:
            old_digest = fh.read()
    except OSError:
        old_digest = None
    strip_ts = lambda s: re.sub(r"^- 生成时间：.*$", "- 生成时间：", s, flags=re.M)
    if old_digest is None or strip_ts(old_digest) != strip_ts(digest_text):
        with open(DIGEST, "w", encoding="utf-8") as fh:
            fh.write(digest_text)

    # ---- $DSH_HOME/AGENTS.md ------------------------------------------------
    # dsh-agent-instructions（经 profile patch 启用）会在每次会话的首次请求里注入这个
    # 文件，所以偏好是自动进上下文的。**它是每会话固定成本**，因此刻意保持精简：
    #   偏好正文（精简版）+ 技能名单一行 + 维护方式三行，不再内联技能索引表。
    # 明细、证据、待确认项留在 preferences/evidence.md 与 digest.md，按需再读。
    agents_body = f"""<!-- 自动生成，请勿手改。改偏好：{os.path.relpath(prefs, WS)}，或
     `python3 agent-memory/bin/memory-note.py "<一句话>" --section "<小节>"`。
     由 DSH 的 agent-instructions 插件在每次会话首次请求时注入。明细见
     preferences/evidence.md（不注入）。 -->

{read_text(prefs).rstrip()}

## 可用技能（需要时打开对应文件，不必现在读）

`agent-memory/skills/`：{skills_line}

## 维护

- 记新偏好：`memory-note.py "<一句话>" --section "<小节>"`；采集：`dsh-agent-memory.timer`（5 分钟）
- 待沉淀信号 / 偏好全文与证据 / 技能索引：`digest.md`、`preferences/evidence.md`、`skills/index.md`
- 面板：会话头部「记忆」页签（`/dsh-agent-memory/panel`）
"""
    agents_written = write_if_changed(AGENTS_MD, agents_body)
    agents_bytes = len(agents_body.encode())
    if agents_bytes > AGENTS_WARN_BYTES:
        print(f"!! {AGENTS_MD} 已 {agents_bytes} 字节（≈{agents_bytes // 3} tokens）"
              f"，超过 {AGENTS_WARN_BYTES} 字节警戒线：它是每次会话都注入的，"
              f"请精简 preferences/merlin.md 或把它拆成按需读取。", file=sys.stderr)
    state["runs"] = (state.get("runs", []) + [{
        "at": now().isoformat(timespec="seconds"),
        "scanned_files": scanned_files,
        "new_messages": len(new_msgs),
        "new_signals": len(new_signals),
    }])[-50:]
    state["updated"] = now().isoformat(timespec="seconds")
    save_state(state)

    if not quiet:
        print(json.dumps({
            "scanned_files": scanned_files,
            "new_user_messages": len(new_msgs),
            "new_signals": len(new_signals),
            "evidence_total": total_msgs,
            "report": os.path.relpath(report, WS),
            "digest": os.path.relpath(DIGEST, WS),
            "session_memories": len(sess_index),
            "sessions_archived": archived_sessions,
            "agents_md": os.path.relpath(AGENTS_MD, WS) + (
                "（已更新）" if agents_written else "（无变化）"),
        }, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true",
                    help="ignore the cursor and rescan every transcript")
    ap.add_argument("--rebuild", action="store_true",
                    help="delete evidence + cursor, then rescan everything")
    ap.add_argument("--mark-distilled", action="store_true",
                    help="record that pending preference signals were reviewed")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--root", help="记忆库根目录（默认 $AGENT_MEMORY_ROOT 或 $DSH_HOME/agent-memory）")
    ap.add_argument("--dsh-home", help="DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）")
    ap.add_argument("--sessions", help="会话日志目录（默认按当前工作目录推断）")
    args = ap.parse_args()
    configure(root=args.root, dsh_home=args.dsh_home, sessions=args.sessions)
    if args.rebuild:
        for p in (MESSAGES, AGENT_PROMPTS, SIGNALS, SIGNALS_JSONL, TOOLUSE, STATE):
            try:
                os.remove(p)
            except OSError:
                pass
        args.full = True
    if args.mark_distilled:
        st = load_state()
        st["last_distill_at"] = now().strftime("%Y-%m-%d %H:%M")
        save_state(st)
    return scan(args.full, args.quiet)


if __name__ == "__main__":
    sys.exit(main())
