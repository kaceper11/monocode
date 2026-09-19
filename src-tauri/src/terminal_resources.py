"""On-demand Linux terminal resources, loaded into the existing WSL bridge.
No daemon, worker, shared socket or process supervisor. Per-spawn markers are
inherited by descendants; the explicitly marked root is never a stop target.
"""
import os as _tr_os
import signal as _tr_signal
import time as _tr_time
import select as _tr_select
from pathlib import Path as _tr_Path

_TR_PREV = {}


def _tr_marker(value):
    if not isinstance(value, str) or not value or len(value) > 128 or any(
        not (c.isascii() and (c.isalnum() or c in "-_")) for c in value
    ):
        raise ValueError("Invalid terminal generation")
    return value


def _tr_environment(pid):
    try:
        with open(f"/proc/{pid}/environ", "rb") as stream:
            data = stream.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError("Process environment exceeds resource sampling limit")
        values = dict(field.split(b"=", 1) for field in data.split(b"\0") if b"=" in field)
        marker = values.get(b"MONOCODE_PTY", b"").decode("ascii")
        root = int(values.get(b"MONOCODE_PTY_ROOT", b"0"))
        return marker, root
    except (ProcessLookupError, FileNotFoundError, PermissionError, UnicodeError):
        return None
    except ValueError:
        return None


def _tr_stat(pid):
    try:
        text = _tr_Path(f"/proc/{pid}/stat").read_text()
        end = text.rfind(")")
        fields = text[end + 2:].split()
        return {"name": text[text.find("(") + 1:end], "state": fields[0],
                "started": int(fields[19]), "cpu": int(fields[11]) + int(fields[12]),
                "rss": max(0, int(fields[21])) * _tr_os.sysconf("SC_PAGE_SIZE")}
    except (ProcessLookupError, FileNotFoundError):
        return None
    except (IndexError, ValueError, PermissionError) as error:
        raise ValueError(f"Cannot sample Linux process {pid}: {error}") from error


def _tr_snapshot(markers):
    trees = {marker: {} for marker in markers}
    deadline = _tr_time.monotonic() + 5
    with _tr_os.scandir("/proc") as entries:
        count = 0
        for entry in entries:
            if not entry.name.isdigit():
                continue
            count += 1
            if count > 32768 or _tr_time.monotonic() > deadline:
                raise ValueError("Linux process sampling limit reached; no partial sample was returned")
            pid = int(entry.name)
            env = _tr_environment(pid)
            if not env or env[0] not in trees:
                continue
            parsed = _tr_stat(pid)
            if parsed and parsed["state"] != "Z":
                trees[env[0]][pid] = {**parsed, "root": env[1]}
    return trees


def _tr_root(marker, members):
    roots = {row["root"] for row in members.values()}
    if len(roots) != 1:
        raise ValueError("Linux terminal root is unavailable or ambiguous")
    root = next(iter(roots))
    if root <= 1 or root not in members or _tr_environment(root) != (marker, root):
        raise ValueError("Linux terminal root exited or changed; refresh")
    return root


def _tr_stats(markers):
    trees = _tr_snapshot(markers)
    now = _tr_time.monotonic()
    hz = _tr_os.sysconf("SC_CLK_TCK")
    # Keep baselines from other windows without unbounded retention.
    for key, (_, at) in list(_TR_PREV.items()):
        if now - at >= 60:
            del _TR_PREV[key]
    if len(_TR_PREV) + sum(len(tree) for tree in trees.values()) > 32768:
        _TR_PREV.clear()
    result = {}
    for marker, members in trees.items():
        try:
            root = _tr_root(marker, members)
            cpu, known = {}, True
            for pid, row in members.items():
                key = (pid, row["started"])
                previous = _TR_PREV.get(key)
                _TR_PREV[key] = (row["cpu"], now)
                if previous and 0.001 < now - previous[1] < 60 and row["cpu"] >= previous[0]:
                    cpu[pid] = (row["cpu"] - previous[0]) / hz / (now - previous[1]) * 100
                else:
                    known = False
            workload = [pid for pid in members if pid != root]
            top = max(workload, key=lambda pid: (cpu.get(pid, 0), members[pid]["rss"])) if workload else None
            result[marker] = {"cpuPct": sum(cpu.values()) if known else None,
                              "rssBytes": sum(row["rss"] for row in members.values()),
                              "processes": len(members), "workload": bool(workload),
                              "top": members[top]["name"] if top else None, "error": None}
        except ValueError as error:
            result[marker] = {"cpuPct": None, "rssBytes": None, "processes": None,
                              "workload": False, "top": None, "error": str(error)}
    return result


def _tr_stop(marker):
    if not hasattr(_tr_os, "pidfd_open") or not hasattr(_tr_signal, "pidfd_send_signal"):
        raise ValueError("Safe workload stopping requires WSL 2 and Python 3.9 or newer")
    members = _tr_snapshot([marker])[marker]
    root = _tr_root(marker, members)
    root_start = members[root]["started"]
    handles = []

    def verify_root():
        current = _tr_stat(root)
        if not current or current["started"] != root_start or _tr_environment(root) != (marker, root):
            raise ValueError("Linux terminal identity changed; no further processes were stopped")

    try:
        for pid, row in members.items():
            if pid <= 1 or pid in (root, _tr_os.getpid()):
                continue
            verify_root()
            try:
                descriptor = _tr_os.pidfd_open(pid)
            except ProcessLookupError:
                continue
            # Append immediately so every failure still closes this handle.
            handles.append(descriptor)
            current = _tr_stat(pid)
            if not current or current["started"] != row["started"] or _tr_environment(pid) != (marker, root):
                handles.pop()
                _tr_os.close(descriptor)
                continue
            try:
                _tr_signal.pidfd_send_signal(descriptor, _tr_signal.SIGTERM)
            except ProcessLookupError:
                pass
        poll = _tr_select.poll()
        for descriptor in handles:
            poll.register(descriptor, _tr_select.POLLIN)
        remaining = set(handles)
        deadline = _tr_time.monotonic() + 1
        while remaining and _tr_time.monotonic() < deadline:
            verify_root()
            for descriptor, _events in poll.poll(50):
                remaining.discard(descriptor)
                poll.unregister(descriptor)
        for descriptor in remaining:
            verify_root()
            try:
                _tr_signal.pidfd_send_signal(descriptor, _tr_signal.SIGKILL)
            except ProcessLookupError:
                pass
    finally:
        for descriptor in handles:
            _tr_os.close(descriptor)
    return None


def terminal_resource_request(request):
    if request["op"] == "terminal_resources":
        markers = request.get("markers")
        if not isinstance(markers, list) or len(markers) > 1024:
            raise ValueError("Invalid terminal resource request")
        return _tr_stats(list(dict.fromkeys(_tr_marker(marker) for marker in markers)))
    if request["op"] == "terminal_stop_workload":
        return _tr_stop(_tr_marker(request.get("marker")))
    raise ValueError("Unknown terminal resource operation")
