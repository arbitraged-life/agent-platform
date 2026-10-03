"""Shared AI Code Purity checking module.

Provides unified regex patterns and content-auditing functions for both pre-commit and pre-tool hooks.
"""

import os
import re

# Regex patterns for validation
SYNC_JS_RE = re.compile(
    r"\b(readFileSync|writeFileSync|copyFileSync|existsSync|readdirSync|mkdirSync|execSync|"
    r"appendFileSync|unlinkSync|rmdirSync|rmSync|renameSync|statSync|lstatSync)\b"
)
PYTHON_SHELL_RE = re.compile(
    r"\b(subprocess\.(run|Popen|call|check_output|check_call)\b.*?shell\s*=\s*True|os\.system\b)"
)
PYTHON_INTERP_RE = re.compile(
    r"\bsubprocess\.(run|Popen|call|check_output|check_call)\(\s*(f\"|f\'|\".*?\{\w+\}.*?\"|\'.*?\{\w+\}.*?\')"
)
UNBOUND_PORT_RE = re.compile(
    r"(listen\([^)]*['\"]0\.0\.0\.0['\"]|['\"]0\.0\.0\.0['\"],|host\s*=\s*['\"]0\.0\.0\.0['\"]|"
    r"host:\s*['\"]?0\.0\.0\.0['\"]?)"
)

# Robust AI Slop, placeholder, or code truncation comment detection
SLOP_RE = re.compile(
    r"("
    r"TODO:\s*implement|"
    r"MODEL_PLACEHOLDER|"  # ai-purity-ignore: placeholders
    r"//\s*placeholder|"
    r"/\*\s*placeholder\s*\*/|"
    r"(\/\/|#|/\*)\s*\.\.\.\s*(existing|rest|remaining|code|file)?|"  # matches AI truncation comments
    r"^[ \t]*(\/\/|#)\s*\.\.\.\s*$"  # matches lines containing just // ... or # ... # ai-purity-ignore: placeholders
    r")",
    re.IGNORECASE
)

# Merge conflict markers check
MERGE_CONFLICT_RE = re.compile(r"^(<<<<<<<|=======|>>>>>>>)\b")

# High entropy secrets/API key detection to prevent hardcoded credentials
SECRET_RE = re.compile(
    r"("
    r"sk-" + r"proj-[a-zA-Z0-9]{20,}|"               # OpenAI project keys
    r"sq-proj-[a-zA-Z0-9]{20,}|"               # Square keys
    r"AIza" + r"Sy[a-zA-Z0-9_\-]{33}|"               # Google GCP/Gemini keys
    r"(?<!env\.)(?<!process\.)\b(api_key|apikey|secret_key|private_key)\s*=\s*['\"][a-zA-Z0-9_\-\.]{16,}['\"]"  # High entropy assignment literal
    r")",
    re.IGNORECASE
)

# Detect secrets in SSH heredoc commands
SSH_HEREDOC_SECRET_RE = re.compile(
    r"ssh\s+\S+\s+[\"']?cat\b.*?<<.*?(TOKEN|KEY|SECRET|PASSWORD)\s*=\s*\S{20,}",
    re.IGNORECASE | re.DOTALL
)

# Prohibit machine-local user paths while allowing placeholder examples
PLACEHOLDER_USERS = frozenset({
    "me", "you", "user", "users", "username", "yourname", "your-name", "example", "someone"
})
MACHINE_LOCAL_PATH_RE = re.compile(r"/" + r"Users/([A-Za-z0-9._-]+)")


def audit_line(filepath, line_num, line_content, line_strip, on_bypass_callback=None):
    """Audits a single line of code against AI code-purity rules.

    Returns an error dict if a violation is found, or None if pure or bypassed.
    """
    ext = os.path.splitext(filepath)[1].lower()
    norm_path = filepath.replace("\\", "/")

    # Check rule 1: Synchronous Event-Loop Blockers in Javascript/TypeScript
    if ext in [".js", ".ts", ".tsx", ".jsx"] and SYNC_JS_RE.search(line_strip):
        if "ai-purity-ignore: sync-blocking" not in line_content:
            return {
                "rule": "SYNC-BLOCKING",
                "message": f"Synchronous event-loop blocker detected: '{SYNC_JS_RE.search(line_strip).group(1)}'.",
                "fix": "Convert to Promise-based equivalent (e.g., fs.promises.* or async process spawns).",
                "ignore_tag": "// ai-purity-ignore: sync-blocking"
            }
        elif on_bypass_callback:
            on_bypass_callback(filepath, line_num, "SYNC-BLOCKING", "ai-purity-ignore: sync-blocking", line_strip)

    # Check rule 2: Command Injection / Unsafe Subprocess in Python
    if ext == ".py":
        if PYTHON_SHELL_RE.search(line_strip):
            if "ai-purity-ignore: unsafe-subprocess" not in line_content:
                return {
                    "rule": "UNSAFE-SUBPROCESS",
                    "message": "Unsafe subprocess execution with shell=True or os.system.",  # ai-purity-ignore: unsafe-subprocess
                    "fix": "Pass inputs as discrete arrays of strings instead of compiling formatted shell strings.",
                    "ignore_tag": "# ai-purity-ignore: unsafe-subprocess"
                }
            elif on_bypass_callback:
                on_bypass_callback(filepath, line_num, "UNSAFE-SUBPROCESS", "ai-purity-ignore: unsafe-subprocess", line_strip)
        elif PYTHON_INTERP_RE.search(line_strip):
            if "ai-purity-ignore: unsafe-subprocess" not in line_content:
                return {
                    "rule": "COMMAND-INTERPOLATION",
                    "message": "String interpolation detected inside a subprocess call. Potential shell-injection vector.",
                    "fix": "Use positional argv lists/arrays and end-run parameter binding.",
                    "ignore_tag": "# ai-purity-ignore: unsafe-subprocess"
                }
            elif on_bypass_callback:
                on_bypass_callback(filepath, line_num, "COMMAND-INTERPOLATION", "ai-purity-ignore: unsafe-subprocess", line_strip)

    # Check rule 3: Unbound Listening Interfaces (0.0.0.0) in Host/Sidecar spaces
    if ("infra/homepage/" in norm_path or "ops/scripts/" in norm_path or filepath.startswith("infra/homepage/") or filepath.startswith("ops/scripts/")) and UNBOUND_PORT_RE.search(line_strip):
        if "ai-purity-ignore: unbound-interface" not in line_content:
            return {
                "rule": "UNBOUND-INTERFACE",
                "message": "Unbound listening interface ('0.0.0.0') exposing companion endpoints to WAN/LAN.",
                "fix": "Restrict server binding strictly to localhost / '127.0.0.1'.",
                "ignore_tag": "// ai-purity-ignore: unbound-interface"
            }
        elif on_bypass_callback:
            on_bypass_callback(filepath, line_num, "UNBOUND-INTERFACE", "ai-purity-ignore: unbound-interface", line_strip)

    # Check rule 4: AI Slop & Placeholder leftovers
    if ext != ".md" and SLOP_RE.search(line_strip):
        if "ai-purity-ignore: placeholders" not in line_content:
            return {
                "rule": "AI-SLOP",
                "message": f"Placeholder slop or truncated code comment detected: '{SLOP_RE.search(line_strip).group(1)}'.",
                "fix": "Do not leave raw stubs, placeholders, or partial AI code truncation comments in files.",
                "ignore_tag": "// ai-purity-ignore: placeholders"
            }
        elif on_bypass_callback:
            on_bypass_callback(filepath, line_num, "AI-SLOP", "ai-purity-ignore: placeholders", line_strip)

    # Check rule 4b: Merge Conflict Markers (cannot be bypassed)
    if MERGE_CONFLICT_RE.search(line_strip):
        return {
            "rule": "MERGE-CONFLICT",
            "message": "Unresolved git merge conflict marker detected.",
            "fix": "Resolve the conflict properly and remove the conflict boundary lines.",
            "ignore_tag": None
        }

    # Check rule 5: Hardcoded Secrets/Credentials
    if SECRET_RE.search(line_strip):
        if "ai-purity-ignore: secrets" not in line_content:
            return {
                "rule": "HARDCODED-SECRET",
                "message": "Potential hardcoded credentials or high-entropy API key detected.",
                "fix": "Do not commit plain text secrets. Store secrets in 1Password/Vault and resolve via env var injections.",
                "ignore_tag": "# ai-purity-ignore: secrets"
            }
        elif on_bypass_callback:
            on_bypass_callback(filepath, line_num, "HARDCODED-SECRET", "ai-purity-ignore: secrets", line_strip)

    # Check rule 6: Machine-local user path reference
    for match in MACHINE_LOCAL_PATH_RE.finditer(line_strip):
        username = match.group(1).lower()
        if username in PLACEHOLDER_USERS:
            continue

        if "ai-purity-ignore: legacy-paths" not in line_content:
            return {
                "rule": "LEGACY-PATH",
                "message": f"Machine-local path reference detected: '{match.group(0)}'.",
                "fix": "Use repo-relative paths for in-repo files, or $HOME/env-based paths (for example: $HOME/Code/<repo> or $HOMELAB_ROOT) instead of user-specific absolute paths.",
                "ignore_tag": "# ai-purity-ignore: legacy-paths"
            }
        elif on_bypass_callback:
            on_bypass_callback(filepath, line_num, "LEGACY-PATH", "ai-purity-ignore: legacy-paths", line_strip)

    return None
