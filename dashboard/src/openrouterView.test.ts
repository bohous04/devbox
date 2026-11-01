import { expect, test } from "bun:test";
import { openrouterStatus, saveLabel } from "./openrouterView";

// The card must distinguish TWO different incomplete states, not merge them into "not set".
// If the key is missing, you go to the key field; if the model is missing, to the model field.
// One shared message would send the person looking in the wrong place.
test("state distinguishes a missing key from a missing model", () => {
  expect(openrouterStatus({ hasKey: false, model: null }).text).toBe("Not connected");
  expect(openrouterStatus({ hasKey: false, model: "stealth/ox-alpha" }).text).toBe("Not connected");
  expect(openrouterStatus({ hasKey: true, model: null }).text).toBe("No model set");
  expect(openrouterStatus({ hasKey: true, model: "stealth/ox-alpha" }).text).toBe("Active");
});

// The "ok" tone may only be carried by a state in which the profile will really run. Green on a half
// configuration is worse than none: the session then drops into zsh with a message the card
// just denied.
test("green only for a complete configuration", () => {
  expect(openrouterStatus({ hasKey: true, model: "stealth/ox-alpha" }).tone).toBe("ok");
  expect(openrouterStatus({ hasKey: true, model: null }).tone).toBe("warn");
  expect(openrouterStatus({ hasKey: false, model: null }).tone).toBe("warn");
});

// An unknown state (older dashboard against a newer devd) must not fall back to "Active".
test("an unloaded state is not Active", () => {
  expect(openrouterStatus(null).text).toBe("Loading…");
  expect(openrouterStatus(null).tone).toBe("warn");
});

// The button label says what will happen: overwriting an existing key is a different operation
// than entering it for the first time, and disconnecting is a third.
test("the key button label says what will happen", () => {
  expect(saveLabel(false, "sk-or-v1-x")).toBe("Save key");
  expect(saveLabel(true, "sk-or-v1-x")).toBe("Replace key");
  expect(saveLabel(true, "")).toBe("Disconnect");
  // With no key and no input there is nothing to do — the button keeps its text, the UI handles disabled.
  expect(saveLabel(false, "")).toBe("Save key");
});

test("whitespace is not a key — a pasted space must not look like disconnecting", () => {
  expect(saveLabel(true, "   ")).toBe("Disconnect");
  expect(saveLabel(true, "  sk-or-v1-x  ")).toBe("Replace key");
});
