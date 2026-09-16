#!/usr/bin/env python3
"""Record one durable memory *immediately*, without waiting for the scanner.

两层记忆，写入时用 `--scope` 选择：

    # 全局：跨对话普适（沟通习惯、干活方式、固定约定）→ preferences/global.md
    python3 bin/memory-note.py "改动前先备份" --section "干活"

    # 会话：只对当前这个对话有用 → sessions/<会话id>.md（默认取 $DSH_SESSION_ID）
    python3 bin/memory-note.py "这次任务只改 CSS，别动 HTML" --scope session --section "约定"

What it does:

1. writes a dated bullet into `preferences/merlin.md` — either into the named
   section, or into a `## 即时记录` section at the end of the file (newest
   first) when no section is given;
2. appends one line to `journal/YYYY-MM.md` so the change is traceable;
3. refreshes `digest.md` so the next turn (and the next session) sees it.

The note text goes through the same redaction rules as the export, so a
credential pasted into a note cannot end up stored in the memory library.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys

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


DSH_HOME = os.path.abspath(os.path.expanduser(
    os.environ.get("DSH_HOME") or "~/.dsh"))
_DETECTED = _detect_store_from_script()
MEM = os.path.abspath(os.path.expanduser(
    os.environ.get("AGENT_MEMORY_ROOT") or _DETECTED or os.path.join(DSH_HOME, "agent-memory")))
WS = os.path.dirname(MEM)
PREFERENCES = os.path.join(MEM, "preferences")
# 全局记忆文件：新名 global.md；老库仍叫 merlin.md 时继续沿用
GLOBAL_MD = os.path.join(PREFERENCES, "global.md")
LEGACY_GLOBAL_MD = os.path.join(PREFERENCES, "merlin.md")
SESSIONS_DIR = os.path.join(MEM, "sessions")
PREFS = GLOBAL_MD if os.path.exists(GLOBAL_MD) or not os.path.exists(LEGACY_GLOBAL_MD) \
    else LEGACY_GLOBAL_MD
JOURNAL_DIR = os.path.join(MEM, "journal")
SCAN = os.path.join(MEM, "bin", "memory-scan.py")
INLINE_SECTION = "即时记录"


def redactor():
    """用同目录的 redact.py；不可用就告警并原样返回。"""
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from redact import Redactor
        r = Redactor(store_root=MEM, dsh_home=DSH_HOME)
        r.harvest()
        return r.redact
    except Exception as exc:  # noqa: BLE001
        print(f"!! 脱敏器不可用，请勿把凭据写进备注：{exc}", file=sys.stderr)
        return None


SESSION_HEADER = """---
session: {sid}
created: {when}
updated: {when}
entries: 0
---

# 本对话记忆

> 只注入这个会话；跨对话普适的习惯见 `preferences/global.md`。

## 约定

"""


def session_file(sid: str) -> str:
    return os.path.join(SESSIONS_DIR, f"{sid}.md")


def load_session(sid: str, when: str) -> list[str]:
    path = session_file(sid)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return fh.read().rstrip("\n").split("\n")
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    return SESSION_HEADER.format(sid=sid, when=when).rstrip("\n").split("\n")


def touch_index(sid: str, when: str, entries: int, title: str = "") -> None:
    """维护 sessions/index.json，供面板列出会话记忆。"""
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    idx_path = os.path.join(SESSIONS_DIR, "index.json")
    try:
        with open(idx_path, encoding="utf-8") as fh:
            idx = json.load(fh)
    except (OSError, json.JSONDecodeError):
        idx = {}
    rec = idx.get(sid) or {}
    idx[sid] = {
        "session": sid,
        "title": title or rec.get("title") or "",
        "created": rec.get("created") or when,
        "updated": when,
        "entries": entries,
    }
    tmp = idx_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(idx, fh, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, idx_path)


def bullet(text: str, when: str, evidence: str | None) -> str:
    tail = f" —— {evidence}" if evidence else ""
    return f"- （{when}）{text}{tail}"


def insert_into_section(lines: list[str], section: str, entry: str) -> tuple[list[str], bool]:
    """Insert *entry* right after the heading of *section* (newest first).

    Headings are matched loosely, so `--section "对 AI 的期望"` also finds
    `## 六、对 AI 的期望`.
    """
    def heading_text(line: str):
        m = re.match(r"^##\s+(.*?)\s*$", line)
        if not m:
            return None
        return re.sub(r"^[一二三四五六七八九十]+、\s*", "", m.group(1)).strip()

    exact = partial = None
    for i, line in enumerate(lines):
        t = heading_text(line)
        if t is None:
            continue
        if t == section and exact is None:
            exact = i
        elif section in t and partial is None:
            partial = i
    idx = exact if exact is not None else partial
    if idx is None:
        return lines, False
    j = idx + 1
    while j < len(lines) and lines[j].strip() == "":
        j += 1
    lines.insert(j, entry)
    return lines, True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("text", help="要记下的偏好/约定（一句话）")
    ap.add_argument("--section", help="写入 preferences/merlin.md 的哪个 ## 小节")
    ap.add_argument("--evidence", help="证据线索，如日期或会话短 id")
    ap.add_argument("--no-scan", action="store_true",
                    help="不刷新 digest.md")
    ap.add_argument("--scope", choices=["global", "session"], default="global",
                    help="global=跨对话普适（默认）；session=只对某个对话生效")
    ap.add_argument("--session", help="会话 id（--scope session 时用；默认取 $DSH_SESSION_ID）")
    ap.add_argument("--root", help="记忆库根目录（默认 $AGENT_MEMORY_ROOT 或 $DSH_HOME/agent-memory）")
    ap.add_argument("--dsh-home", help="DSH 主目录（默认 $DSH_HOME）")
    args = ap.parse_args()
    if args.root or args.dsh_home:
        # 重新派生的路径必须**全部**重算，漏一个就会写错地方
        g = globals()
        g["DSH_HOME"] = os.path.abspath(os.path.expanduser(args.dsh_home or DSH_HOME))
        g["MEM"] = os.path.abspath(os.path.expanduser(
            args.root or os.path.join(DSH_HOME, "agent-memory")))
        g["WS"] = os.path.dirname(MEM)
        g["PREFERENCES"] = os.path.join(MEM, "preferences")
        g["GLOBAL_MD"] = os.path.join(PREFERENCES, "global.md")
        g["LEGACY_GLOBAL_MD"] = os.path.join(PREFERENCES, "merlin.md")
        g["SESSIONS_DIR"] = os.path.join(MEM, "sessions")
        g["PREFS"] = GLOBAL_MD if os.path.exists(GLOBAL_MD) or not os.path.exists(LEGACY_GLOBAL_MD) \
            else LEGACY_GLOBAL_MD
        g["JOURNAL_DIR"] = os.path.join(MEM, "journal")
        g["SCAN"] = os.path.join(MEM, "bin", "memory-scan.py")

    now = dt.datetime.now().astimezone()
    when = now.strftime("%Y-%m-%d")
    text = " ".join(args.text.split())
    red = redactor()
    if red:
        text, n = red(text)
        if n:
            print(f"（备注中 {n} 处密钥已脱敏）")
    if not text:
        print("!! 内容为空", file=sys.stderr)
        return 2

    scope = args.scope
    sid = args.session or os.environ.get("DSH_SESSION_ID") or ""
    if scope == "session" and not sid:
        print("!! --scope session 需要 --session 或 $DSH_SESSION_ID", file=sys.stderr)
        return 2
    target_file = session_file(sid) if scope == "session" else PREFS
    globals()["TARGET"] = target_file

    try:
        if scope == "session":
            lines = load_session(sid, when)
        else:
            with open(target_file, encoding="utf-8") as fh:
                lines = fh.read().rstrip("\n").split("\n")
    except FileNotFoundError:
        # 全新记忆库：先立个骨架，让第一条偏好有地方落
        os.makedirs(os.path.dirname(target_file), exist_ok=True)
        lines = ["# 长期偏好（自动注入）", "",
                 "> 由 Agent 维护；口令/token/私钥不进档。", ""]
    except OSError as exc:
        print(f"!! 读不到 {PREFS}: {exc}", file=sys.stderr)
        return 2

    entry = bullet(text, when, args.evidence)
    default_section = "约定" if scope == "session" else INLINE_SECTION
    target = args.section or default_section
    lines, found = insert_into_section(lines, target, entry)
    if not found:
        if args.section:
            print(f"!! 找不到小节「{args.section}」，改写入「{INLINE_SECTION}」"
                  f"（可用 --section 指定现有小节）", file=sys.stderr)
            lines, found = insert_into_section(lines, INLINE_SECTION, entry)
        if not found:
            lines += ["", f"## {INLINE_SECTION}", "",
                      "_未归类的即时记录；下次沉淀时折叠进上面的正式小节。_", "",
                      entry]
            target = INLINE_SECTION
        else:
            target = INLINE_SECTION

    body = "\n".join(lines) + "\n"
    if scope == "session":
        # 更新 frontmatter 的 updated/entries
        n_entries = sum(1 for l in lines if l.startswith("- "))
        body = re.sub(r"^updated: .*$", f"updated: {when}", body, count=1, flags=re.M)
        body = re.sub(r"^entries: .*$", f"entries: {n_entries}", body, count=1, flags=re.M)
    tmp = target_file + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(body)
    os.replace(tmp, target_file)
    if scope == "session":
        touch_index(sid, when, sum(1 for l in body.split("\n") if l.startswith("- ")))

    os.makedirs(JOURNAL_DIR, exist_ok=True)
    jpath = os.path.join(JOURNAL_DIR, now.strftime("%Y-%m.md"))
    new_journal = not os.path.isfile(jpath)
    with open(jpath, "a", encoding="utf-8") as fh:
        if new_journal:
            fh.write(f"# {now:%Y-%m} 记忆库日志\n")
        scope_tag = f"会话 {sid[:20]}" if scope == "session" else "全局"
        fh.write(f"\n- {now:%Y-%m-%d %H:%M} 即时记录（{scope_tag}）→ `{target}`：{text}"
                 f"{' —— ' + args.evidence if args.evidence else ''}\n")

    if not args.no_scan:
        subprocess.run([sys.executable, SCAN, "--quiet"], check=False)

    print(json.dumps({
        "wrote": os.path.relpath(target_file, WS),
        "scope": scope,
        "session": sid or None,
        "section": target,
        "journal": os.path.relpath(jpath, WS),
        "entry": entry,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
