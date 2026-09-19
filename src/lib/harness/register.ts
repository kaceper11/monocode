import { ensureClaudeRegistered } from "./claudeAdapter";
import { ensureCodexRegistered } from "./codexAdapter";
import { ensureCopilotRegistered } from "./copilotAdapter";
import { ensureCursorRegistered } from "./cursorAdapter";
import { ensureDevinRegistered } from "./devinAdapter";
import { ensureFxRegistered } from "./fxAdapter";
import { ensureGrokRegistered } from "./grokAdapter";
import { ensureHermesRegistered } from "./hermesAdapter";
import { ensureMuseRegistered } from "./museAdapter";
import { ensureOpenCodeRegistered } from "./opencodeAdapter";
import { ensureOmpRegistered } from "./ompAdapter";
import { ensurePiRegistered } from "./piAdapter";

/** Register all known live harness adapters. Idempotent. */
export function registerBuiltinHarnesses(): void {
  ensureClaudeRegistered();
  ensureCursorRegistered();
  ensureCodexRegistered();
  ensureGrokRegistered();
  ensureOpenCodeRegistered();
  ensurePiRegistered();
  ensureOmpRegistered();
  ensureFxRegistered();
  ensureHermesRegistered();
  ensureDevinRegistered();
  ensureCopilotRegistered();
  ensureMuseRegistered();
}
