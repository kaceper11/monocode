import {
  bindClaudeSession,
  cancelClaudeTurn,
  canSteerClaudeSession,
  compactClaudeContext,
  forgetClaudeSession,
  prewarmClaudeSession,
  respondClaudeApproval,
  respondClaudeQuestion,
  sendClaudeTurn,
  setClaudeRuntimeMode,
  steerClaudeTurn,
  stopClaudeSession,
} from "./claude";
import { refreshClaudeCatalog } from "./claudeCatalog";
import {
  generateClaudeBranchName,
  generateClaudeCommitMessage,
  generateClaudePrContent,
} from "./claudeGit";
import { generateClaudeSessionTitle } from "./claudeTitle";
import { warmupClaudeText } from "./claudeText";
import { registerHarness, type HarnessAdapter } from "./registry";

export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  live: true,
  sendTurn: sendClaudeTurn,
  prewarm: prewarmClaudeSession,
  compactContext: compactClaudeContext,
  steerTurn: steerClaudeTurn,
  canSteerSession: canSteerClaudeSession,
  cancelTurn: cancelClaudeTurn,
  respondApproval: respondClaudeApproval,
  setRuntimeMode: setClaudeRuntimeMode,
  respondQuestion: respondClaudeQuestion,
  stopSession: stopClaudeSession,
  forgetSession: forgetClaudeSession,
  bindSession: bindClaudeSession,
  refreshCatalog: refreshClaudeCatalog,
  generateTitle: generateClaudeSessionTitle,
  generateCommitMessage: generateClaudeCommitMessage,
  generatePrContent: generateClaudePrContent,
  generateBranchName: generateClaudeBranchName,
  warmupText: warmupClaudeText,
};

let registered = false;

export function ensureClaudeRegistered(): void {
  if (registered) return;
  registerHarness(claudeAdapter);
  registered = true;
}
