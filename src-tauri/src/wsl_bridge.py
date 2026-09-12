"""App-open WSL stdio boundary. No socket, service installation, or credentials.

Git output is interpreted by MonoCode's existing Rust code. Filesystem batches
run beside the Linux checkout instead of making a Windows round trip per row.
"""
import base64
import json
import hashlib
import os
import pwd
import shlex
import uuid
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

MAX_MESSAGE = 40 * 1024 * 1024
MAX_GIT_OUTPUT = 8 * 1024 * 1024
MAX_TEXT = 8 * 1024 * 1024
MAX_FILES = 20_000
SKIP = {".git", "node_modules", "target", "dist", "build", ".next", ".venv", "vendor"}
AGENT_BINARIES = {}
ATTACHMENTS = None
ATTACHMENT_BYTES = 0
ATTACHMENT_COUNT = 0


def absolute(value):
    if not isinstance(value, str) or "\0" in value or not value.startswith("/"):
        raise ValueError("Choose an absolute Linux path in this distribution")
    return Path(value)


def run(argv, cwd, input_bytes=None, timeout=25):
    """Bound both streams and kill the owned group before reaping on failure."""
    # Temporary input avoids blocking the bridge while a child ignores its stdin.
    with tempfile.TemporaryFile() as source:
        if input_bytes:
            source.write(input_bytes)
        source.seek(0)
        child = subprocess.Popen(argv, cwd=cwd, stdin=source,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 start_new_session=True,
                                 env={**os.environ, "GIT_TERMINAL_PROMPT": "0",
                                      "GIT_OPTIONAL_LOCKS": "0"})
        output = [bytearray(), bytearray()]
        deadline = time.monotonic() + timeout
        try:
            with selectors.DefaultSelector() as selected:
                for index, stream in enumerate((child.stdout, child.stderr)):
                    os.set_blocking(stream.fileno(), False)
                    selected.register(stream, selectors.EVENT_READ, index)
                while selected.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("Linux command timed out; inspect its state before retrying")
                    for key, _ in selected.select(min(remaining, 0.1)):
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selected.unregister(key.fileobj)
                            continue
                        output[key.data].extend(chunk)
                        if len(output[key.data]) > MAX_GIT_OUTPUT:
                            raise ValueError("Linux command output exceeds 8 MiB")
            code = child.wait(timeout=max(0.001, deadline - time.monotonic()))
            return code, bytes(output[0]), bytes(output[1])
        except BaseException:
            # No poll/wait has reaped the child before this path.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
            raise
        finally:
            child.stdout.close()
            child.stderr.close()


ENVIRONMENT_READY = False


def capture_environment(shell):
    marker = "MONOCODE_ENV_" + uuid.uuid4().hex
    script = "import json,os; print(" + repr(marker) + "+json.dumps(dict(os.environ)))"
    command = "/usr/bin/python3 -c " + shlex.quote(script)
    code, out, _ = run([shell, "-ilc", command], str(Path.home()), timeout=10)
    lines = [line[len(marker):] for line in out.decode("utf-8").splitlines() if line.startswith(marker)]
    if code or len(lines) != 1 or len(lines[0]) > 256 * 1024:
        return None
    environment = json.loads(lines[0])
    if not isinstance(environment, dict) or any(not isinstance(k, str) or not isinstance(v, str) or "\0" in k + v or "=" in k for k, v in environment.items()):
        return None
    return environment


def prepare_environment():
    global ENVIRONMENT_READY
    if ENVIRONMENT_READY:
        return
    # Use the selected Linux user's shell, never repository startup files or
    # an arbitrary installed Node version. Capture noisy shell output privately.
    # A configured shell that cannot answer (missing, non-POSIX, broken rc) must
    # not hide every installed agent: fall back to common POSIX shells so login
    # profiles still load user-managed tool paths.
    preferred = pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh"
    environment = None
    for shell in dict.fromkeys([preferred, "/bin/bash", "/bin/sh"]):
        try:
            environment = capture_environment(shell)
        except Exception:
            environment = None
        if environment is not None:
            break
    if environment is None:
        raise ValueError("Cannot read the Linux login-shell environment. Check shell startup and reconnect.")
    # Exclude Windows interop PATH entries; keep user-managed Linux tool paths.
    environment["PATH"] = ":".join(dict.fromkeys(folder for folder in environment.get("PATH", "").split(":") if folder.startswith("/") and not folder.startswith("/mnt/")))
    environment["WSLENV"] = ""
    os.environ.clear()
    os.environ.update(environment)
    ENVIRONMENT_READY = True


def file_bytes(path, limit):
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("Not a regular file")
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("File exceeds the supported size")
    return data


def under(parent, name):
    if not isinstance(name, str) or not name.strip() or name.startswith(("/", "\\")) or "\\" in name:
        raise ValueError("Choose a relative Linux file or folder name")
    parts = name.rstrip("/").split("/")
    if any(part in (".", "..") or "\0" in part or len(os.fsencode(part)) > 255 for part in parts):
        raise ValueError("Invalid file or folder name")
    destination = parent.joinpath(*parts)
    if not destination.parent.resolve().is_relative_to(parent.resolve()):
        raise ValueError("The destination leaves its parent directory")
    return destination


def rename_without_replace(source, destination):
    # GNU mv performs a no-clobber rename; do not turn this into os.rename,
    # which can overwrite a destination created after the existence check.
    code, _, error = run(["mv", "--no-clobber", "--no-target-directory", "--",
                          str(source), str(destination)], str(source.parent))
    if code or os.path.lexists(source):
        raise ValueError(error.decode("utf-8", errors="replace") or "Destination already exists; source was preserved")


def bounded_tree(path):
    count = 0
    size = 0
    deadline = time.monotonic() + 20
    pending = [path]
    while pending:
        item = pending.pop()
        meta = item.lstat()
        count += 1
        size += meta.st_size if stat.S_ISREG(meta.st_mode) else 0
        if count > MAX_FILES or size > 256 * 1024 * 1024 or time.monotonic() > deadline:
            raise ValueError("Operation exceeds 20,000 entries, 256 MiB, or 20 seconds; use the Linux terminal")
        if stat.S_ISDIR(meta.st_mode):
            with os.scandir(item) as entries:
                for entry in entries:
                    if count + len(pending) >= MAX_FILES:
                        raise ValueError("Operation exceeds 20,000 entries; use the Linux terminal")
                    pending.append(Path(entry.path))


AGENT_PROVIDERS = ["claude", "codex", "cursor", "opencode", "pi", "omp", "fx", "grok", "devin", "copilot", "muse"]
AGENT_NAMES = {
    "claude": ["claude"],
    "codex": ["codex"],
    "cursor": ["cursor-agent", "agent"],
    "opencode": ["opencode"],
    "pi": ["pi", "pi-coding-agent"],
    "omp": ["omp"],
    "fx": ["fx"],
    "grok": ["grok"],
    "devin": ["devin"],
    "copilot": ["copilot"],
    "muse": ["muse"],
}
# Linux tool folders that are not always exported to the login PATH.
AGENT_FOLDERS = [
    ".local/bin", ".npm-global/bin", ".cargo/bin", ".bun/bin", "n/bin",
    ".volta/bin", ".asdf/shims", ".local/share/mise/shims",
    ".grok/bin", ".fx/bin", ".claude/local", ".local/share/claude",
    ".local/share/devin/cli/_versions/current/bin",
]
# Credential evidence checked without spawning the provider or reading secrets:
# only env names and file existence are inspected. strict providers report a
# definitive "signed out" when nothing is found; others stay unknown.
AGENT_AUTH = {
    "claude": {
        "env": ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"),
        "files": (".claude/.credentials.json",),
        "settings": (".claude/settings.json", ".claude/settings.local.json"),
        "strict": True,
    },
    "codex": {
        "env": ("OPENAI_API_KEY", "CODEX_API_KEY"),
        "files": (".codex/auth.json",),
        "strict": True,
    },
    "cursor": {"env": ("CURSOR_API_KEY",)},
    "pi": {
        "env": ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY"),
        "files": (".pi/agent/auth.json",),
        "strict": True,
    },
    "omp": {
        "env": ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY", "GROQ_API_KEY"),
        "files": (".omp/agent/auth.json", ".pi/agent/auth.json"),
    },
    "fx": {"env": ("AI_GATEWAY_API_KEY", "FX_AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN")},
    "grok": {"env": ("XAI_API_KEY", "GROK_CODE_XAI_API_KEY")},
    "devin": {
        "env": ("WINDSURF_API_KEY", "DEVIN_API_KEY"),
        "files": (".local/share/devin/credentials.toml",),
        "strict": True,
    },
    # Copilot also accepts gh/GITHUB tokens. ~/.copilot/config.json is created
    # on any CLI run — not auth evidence — and the credential itself lives in
    # the system store, so env vars are the only signal; non-strict.
    "copilot": {
        "env": ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"),
    },
    "muse": {
        "env": ("META_API_KEY",),
        "files": (".config/muse/auth.json",),
        "strict": True,
    },
}


def file_mentions(candidate, needles):
    try:
        with open(candidate, "rb") as stream:
            head = stream.read(512 * 1024).lower()
    except OSError:
        return False
    return any(needle in head for needle in needles)


def agent_help(candidate, home):
    try:
        code, out, err = run([str(candidate), "--help"], str(home), timeout=2)
        return code, (out + err).decode("utf-8", errors="replace").lower()
    except (OSError, ValueError, TimeoutError):
        return 1, ""


def verify_agent(provider, name, candidate, resolved, home):
    if provider == "cursor":
        return name != "agent" or "cursor" in resolved.lower()
    if provider == "pi":
        if name == "pi-coding-agent":
            return True
        if file_mentions(candidate, (b"pi-coding-agent", b"@earendil-works/pi", b"@mariozechner/pi-coding-agent", b"pi_coding_agent")):
            return True
        code, text = agent_help(candidate, home)
        return code == 0 and "--mode" in text and "rpc" in text
    if provider == "omp":
        if file_mentions(candidate, (b"oh-my-pi", b"oh_my_pi", b"@sinkboy-chen/omp", b"@oh-my-pi", b"pi-coding-agent", b"pi_coding_agent")):
            return True
        code, text = agent_help(candidate, home)
        return code == 0 and "--mode" in text and "rpc" in text
    if provider == "fx":
        if file_mentions(candidate, (b"vercel-labs/fx", b"fx_model", b"createfxagent", b"fx acp")):
            return True
        code, text = agent_help(candidate, home)
        return code == 0 and "acp" in text and ("ask" in text or "gateway" in text)
    if provider == "grok":
        if ".grok" in Path(resolved).parts:
            return True
        if file_mentions(candidate, (b"xai-grok", b"grok build", b"docs.x.ai/build", b"grok agent")):
            return True
        code, text = agent_help(candidate, home)
        return code == 0 and ("grok build" in text or ("agent" in text and "stdio" in text))
    if provider == "devin":
        if "/devin/cli/" in resolved:
            return True
        if file_mentions(candidate, (b"cognition.ai", b"devin agent", b"devin acp", b"agent client protocol")):
            return True
        code, text = agent_help(candidate, home)
        return code == 0 and "acp" in text and ("devin" in text or "agent client protocol" in text)
    if provider == "copilot":
        # AWS Copilot shares the binary name; "github/copilot-cli" does not
        # match "github.com/aws/copilot-cli" and the help probe requires the
        # literal --acp flag rather than any "acp" trigram.
        if file_mentions(candidate, (b"@github/copilot", b"@github\\copilot", b"github/copilot-cli", b"github copilot cli", b"copilot --acp")):
            return True
        code, text = agent_help(candidate, home)
        return code == 0 and "copilot" in text and ("--acp" in text or "agent client protocol" in text or "github copilot" in text)
    if provider == "muse":
        if name.startswith("muse-bin-") and ".local" in Path(resolved).parts:
            return True
        if file_mentions(candidate, (b"muse_channel_url", b"muse-bin-", b"msp session host")):
            return True
        code, text = agent_help(candidate, home)
        return code == 0 and "serve" in text and ("msp" in text or "session host" in text)
    return True


def find_agent(provider):
    if provider == "opencode":
        raise ValueError("OpenCode's HTTP transport is not supported in WSL yet. Choose a stdio agent such as Claude or Codex.")
    names = list(AGENT_NAMES.get(provider) or [])
    if not names:
        raise ValueError("Unknown agent provider")
    home = Path.home()
    if provider == "muse":
        # The pinned runtime can outlive a broken launcher shim.
        try:
            version = (home / ".local/bin/.muse-version").read_text().strip()
        except OSError:
            version = ""
        if version:
            names = names + ["muse-bin-" + version]
    folders = [home / suffix for suffix in AGENT_FOLDERS]
    folders = [Path(folder) for folder in os.environ.get("PATH", "").split(":") if folder.startswith("/") and not folder.startswith("/mnt/")] + folders
    for name in names:
        for folder in dict.fromkeys(folders):
            candidate = folder / name
            if not candidate.is_file() or not os.access(candidate, os.X_OK):
                continue
            resolved = str(candidate.resolve())
            if resolved.startswith("/mnt/") or resolved.lower().endswith((".exe", ".cmd", ".bat")):
                continue
            if not verify_agent(provider, name, candidate, resolved, home):
                continue
            AGENT_BINARIES[provider] = str(candidate)
            return str(candidate)
    raise ValueError("%s is not installed in this WSL distribution; install its Linux CLI and retry" % provider)


def agent_authenticated(provider):
    checks = AGENT_AUTH.get(provider)
    if checks is None:
        return None
    if any(os.environ.get(name) for name in checks.get("env", ())):
        return True
    home = Path.home()
    if any((home / relative).is_file() for relative in checks.get("files", ())):
        return True
    for relative in checks.get("settings", ()):
        try:
            settings = json.loads((home / relative).read_text())
        except (OSError, ValueError):
            continue
        if isinstance(settings, dict) and settings.get("apiKeyHelper"):
            return True
    return False if checks.get("strict") else None


def handle(request):
    op = request["op"]
    path = absolute(request["path"])
    if op == "worktree_review":
        # The Rust owner verifies Git family/HEAD/index and all removal policy.
        # This OS boundary fingerprints Linux files without following symlinks.
        # Metadata only — name, mode, size, mtime — so trees of any byte size
        # review in stat time; a write between review and removal still moves
        # mtime or size and invalidates the token.
        digest = hashlib.sha256()
        pending, count, files = [path], 0, []
        deadline = time.monotonic() + 25
        while pending:
            current = pending.pop()
            count += 1
            if count > 250_000 or time.monotonic() > deadline:
                raise ValueError("Force review exceeds 250,000 entries or 25 seconds; clean up with Git")
            meta = current.lstat()
            digest.update(json.dumps([str(current.relative_to(path)), meta.st_mode, meta.st_size, meta.st_mtime_ns], ensure_ascii=True).encode())
            if stat.S_ISLNK(meta.st_mode):
                digest.update(os.fsencode(os.readlink(current)))
            elif stat.S_ISDIR(meta.st_mode):
                children = []
                with os.scandir(current) as entries:
                    for child in entries:
                        if current == path and child.name == ".git":
                            continue
                        if count + len(pending) + len(children) >= 250_000:
                            raise ValueError("Force review exceeds 250,000 entries; clean up with Git")
                        children.append(Path(child.path))
                pending.extend(sorted(children))
            elif not stat.S_ISREG(meta.st_mode):
                raise ValueError("Special files cannot be reviewed safely; clean up with Git")
            if request.get("includeFiles") and not stat.S_ISDIR(meta.st_mode) and len(files) < 100:
                files.append(str(current.relative_to(path)))
        return {"token": digest.hexdigest(), "fileCount": count - 1, "files": files}
    if op == "refresh_environment":
        global ENVIRONMENT_READY
        ENVIRONMENT_READY = False
        prepare_environment()
        AGENT_BINARIES.clear()
        return None
    if op == "agent_environment":
        prepare_environment()
        return dict(os.environ)
    if op == "resolve_agent":
        prepare_environment()
        provider = request["provider"]
        return {"path": find_agent(provider), "authenticated": agent_authenticated(provider)}
    if op == "resolve_agents":
        prepare_environment()
        resolved = {}
        for provider in AGENT_PROVIDERS:
            try:
                resolved[provider] = {"path": find_agent(provider), "authenticated": agent_authenticated(provider)}
            except ValueError as error:
                resolved[provider] = {"error": str(error)}
        return resolved
    if op == "agent_exec":
        command = request["command"]
        if command not in AGENT_BINARIES.values():
            raise ValueError("Resolve the agent in this WSL distribution before probing it")
        code, out, err = run([command, *request["args"]], str(path), timeout=15)
        if code and not out.strip():
            raise ValueError(err.decode("utf-8", errors="replace").strip())
        return out.decode("utf-8", errors="replace")
    if op == "home":
        return str(Path.home())
    if op == "skill_entries":
        result = []
        if not path.is_dir():
            return result
        with os.scandir(path) as entries:
            for index, entry in enumerate(entries):
                if index >= 2000 or len(result) >= 300:
                    break
                if entry.name.startswith('.') or entry.name == 'skills-cursor' or not entry.is_dir():
                    continue
                for name in ['SKILL.md', 'skill.md']:
                    target = Path(entry.path) / name
                    if not target.is_file():
                        continue
                    try:
                        descriptor = os.open(target, os.O_RDONLY | os.O_NONBLOCK)
                        with os.fdopen(descriptor, 'rb') as stream:
                            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                                break
                            text = stream.read(16 * 1024).decode('utf-8')
                        result.append({'path': str(target), 'folder': entry.name, 'text': text})
                    except (OSError, UnicodeError):
                        pass
                    break
        return result
    if op == "connect":
        prepare_environment()
        path = path.resolve(strict=True)
        if not path.is_dir():
            raise ValueError("Choose a Linux directory")
        code, _, _ = run(["git", "--version"], str(path))
        if code:
            raise ValueError("Git is unavailable in this distribution; install Git and reconnect")
        return {"path": str(path), "home": str(Path.home()), "platform": sys.platform}
    if op == "gh":
        args = request["args"]
        if not isinstance(args, list) or len(args) > 512 or any(not isinstance(arg, str) or "\0" in arg for arg in args):
            raise ValueError("Invalid GitHub CLI arguments")
        body = request.get("body")
        code, out, err = run(["gh", *args], str(path), body.encode() if body is not None else None)
        if code:
            raise ValueError(err.decode("utf-8", errors="replace").strip() or "Linux GitHub CLI failed")
        return out.decode("utf-8", errors="replace").strip()
    if op == "git":
        args = request["args"]
        if not isinstance(args, list) or len(args) > 512 or any(not isinstance(arg, str) or "\0" in arg for arg in args):
            raise ValueError("Invalid Git arguments")
        source = request.get("input")
        code, out, err = run(["git", "--no-pager", "-c", "core.quotepath=false", "-C", str(path), *args], str(path),
                             base64.b64decode(source, validate=True) if source else None)
        return {"code": code, "stdout": base64.b64encode(out).decode(),
                "stderr": base64.b64encode(err).decode()}
    if op == "attachment":
        global ATTACHMENTS, ATTACHMENT_BYTES, ATTACHMENT_COUNT
        encoded = request["data"]
        if len(encoded) > 28 * 1024 * 1024:
            raise ValueError("Attachment exceeds 20 MiB")
        data = base64.b64decode(encoded, validate=True)
        if len(data) > 20 * 1024 * 1024:
            raise ValueError("Attachment exceeds 20 MiB")
        if ATTACHMENTS is None:
            ATTACHMENTS = tempfile.TemporaryDirectory(prefix="monocode-attachments-")
        destination = under(Path(ATTACHMENTS.name), hashlib.sha256(data).hexdigest() + "-" + request["name"])
        if not destination.exists():
            if ATTACHMENT_COUNT >= 64 or ATTACHMENT_BYTES + len(data) > 128 * 1024 * 1024:
                raise ValueError("WSL attachment storage is full (64 files or 128 MiB); use a file in the Linux repository")
            with destination.open("xb") as stream:
                stream.write(data)
            ATTACHMENT_COUNT += 1
            ATTACHMENT_BYTES += len(data)
        return str(destination)
    if op == "diff_file":
        try:
            meta = path.stat()
        except FileNotFoundError:
            return {"exists": False, "isFile": False, "data": "", "tooLarge": False}
        large = meta.st_size > MAX_TEXT
        data = file_bytes(path, MAX_TEXT) if stat.S_ISREG(meta.st_mode) and not large else b""
        return {"exists": True, "isFile": stat.S_ISREG(meta.st_mode), "data": base64.b64encode(data).decode(), "tooLarge": large}
    if op == "list":
        entries = []
        with os.scandir(path) as reader:
            for entry in reader:
                if entry.name == ".DS_Store":
                    continue
                if len(entries) >= MAX_FILES:
                    raise ValueError("Directory exceeds 20,000 entries")
                entries.append({"name": entry.name, "path": entry.path,
                                "isDir": entry.is_dir(), "ignored": entry.name == ".git"})
        names = b"".join(os.fsencode(entry["name"]) + b"\0" for entry in entries)
        code, out, _ = run(["git", "check-ignore", "--stdin", "-z"], str(path), names)
        ignored = set(os.fsdecode(name) for name in out.split(b"\0")) if code in (0, 1) else set()
        for entry in entries:
            entry["ignored"] |= entry["name"] in ignored
        return sorted(entries, key=lambda entry: (not entry["isDir"], entry["name"].lower()))
    if op == "files":
        code, out, _ = run(["git", "ls-files", "-co", "--exclude-standard", "-z"], str(path))
        if code == 0:
            names = [os.fsdecode(name) for name in out.split(b"\0") if name]
            names = [name for name in names if not SKIP.intersection(Path(name).parts)][:MAX_FILES]
        else:
            names = []
            for count, (root, dirs, files) in enumerate(os.walk(path, followlinks=False)):
                dirs[:] = [name for name in dirs if name not in SKIP]
                names.extend(str((Path(root) / name).relative_to(path)) for name in files[:MAX_FILES - len(names)])
                if count >= 3999 or len(names) >= MAX_FILES:
                    break
        return [{"name": Path(name).name, "path": str(path / name), "relative": name} for name in names]
    if op in ("stat", "inspect", "read_many", "search_read", "line_counts"):
        paths = request["paths"]
        if len(paths) > 64:
            raise ValueError("At most 64 files per batch")
        result = []
        retained = 0
        for name in paths:
            item = absolute(name)
            try:
                meta = item.stat()
                if op == "line_counts":
                    data = file_bytes(item, 1024 * 1024)
                    count = 0 if b"\0" in data else data.count(b"\n") + int(bool(data) and not data.endswith(b"\n"))
                    result.append({"path": str(item), "lines": count})
                elif op in ("read_many", "search_read"):
                    limit = 512 * 1024 if op == "search_read" else MAX_TEXT
                    data = file_bytes(item, min(limit, MAX_TEXT - retained))
                    retained += len(data)
                    result.append({"path": str(item), "data": base64.b64encode(data).decode()})
                elif op == "inspect":
                    result.append({"path": str(item), "name": item.name, "size": meta.st_size,
                                   "isDir": stat.S_ISDIR(meta.st_mode)})
                else:
                    result.append({"path": str(item), "mtimeMs": int(meta.st_mtime * 1000) if stat.S_ISREG(meta.st_mode) else None})
            except (OSError, ValueError) as error:
                if op != "inspect":
                    result.append({"path": str(item), "mtimeMs": None, "error": str(error)})
        return result
    if op in ("read", "read_text", "preview"):
        limit = min(25 * 1024 * 1024, max(0, request.get("limit", 25 * 1024 * 1024))) if op == "read" else MAX_TEXT
        data = file_bytes(path, limit)
        if op == "read":
            return base64.b64encode(data).decode()
        if b"\0" in data:
            raise ValueError("Binary files cannot be edited")
        text = data.decode("utf-8")
        if op == "read_text":
            return text
        start = max(1, request.get("start", 1)) - 1
        count = max(1, min(12, request.get("count", 12)))
        return [line if len(line) <= 200 else line[:199] + "…" for line in text.splitlines()[start:start + count]]
    if op in ("write_text", "restore_bytes"):
        content = request["content"].encode("utf-8") if op == "write_text" else base64.b64decode(request["data"], validate=True)
        if len(content) > MAX_TEXT:
            raise ValueError("File exceeds 8 MiB")
        if op == "restore_bytes":
            path.parent.mkdir(parents=True, exist_ok=True)
        destination = path.resolve(strict=path.exists())
        mode = stat.S_IMODE(destination.stat().st_mode) if destination.exists() else None
        descriptor, temporary = tempfile.mkstemp(prefix=".monocode-", dir=destination.parent)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
                if mode is not None:
                    os.fchmod(stream.fileno(), mode)
            os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return None
    if op == "diff_numstat":
        with tempfile.TemporaryDirectory(prefix="monocode-diff-") as directory:
            paths = [Path(directory) / name for name in ["before", "after"]]
            for target, key in zip(paths, ["before", "after"]):
                data = base64.b64decode(request[key], validate=True)
                if len(data) > MAX_TEXT:
                    raise ValueError("Checkpoint file exceeds 8 MiB")
                target.write_bytes(data)
            code, out, err = run(["git", "diff", "--no-index", "--no-ext-diff", "--numstat", "--", *map(str, paths)], str(path))
            if code not in (0, 1):
                raise ValueError(err.decode("utf-8", errors="replace"))
            return out.decode("utf-8", errors="replace")
    if op == "remove_checkpoint_file":
        if path.is_dir() and not path.is_symlink():
            raise ValueError("A directory replaced this file; inspect it before undoing")
        path.unlink(missing_ok=True)
        return None
    if op == "canonical_directory":
        result = path.resolve(strict=True)
        if not result.is_dir():
            raise ValueError("Choose a Linux directory")
        return str(result)
    if op == "canonical":
        return str(path.resolve(strict=True))
    if op == "new_path":
        if os.path.lexists(path) or path == Path("/"):
            raise ValueError("Choose a new worktree path; existing paths are preserved")
        parent = path.parent.resolve(strict=True)
        if not parent.is_dir():
            raise ValueError("Worktree parent must be a directory")
        return str(parent / path.name)
    if op == "create":
        destination = under(path, request["name"])
        destination.parent.mkdir(parents=True, exist_ok=True)
        if request["isDir"]:
            destination.mkdir()
        else:
            with destination.open("xb"):
                pass
        return str(destination)
    if op == "delete":
        if path == Path("/"):
            raise ValueError("Cannot delete the distribution root")
        bounded_tree(path)
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
        return None
    if op in ("rename", "copy", "move"):
        if path == Path("/") or not os.path.lexists(path):
            raise ValueError("Choose an existing file or folder")
        if op == "rename":
            destination = under(path.parent, request["name"])
        else:
            parent = absolute(request["destination"]).resolve(strict=True)
            if not parent.is_dir():
                raise ValueError("Destination is not a folder")
            destination = parent / path.name
        if path.is_dir() and not path.is_symlink() and destination.parent.resolve().is_relative_to(path.resolve()):
            raise ValueError("Cannot paste a folder into itself")
        if op != "copy":
            if path == destination:
                return str(path)
            destination.parent.mkdir(parents=True, exist_ok=True)
            rename_without_replace(path, destination)
        else:
            bounded_tree(path)
            for index in range(1001):
                suffix = "" if index == 0 else " copy" if index == 1 else f" copy {index}"
                candidate = destination.with_name(path.stem + suffix + path.suffix)
                if os.path.lexists(candidate):
                    continue
                # Creation is exclusive. If another actor claims this path, fail
                # visibly instead of retrying an ambiguously partial copy.
                if path.is_symlink():
                    candidate.symlink_to(os.readlink(path))
                elif path.is_dir():
                    shutil.copytree(path, candidate, symlinks=True)
                else:
                    if not stat.S_ISREG(path.stat().st_mode):
                        raise ValueError("Only regular files, folders and symlinks can be copied")
                    with candidate.open("xb") as target:
                        with path.open("rb") as source:
                            shutil.copyfileobj(source, target, 64 * 1024)
                    shutil.copystat(path, candidate)
                destination = candidate
                break
            else:
                raise ValueError("Too many copies at this location")
        return str(destination)
    raise ValueError("Unsupported WSL operation")


def serve():
    while True:
        line = sys.stdin.buffer.readline(MAX_MESSAGE + 1)
        if not line:
            return
        if len(line) > MAX_MESSAGE or not line.endswith(b"\n"):
            raise ValueError("WSL request exceeds its limit")
        try:
            result = {"ok": handle(json.loads(line))}
        except Exception as error:
            result = {"error": str(error)}
        # Keep bounded encoded fragments instead of joining and copying a large
        # response into a second full-sized string, bytes object and newline copy.
        chunks, size = [], 0
        for chunk in json.JSONEncoder(ensure_ascii=True, separators=(",", ":")).iterencode(result):
            size += len(chunk)  # ensure_ascii makes characters equal wire bytes.
            if size + 1 > MAX_MESSAGE:
                chunks = ['{"error":"WSL response exceeds its limit"}']
                break
            chunks.append(chunk)
        del result, line
        for chunk in chunks:
            sys.stdout.buffer.write(chunk.encode("ascii"))
        sys.stdout.buffer.write(b"\n")
        sys.stdout.buffer.flush()
        del chunks, chunk


if __name__ == "__main__":
    serve()
