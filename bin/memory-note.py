#!/usr/bin/env python3
"""Record one durable preference *immediately*, without waiting for the
hourly scanner or a distillation pass.

    python3 agent-memory/bin/memory-note.py "改动 nginx 后必须跑一遍全量自检" \
            --section "做事方式" --evidence "2026-09-15 session-f762df73"

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
PREFS = os.path.join(MEM, "preferences", "merlin.md")
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
    ap.add_argument("--root", help="记忆库根目录（默认 $AGENT_MEMORY_ROOT 或 $DSH_HOME/agent-memory）")
    ap.add_argument("--dsh-home", help="DSH 主目录（默认 $DSH_HOME）")
    args = ap.parse_args()
    if args.root or args.dsh_home:
        globals()["DSH_HOME"] = os.path.abspath(os.path.expanduser(args.dsh_home or DSH_HOME))
        globals()["MEM"] = os.path.abspath(os.path.expanduser(
            args.root or os.path.join(DSH_HOME, "agent-memory")))
        globals()["WS"] = os.path.dirname(MEM)
        globals()["PREFS"] = os.path.join(MEM, "preferences", "merlin.md")
        globals()["JOURNAL_DIR"] = os.path.join(MEM, "journal")
        globals()["SCAN"] = os.path.join(MEM, "bin", "memory-scan.py")

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

    try:
        with open(PREFS, encoding="utf-8") as fh:
            lines = fh.read().rstrip("\n").split("\n")
    except FileNotFoundError:
        # 全新记忆库：先立个骨架，让第一条偏好有地方落
        os.makedirs(os.path.dirname(PREFS), exist_ok=True)
        lines = ["# 长期偏好（自动注入）", "",
                 "> 由 Agent 维护；口令/token/私钥不进档。", ""]
    except OSError as exc:
        print(f"!! 读不到 {PREFS}: {exc}", file=sys.stderr)
        return 2

    entry = bullet(text, when, args.evidence)
    target = args.section or INLINE_SECTION
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

    tmp = PREFS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    os.replace(tmp, PREFS)

    os.makedirs(JOURNAL_DIR, exist_ok=True)
    jpath = os.path.join(JOURNAL_DIR, now.strftime("%Y-%m.md"))
    new_journal = not os.path.isfile(jpath)
    with open(jpath, "a", encoding="utf-8") as fh:
        if new_journal:
            fh.write(f"# {now:%Y-%m} 记忆库日志\n")
        fh.write(f"\n- {now:%Y-%m-%d %H:%M} 即时记录 → `{target}`：{text}"
                 f"{' —— ' + args.evidence if args.evidence else ''}\n")

    if not args.no_scan:
        subprocess.run([sys.executable, SCAN, "--quiet"], check=False)

    print(json.dumps({
        "wrote": os.path.relpath(PREFS, WS),
        "section": target,
        "journal": os.path.relpath(jpath, WS),
        "entry": entry,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
