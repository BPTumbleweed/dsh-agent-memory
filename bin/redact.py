#!/usr/bin/env python3
"""脱敏引擎：把"已知密钥值"和"结构性凭证模式"从文本里抹掉。

被 `memory-scan.py` / `memory-note.py` 共用，也可直接被你的导出/备份脚本 import：

    from redact import Redactor
    r = Redactor(store_root="/path/to/agent-memory", dsh_home="/var/lib/dsh")
    r.harvest()                       # 采集已知密钥值
    text, n = r.redact(text)          # 抹掉，返回 (新文本, 抹掉几处)
    if r.contains_secret(raw_bytes):  # 判断二进制里有没有已知密钥值
        ...

**采集来源**（都可缺省，缺了就是"没有已知值"，只靠结构模式）：

1. `<store_root>/secrets.files` —— 一行一个路径，`#` 开头为注释。
   每个文件按内容自动识别：Netscape cookie 罐 / `KEY=VALUE` 环境文件 / 单行 token。
2. `$DSH_HOME/.credentials.yaml` —— DSH 自己的凭据存储（存在才读）。

设计原则：**宁可多抹**。误抹只是可读性下降，漏抹是事故。
"""

from __future__ import annotations

import os
import re

# 结构性模式：不依赖"知道具体值"，看到形状就抹。全部保持线性匹配（无回溯陷阱）。
PATTERNS: list[tuple[re.Pattern, object]] = [
    (re.compile(r"(?<=token=)[A-Za-z0-9_\-]{40,}"), "<REDACTED:dsh-token>"),
    (re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._\-]{20,}"), r"\1 <REDACTED:bearer>"),
    (re.compile(r"(?i)\b(basic)\s+[A-Za-z0-9+/=]{16,}"), r"\1 <REDACTED:basic-auth>"),
    # 2026-09-17 扩宽：DashScope 新版 key 形如 sk-ws-H.PHYHYHR.GzOE.<base64url>，
    # 含 . - _ 三种符号。原规则 [A-Za-z0-9]{20,} 一个字符都匹配不上，
    # 实测该 key 被原样采集进 agent-memory/evidence/*.jsonl。
    (re.compile(r"\bsk-[A-Za-z0-9._\-]{16,}"), "<REDACTED:api-key>"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"), "<REDACTED:github-token>"),
    (re.compile(r"\$2[aby]\$\d{2}\$[./A-Za-z0-9]{40,}"), "<REDACTED:bcrypt-hash>"),
    # Cookie / Set-Cookie 头（也覆盖写在 shell 命令里的）
    (re.compile(r"(?i)((?:set-)?cookie\s*:\s*)([^\n'\"\\]{8,})"),
     lambda m: m.group(1) + "<REDACTED:cookie-header>"),
    # JWT
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),
     "<REDACTED:jwt>"),
    # 字面量赋值（跳过 $VAR / os.environ[...] 这类引用）
    (re.compile(
        r"(?i)(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|"
        r"auth[_-]?token|mqtt[_-]?password|client[_-]?secret)"
        r"(\s*[\"']?\s*[:=]\s*[\"']?)([A-Za-z0-9!@#$%^&*_+\-]{8,})"),
     lambda m: m.group(1) + m.group(2) + "<REDACTED:literal-secret>"),
    # NAME=<会话类值>：强名字（本身就是会话标识）一律抹；
    (re.compile(
        r"(?i)(jsessionid|phpsessid|sessionid|serverid|acw_tc|ingresscookie|"
        r"csrftoken|xsrf[_-]?token)"
        r"(\s*=\s*)([A-Za-z0-9%._|+\-]{8,})"),
     lambda m: m.group(1) + m.group(2) + "<REDACTED:session-id>"),
    # 弱名字（可能是普通变量名）要求值里含数字，才不误伤 `session = os.environ[...]`
    (re.compile(
        r"(?i)(_?session|access[_-]?token|refresh[_-]?token)"
        r"(\s*=\s*)([A-Za-z0-9%._|+\-]{6,})"),
     lambda m: (m.group(1) + m.group(2) + "<REDACTED:session-id>")
     if any(c.isdigit() for c in m.group(3)) else m.group(0)),
]

PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{1,8000}?"
    r"-----END [A-Z ]{0,40}PRIVATE KEY-----"
)

# JSON 转义形态的 Netscape cookie 记录（字段间是两个字面字符 \t）
COOKIE_ESCAPED_RE = re.compile(
    r"((?:#HttpOnly_)?[^\\\s\"]*\\t(?:TRUE|FALSE)\\t[^\\\s\"]*\\t(?:TRUE|FALSE)"
    r"\\t\d+\\t[^\\\s\"]*\\t)([^\\\s\"]+)"
)

COOKIE_JAR_MARK = b"# Netscape HTTP Cookie File"

MIN_LITERAL = 8        # 短于这个长度的值不当密钥（噪音太大）


def redact_cookie_records(text: str) -> tuple[str, int]:
    """抹掉 Netscape cookie 记录的值字段（真制表符与 \\t 转义两种形态）。"""
    n = 0
    if "\tTRUE\t" in text or "\tFALSE\t" in text:
        out = []
        for line in text.split("\n"):
            if line.count("\t") >= 6 and ("\tTRUE\t" in line or "\tFALSE\t" in line):
                parts = line.split("\t")
                if len(parts) >= 7 and parts[-1]:
                    parts[-1] = "<REDACTED:cookie-value>"
                    line = "\t".join(parts)
                    n += 1
            out.append(line)
        text = "\n".join(out)
    if "\\tTRUE\\t" in text or "\\tFALSE\\t" in text:
        text, k = COOKIE_ESCAPED_RE.subn(
            lambda m: m.group(1) + "<REDACTED:cookie-value>", text)
        n += k
    return text, n


class Redactor:
    """已知值 + 结构模式的两层脱敏。"""

    def __init__(self, store_root: str | None = None, dsh_home: str | None = None):
        self.store_root = store_root
        self.dsh_home = dsh_home
        self.values: dict[str, str] = {}

    # ---------------------------------------------------------------- 采集
    def add(self, value: str, label: str, prefixes: bool = False) -> None:
        value = (value or "").strip().strip('"').strip("'")
        if len(value) < MIN_LITERAL or value.startswith(("http", "$")):
            return
        self.values.setdefault(value, label)
        if prefixes and len(value) >= 24:
            self.values.setdefault(value[:20], label + "-prefix")

    def add_cookie_value(self, value: str) -> None:
        """cookie 值常是复合的（hex|过期时间|nonce），整体、分量、分量前缀都要登记。"""
        value = (value or "").strip()
        self.add(value, "cookie-value")
        for comp in value.split("|"):
            comp = comp.strip()
            if len(comp) >= 12:
                self.add(comp, "cookie-value-part")
                if len(comp) >= 24:
                    self.add(comp[:20], "cookie-value-prefix")

    def _harvest_file(self, path: str) -> None:
        try:
            with open(path, encoding="utf-8", errors="ignore") as fh:
                lines = fh.read().splitlines()
        except OSError:
            return
        # Netscape cookie 罐
        if any(l.startswith("# Netscape HTTP Cookie File") for l in lines[:2]):
            for line in lines:
                parts = line.rstrip("\n").split("\t")
                if len(parts) >= 7:
                    self.add_cookie_value(parts[-1])
            return
        # KEY=VALUE / 「口令: xxx」
        key_re = re.compile(
            r"(?i)^\s*([A-Za-z0-9_]*(?:password|passwd|pwd|token|secret|api[_-]?key)"
            r"[A-Za-z0-9_]*|口令|密码)\s*[:=]\s*(.+?)\s*$")
        hit = False
        for line in lines:
            m = key_re.match(line)
            if m:
                self.add(m.group(2), "credential")
                hit = True
        if hit:
            return
        # 单行 token 文件
        if len(lines) == 1 and lines[0].strip():
            self.add(lines[0], "token-file")

    def harvest(self) -> dict[str, str]:
        # ① store_root/secrets.files 里列的路径
        if self.store_root:
            listfile = os.path.join(self.store_root, "secrets.files")
            try:
                with open(listfile, encoding="utf-8") as fh:
                    for raw in fh:
                        p = raw.strip()
                        if not p or p.startswith("#"):
                            continue
                        self._harvest_file(os.path.expanduser(p))
            except OSError:
                pass
        # ② DSH 自己的凭据存储
        if self.dsh_home:
            try:
                with open(os.path.join(self.dsh_home, ".credentials.yaml"),
                          encoding="utf-8", errors="ignore") as fh:
                    for line in fh:
                        m = re.match(r"\s*(secret|DEEPSEEK_API_KEY)\s*:\s*(\S+)\s*$", line)
                        if m:
                            self.add(m.group(2), "dsh-credential")
            except OSError:
                pass
        return self.values

    # ---------------------------------------------------------------- 脱敏
    def redact(self, s: str) -> tuple[str, int]:
        n = 0
        for value, label in self.values.items():
            if value in s:
                n += s.count(value)
                s = s.replace(value, f"<REDACTED:{label}>")
        s, k = redact_cookie_records(s)
        n += k
        if "PRIVATE KEY-----" in s:
            s, k = PRIVATE_KEY_RE.subn("<REDACTED:private-key>", s)
            n += k
        for pat, repl in PATTERNS:
            s, k = pat.subn(repl, s)
            n += k
        return s, n

    def contains_secret(self, data: bytes) -> bool:
        """给"二进制文件该不该整份排除"用。"""
        if COOKIE_JAR_MARK in data[:4096]:
            return True
        for value in self.values:
            if value.encode() in data:
                return True
        if b"PRIVATE KEY-----" in data:
            return True
        text = data.decode("utf-8", "ignore")
        if ("\tTRUE\t" in text or "\tFALSE\t" in text) and text.count("\t") > 6:
            return True
        for pat, _ in PATTERNS:
            if pat.search(text):
                return True
        return False


if __name__ == "__main__":  # 自检：python3 redact.py
    r = Redactor()
    cases = [
        ("token=" + "A" * 45, "<REDACTED:dsh-token>"),
        ('password: "hunter2secret"', "<REDACTED:literal-secret>"),
        ("Authorization: Bearer " + "b" * 30, "<REDACTED:bearer>"),
        ("ghp_" + "c" * 30, "<REDACTED:github-token>"),
        ("JSESSIONID=" + "D" * 24, "<REDACTED:session-id>"),
        ("cookie: sid=" + "e" * 20, "<REDACTED:cookie-header>"),
        ("PASSWORD = os.environ['X']", "PASSWORD = os.environ['X']"),
        ("session = config.value", "session = config.value"),
    ]
    bad = 0
    for src, want in cases:
        out, _ = r.redact(src)
        mark = "✅" if want in out else "❌"
        if mark == "❌":
            bad += 1
        print(f"  {mark} {src[:44]!r} → {out[:60]!r}")
    print("全部通过 ✅" if not bad else f"{bad} 项失败")
    raise SystemExit(1 if bad else 0)
