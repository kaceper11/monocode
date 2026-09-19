import {
  bindMuseSession,
  cancelMuseTurn,
  compactMuseContext,
  forgetMuseSession,
  keepMuseQuestionOpen,
  respondMuseApproval,
  respondMuseQuestion,
  sendMuseTurn,
  steerMuseTurn,
  stopMuseSession,
} from "./muse";
import { refreshMuseCatalog } from "./museCatalog";
import { registerHarness, type HarnessAdapter } from "./registry";

export const museAdapter: HarnessAdapter = {
  id: "muse",
  live: true,
  canSteer: true,
  sendTurn: sendMuseTurn,
  compactContext: compactMuseContext,
  steerTurn: steerMuseTurn,
  cancelTurn: cancelMuseTurn,
  respondApproval: respondMuseApproval,
  respondQuestion: respondMuseQuestion,
  keepQuestionOpen: keepMuseQuestionOpen,
  stopSession: stopMuseSession,
  forgetSession: forgetMuseSession,
  bindSession: bindMuseSession,
  refreshCatalog: refreshMuseCatalog,
};

let registered = false;

export function ensureMuseRegistered(): void {
  if (registered) return;
  registerHarness(museAdapter);
  registered = true;
}
