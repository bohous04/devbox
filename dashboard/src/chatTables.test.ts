import { expect, test } from "bun:test";
import { ACP_MIN_BRIDGE_VERSION } from "../../shared/bridgeVersion";
import { CHAT_MODELS, SAME_MODEL_ALIASES } from "../../shared/chatModels";
import tables from "../../shared/fixtures/chat-tables.json";
import { AGENT_IDS, AGENT_PROFILES } from "./newSession";

/** The iOS app copies these tables (ios/DevboxApp/Stores/ChatSwitch.swift) and checks its copy against
 *  shared/fixtures/chat-tables.json (ChatSwitchTests). This keeps that JSON equal to the source: when it fails,
 *  write the `actual` value below into the JSON and update ChatSwitch.swift to match. */
test("shared/fixtures/chat-tables.json matches the tables the iOS app copies", () => {
  const actual = {
    agentIds: AGENT_IDS,
    profiles: Object.fromEntries(AGENT_IDS.map((id) => {
      const p = AGENT_PROFILES[id];
      return [id, { label: p.label, proxy: p.proxy, runtime: p.runtime, acp: p.acp ?? null, acpLive: p.acpLive ?? false, chatOnly: p.chatOnly ?? false }];
    })),
    chatModels: CHAT_MODELS,
    sameModelAliases: SAME_MODEL_ALIASES,
    acpMinBridgeVersion: ACP_MIN_BRIDGE_VERSION,
  };
  expect(tables).toEqual(JSON.parse(JSON.stringify(actual)));
});
