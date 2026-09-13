import {
  bindFxSession,
  cancelFxTurn,
  forgetFxSession,
  respondFxApproval,
  sendFxTurn,
  setFxRuntimeMode,
  steerFxTurn,
  stopFxSession,
} from "./fx";
import { refreshFxCatalog } from "./fxCatalog";
import { registerHarness, type HarnessAdapter } from "./registry";

export const fxAdapter: HarnessAdapter = {
  id: "fx",
  live: true,
  canSteer: false,
  sendTurn: sendFxTurn,
  steerTurn: steerFxTurn,
  cancelTurn: cancelFxTurn,
  respondApproval: respondFxApproval,
  setRuntimeMode: setFxRuntimeMode,
  stopSession: stopFxSession,
  forgetSession: forgetFxSession,
  bindSession: bindFxSession,
  refreshCatalog: refreshFxCatalog,
};

let registered = false;

export function ensureFxRegistered(): void {
  if (registered) return;
  registerHarness(fxAdapter);
  registered = true;
}
