"""Guest bridge regression tests; run with Python 3 on macOS/Linux or in WSL."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "src-tauri/src/wsl_bridge.py"
bridge = {"__name__": "fixture"}
exec(compile(SOURCE.read_text(), str(SOURCE), "exec"), bridge)


class GuestDiscoveryTests(unittest.TestCase):
    def test_custom_credential_directories_do_not_fall_back_to_default_accounts(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            with patch.dict(os.environ, {"HOME": directory}, clear=True), patch.object(Path, "home", return_value=home):
                for provider, key, default, filename in (
                    ("codex", "CODEX_HOME", ".codex", "auth.json"),
                    ("claude", "CLAUDE_CONFIG_DIR", ".claude", ".credentials.json"),
                    ("pi", "PI_CODING_AGENT_DIR", ".pi/agent", "auth.json"),
                ):
                    with self.subTest(provider=provider):
                        original = home / default / filename
                        original.parent.mkdir(parents=True, exist_ok=True)
                        original.write_text("{}")
                        selected = home / (provider + "-custom")
                        selected.mkdir()
                        os.environ[key] = str(selected)
                        self.assertIs(bridge["agent_authenticated"](provider), False)
                        (selected / filename).write_text("{}")
                        self.assertIs(bridge["agent_authenticated"](provider), True)
                        os.environ[key] = "~/" + selected.name
                        self.assertEqual(bridge["config_root"](key, default), selected)
                        self.assertIs(bridge["agent_authenticated"](provider), True)
                        os.environ[key] = "relative/config"
                        with self.assertRaises(ValueError):
                            bridge["agent_authenticated"](provider)
                        del os.environ[key]

    def test_claude_helper_uses_the_selected_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            selected = home / "selected"
            selected.mkdir()
            (selected / "settings.json").write_text('{"apiKeyHelper":"guest-command"}')
            with patch.dict(os.environ, {"HOME": directory, "CLAUDE_CONFIG_DIR": "~/selected"}, clear=True), patch.object(Path, "home", return_value=home):
                self.assertIs(bridge["agent_authenticated"]("claude"), True)

    def test_antigravity_wrapper_and_opencode_are_guest_discoverable(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            wrapper = home / ".local/share/agy-acp/agy_acp_server.par"
            wrapper.parent.mkdir(parents=True)
            wrapper.write_text("#!/bin/sh\nexit 0\n")
            wrapper.chmod(0o700)
            opencode = home / ".local/bin/opencode"
            opencode.parent.mkdir(parents=True)
            opencode.write_text("#!/bin/sh\nexit 0\n")
            opencode.chmod(0o700)
            with patch.dict(os.environ, {"HOME": directory, "PATH": ""}, clear=True), patch.object(Path, "home", return_value=home):
                self.assertEqual(bridge["find_agent"]("antigravity"), str(wrapper))
                self.assertEqual(bridge["find_agent"]("opencode"), str(opencode))
                self.assertIsNone(bridge["agent_authenticated"]("antigravity"))


if __name__ == "__main__":
    unittest.main()
