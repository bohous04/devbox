import { expect, test } from "bun:test";
import fx from "../../shared/fixtures/composer-triggers.json";
import { activeTrigger, applyPick, composerPlaceholder, filterCommands, keyAction, type KeyInput, type MenuState, type Trigger } from "./composerTrigger";

/** shared/fixtures/composer-triggers.json: the Apple apps' copy (ComposerTriggers.swift) runs the same cases. */
test("composer triggers: the shared cases", () => {
  for (const c of fx.active) expect([c.text, c.caret, activeTrigger(c.text, c.caret)]).toEqual([c.text, c.caret, c.expected as Trigger | null]);
  for (const c of fx.filter.cases) expect([c.query, filterCommands(fx.filter.commands, c.query).map((x) => x.name)]).toEqual([c.query, c.expected]);
  for (const c of fx.pick) expect(applyPick(c.text, c.trigger as Trigger, c.value)).toEqual(c.expected);
  for (const c of fx.placeholder) expect(composerPlaceholder(c)).toBe(c.expected);
  for (const c of fx.keyAction) expect({ c, got: keyAction(c.menu as MenuState | null, c.key as KeyInput, c.enterSends) as string }).toEqual({ c, got: c.expected });
});
