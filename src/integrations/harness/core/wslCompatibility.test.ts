import { describe, expect, it } from "vitest";
import bridgeSource from "../../../../src-tauri/src/wsl_bridge.py?raw";
import { HARNESSES } from "../../../features/sessions/model/session";

// Keep this tied to the upstream registry: adding a provider must force an
// explicit decision at the guest discovery boundary.
describe("WSL provider coverage", () => {
  it("accounts for every registered harness in guest discovery", () => {
    const declaration = /^AGENT_PROVIDERS = (\[.*\])$/m.exec(bridgeSource);
    expect(declaration).not.toBeNull();
    expect(JSON.parse(declaration![1]).sort()).toEqual([...HARNESSES].sort());
  });
});
