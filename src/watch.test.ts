/** watch試作の純粋部テスト */
import { describe, expect, test } from "bun:test";
import { buildEnv, parseOutboxFileName } from "./watch";

describe("watch outbox", () => {
  test("ファイル名パース", () => {
    expect(parseOutboxFileName("2026-09-18T07-00-00-000Z-goal_complete-gabc123.json")).toEqual({
      event: "goal_complete",
      goal: "gabc123",
    });
    expect(parseOutboxFileName("notes.txt")).toBeNull();
    expect(parseOutboxFileName("a.json")).toBeNull();
  });

  test("環境変数組み立て", () => {
    const env = buildEnv("/r", "/r/outbox/f.json", { event: "loop_stopped", goal: "g-1" });
    expect(env["GH_ROOT"]).toBe("/r");
    expect(env["GH_FILE"]).toBe("/r/outbox/f.json");
    expect(env["GH_EVENT"]).toBe("loop_stopped");
    expect(env["GH_GOAL"]).toBe("g-1");
  });
});

describe("watch notify", () => {
  test("対象種別のみ通知文・score付き", async () => {
    const { notifyMessage } = await import("./watch");
    expect(notifyMessage("goal_complete", "g-1", { score: 95, title: "T" })).toEqual({
      title: "graphhopper: T",
      body: "完了: g-1 (score 95)",
    });
    expect(notifyMessage("eval_gave_up", "g-1", {})?.body).toContain("要修正");
    expect(notifyMessage("verifier_verdict", "g-1", {})).toBeNull();
    expect(notifyMessage("loop_stopped", "g-1", {})?.body).toContain("無限ループ");
  });
});
