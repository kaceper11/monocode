import {
  bindDevinSession,
  cancelDevinTurn,
  compactDevinContext,
  devinCommandProvider,
  forgetDevinSession,
  respondDevinApproval,
  respondDevinQuestion,
  sendDevinTurn,
  steerDevinTurn,
  stopDevinSession,
} from "./devin";
import { refreshDevinCatalog } from "./devinCatalog";
import { registerHarness, type HarnessAdapter } from "./registry";

export const devinAdapter: HarnessAdapter = {
  id: "devin",
  live: true,
  canSteer: true,
  commands: devinCommandProvider,
  sendTurn: sendDevinTurn,
  compactContext: compactDevinContext,
  steerTurn: steerDevinTurn,
  cancelTurn: cancelDevinTurn,
  respondApproval: respondDevinApproval,
  respondQuestion: respondDevinQuestion,
  stopSession: stopDevinSession,
  forgetSession: forgetDevinSession,
  bindSession: bindDevinSession,
  refreshCatalog: refreshDevinCatalog,
};

let registered = false;

export function ensureDevinRegistered(): void {
  if (registered) return;
  registerHarness(devinAdapter);
  registered = true;
}
