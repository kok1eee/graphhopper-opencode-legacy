/** system注入節約（full→brief）のテスト。tmp rootでpluginを直接駆動する */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Graphhopper } from "./index";
import { PONYTAIL_RULES } from "./ponytail-rules";
import { setPhase, startGoal } from "./state";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "gh-plugin-test-"));
}

async function transform(
  root: string,
  sessionID: string,
): Promise<string[]> {
  const plugin = (await Graphhopper({
    client: {},
    $: {},
    directory: root,
  } as never)) as Record<
    string,
    (input: { sessionID?: string }, output: { system: string[] }) => Promise<void>
  >;
  const out: { system: string[] } = { system: [] };
  await plugin["experimental.chat.system.transform"]({ sessionID }, out);
  return out.system;
}

describe("system注入節約", () => {
  test("初回full→2回目brief（同一session/goal/phase）", async () => {
    const root = tmpRoot();
    startGoal(root, "t", "sA");
    const first = await transform(root, "sA");
    expect(first.some((s) => s.includes("（詳細）"))).toBe(true);
    const second = await transform(root, "sA");
    expect(second.some((s) => s.includes("（詳細）"))).toBe(false);
    expect(second.some((s) => s.includes("次のアクション"))).toBe(true);
  });

  test("phase遷移でfullに戻る", async () => {
    const root = tmpRoot();
    startGoal(root, "t", "sB");
    await transform(root, "sB");
    await transform(root, "sB");
    setPhase(root, "implementing");
    const third = await transform(root, "sB");
    expect(third.some((s) => s.includes("（詳細）"))).toBe(true);
    expect(third.some((s) => s.includes(PONYTAIL_RULES.slice(0, 40)))).toBe(true);
    const fourth = await transform(root, "sB");
    expect(fourth.some((s) => s.includes(PONYTAIL_RULES.slice(0, 40)))).toBe(false);
  });

  test("別sessionは無注入・doneは注入なし", async () => {
    const root = tmpRoot();
    startGoal(root, "t", "sC");
    await transform(root, "sC");
    const other = await transform(root, "sOther");
    expect(other.some((s) => s.includes("次のアクション"))).toBe(false);
    setPhase(root, "implementing");
    setPhase(root, "polish");
    setPhase(root, "done");
    const done = await transform(root, "sC");
    expect(done.some((s) => s.includes("次のアクション"))).toBe(false);
  });

  test("active無しはFULL guide・active有りは短縮", async () => {
    const root = tmpRoot();
    const none = await transform(root, "sX");
    expect(none.some((s) => s.includes("ループを開始せよ"))).toBe(true);
    startGoal(root, "t", "sX");
    const active = await transform(root, "sX");
    expect(active.some((s) => s.includes("ループを開始せよ"))).toBe(false);
    expect(active.some((s) => s.includes("常駐・goal進行中"))).toBe(true);
  });
});
