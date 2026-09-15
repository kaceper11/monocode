import {
  bindCopilotSession,
  cancelCopilotTurn,
  compactCopilotContext,
  copilotCommandProvider,
  forgetCopilotSession,
  respondCopilotApproval,
  respondCopilotQuestion,
  sendCopilotTurn,
  prewarmCopilotSession,
  setCopilotRuntimeMode,
  steerCopilotTurn,
  canSteerCopilotSession,
  stopCopilotSession,
} from "./copilot";
import { refreshCopilotCatalog } from "./copilotCatalog";
import { registerHarness, type HarnessAdapter } from "./registry";

export const copilotAdapter: HarnessAdapter = {
  id: "copilot",
  live: true,
  canSteer: true,
  commands: copilotCommandProvider,
  sendTurn: sendCopilotTurn,
  prewarm: prewarmCopilotSession,
  compactContext: compactCopilotContext,
  steerTurn: steerCopilotTurn,
  canSteerSession: canSteerCopilotSession,
  cancelTurn: cancelCopilotTurn,
  respondApproval: respondCopilotApproval,
  setRuntimeMode: setCopilotRuntimeMode,
  respondQuestion: respondCopilotQuestion,
  stopSession: stopCopilotSession,
  forgetSession: forgetCopilotSession,
  bindSession: bindCopilotSession,
  refreshCatalog: refreshCopilotCatalog,
};

let registered = false;

export function ensureCopilotRegistered(): void {
  if (registered) return;
  registerHarness(copilotAdapter);
  registered = true;
}
