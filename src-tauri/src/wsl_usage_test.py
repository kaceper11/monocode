"""Executed by the Rust WSL usage fixture test after loading wsl_bridge.py."""
import sqlite3
from unittest.mock import patch

with tempfile.TemporaryDirectory() as temporary:
    home = Path(temporary)
    with patch.object(Path, "home", return_value=home):
        parent = home / ".cursor/acp-sessions/parent"
        parent.mkdir(parents=True)
        connection = sqlite3.connect(parent / "store.db")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE blobs (id TEXT, data BLOB)")
        payload = {"content": [{"type": "tool-call", "toolCallId": "call-12345678\nfc_12345678", "toolName": "Shell", "args": {"command": "pwd"}}]}
        connection.execute("INSERT INTO blobs VALUES (?, ?)", ("tool", json.dumps(payload).encode()))
        connection.commit()
        request = {"sessionId": "parent", "toolCallIds": ["fc_12345678"]}
        snapshot = cursor_stores(request)
        assert len(snapshot) == 1 and json.loads(snapshot[0]["blobs"][0][1]) == payload
        assert cursor_stores({**request, "sessionId": "other"}) == []
        assert cursor_stores({**request, "toolCallIds": []}) == []
        try:
            cursor_stores({**request, "sessionId": "../parent"})
            raise AssertionError("accepted a path-like session id")
        except ValueError:
            pass
        # An active WAL stays readable and a new committed row is visible.
        connection.execute("INSERT INTO blobs VALUES (?, ?)", ("new", json.dumps({"content": [{**payload["content"][0], "args": {"command": "git status"}}]}).encode()))
        connection.commit()
        assert "git status" in cursor_stores(request)[0]["blobs"][0][1]
        connection.close()

        child = home / ".cursor/acp-sessions/child"
        child.mkdir()
        connection = sqlite3.connect(child / "store.db")
        connection.execute("CREATE TABLE meta (key TEXT, value TEXT)")
        connection.execute("CREATE TABLE blobs (id TEXT, data BLOB)")
        metadata = {"agentId": "child", "subagentInfo": {"parentAgentId": "parent", "toolCallId": "fc_12345678"}}
        connection.execute("INSERT INTO meta VALUES ('0', ?)", (json.dumps(metadata).encode().hex(),))
        connection.execute("INSERT INTO blobs VALUES ('message', ?)", (json.dumps({"role": "assistant", "content": [{"type": "text", "text": "hello"}]}).encode(),))
        connection.commit()
        connection.close()
        snapshot = cursor_stores({**request, "subagents": True})
        assert len(snapshot) == 1 and snapshot[0]["metadata"] == metadata
        assert cursor_stores({**request, "subagents": True, "knownRevisions": {"child": "1"}}) == []
        assert cursor_stores({**request, "subagents": True, "sessionId": "wrong-parent"}) == []

        # The HTTP request stays inside the guest and credentials never appear in results.
        import urllib.request
        import io
        old_prepare = prepare_environment
        prepare_environment = lambda: None
        credentials = home / ".claude/.credentials.json"
        credentials.parent.mkdir()
        credentials.write_text(json.dumps({"claudeAiOauth": {"accessToken": "guest-secret"}}))
        class Response(io.BytesIO):
            status = 200
        class Opener:
            def open(self, request, timeout):
                assert request.full_url == "https://api.anthropic.com/api/oauth/usage"
                assert request.get_header("Authorization") == "Bearer guest-secret"
                assert timeout == 10
                return Response(b'{"five_hour":{"utilization":25}}')
        with patch.dict(os.environ, {}, clear=True), patch.object(urllib.request, "build_opener", return_value=Opener()):
            result = claude_usage()
            assert result["status"] == "ok" and "guest-secret" not in json.dumps(result)
            credentials.unlink()
            assert claude_usage()["status"] == "unavailable"
        prepare_environment = old_prepare
