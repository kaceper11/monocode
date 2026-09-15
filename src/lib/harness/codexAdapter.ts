import {
  bindCodexSession,
  cancelCodexTurn,
  compactCodexContext,
  forgetCodexSession,
  keepCodexQuestionOpen,
  prewarmCodexSession,
  respondCodexApproval,
  respondCodexQuestion,
  sendCodexTurn,
  setCodexRuntimeMode,
  steerCodexTurn,
  canSteerCodexSession,
  stopCodexSession,
} from "./codex";
import {
  generateCodexBranchName,
  generateCodexCommitMessage,
  generateCodexPrContent,
} from "./codexGit";
import { refreshCodexCatalog } from "./codexCatalog";
import { generateCodexSessionTitle } from "./codexTitle";
import { warmupCodexText } from "./codexText";
import { registerHarness, type HarnessAdapter } from "./registry";

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  live: true,
  sendTurn: sendCodexTurn,
  prewarm: prewarmCodexSession,
  compactContext: compactCodexContext,
  steerTurn: steerCodexTurn,
  canSteerSession: canSteerCodexSession,
  cancelTurn: cancelCodexTurn,
  respondApproval: respondCodexApproval,
  setRuntimeMode: setCodexRuntimeMode,
  respondQuestion: respondCodexQuestion,
  keepQuestionOpen: keepCodexQuestionOpen,
  stopSession: stopCodexSession,
  forgetSession: forgetCodexSession,
  bindSession: bindCodexSession,
  refreshCatalog: refreshCodexCatalog,
  generateTitle: generateCodexSessionTitle,
  generateCommitMessage: generateCodexCommitMessage,
  generatePrContent: generateCodexPrContent,
  generateBranchName: generateCodexBranchName,
  warmupText: warmupCodexText,
};

let registered = false;

export function ensureCodexRegistered(): void {
  if (registered) return;
  registerHarness(codexAdapter);
  registered = true;
}
