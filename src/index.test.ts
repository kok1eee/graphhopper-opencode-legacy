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

  test("複数goal往復でも節約が剥がれない（Map記憶）", async () => {
    const rootA = tmpRoot();
    const rootB = tmpRoot();
    startGoal(rootA, "t", "sA");
    startGoal(rootB, "t", "sB");
    await transform(rootA, "sA"); // full
    await transform(rootB, "sB"); // full（別キー）
    // Aに戻ってもbriefのまま（単一スロットならfull再送になる）
    const back = await transform(rootA, "sA");
    expect(back.some((s) => s.includes("（詳細）"))).toBe(false);
  });
});

describe("plugin route系tool", () => {
  async function tools(root: string) {
    const plugin = (await Graphhopper({
      client: {},
      $: {},
      directory: root,
    } as never)) as Record<string, any>;
    const raw = plugin.tool as Record<string, { execute: (a: any, ctx?: any) => Promise<string> }>;
    const bound: Record<string, (a: any) => Promise<string>> = {};
    for (const [k, v] of Object.entries(raw)) {
      bound[k] = (a: any) => v.execute(a, { sessionID: "s-test" });
    }
    return bound;
  }

  test("route prompt発行＋route_set bare light→pending→goal消費", async () => {
    const { getActive, readPendingRoute } = await import("./state");
    const root = tmpRoot();
    const t = await tools(root);
    const prompt = await t.graphhopper_route({ request: "typo修正" });
    expect(prompt).toContain("route");
    expect(await t.graphhopper_route_set({ route: "light" })).toContain("pending");
    expect(readPendingRoute(root)?.route).toBe("light");
    await t.graphhopper_goal({ action: "start", title: "t" });
    expect(getActive(root)!.state.entry_route).toBe("light");
    expect(readPendingRoute(root)).toBeNull();
  });

  test("selector d1判定（advisory-only・goal不要）: key無しはfallback", async () => {
    const saved = process.env.LIQUID_API_KEY;
    delete process.env.LIQUID_API_KEY;
    try {
      const root = tmpRoot();
      const t = await tools(root);
      const out = await t.graphhopper_selector({
        design_excerpt: "doneの定義",
        diff_stat: "1 file +10 -2",
      });
      expect(out).toContain("判定不能");
      expect(out).toContain("従来router");
    } finally {
      if (saved !== undefined) process.env.LIQUID_API_KEY = saved;
    }
  });

  test("route_set不正→full・escalate→full＋designing", async () => {
    const { getActive, bindEntryRoute, setPhase } = await import("./state");
    const root = tmpRoot();
    const t = await tools(root);
    expect(await t.graphhopper_route_set({ route: "zzz" })).toContain("entry_route=full");
    await t.graphhopper_goal({ action: "start", title: "t" });
    expect(getActive(root)!.state.entry_route).toBe("full");
    expect(await t.graphhopper_escalate({})).toContain("昇格不可");
    // lightにしてからescalate
    const root2 = tmpRoot();
    const t2 = await tools(root2);
    await t2.graphhopper_goal({ action: "start", title: "t" });
    bindEntryRoute(root2, "light");
    setPhase(root2, "implementing");
    expect(await t2.graphhopper_escalate({})).toContain("escalated: light -> full");
    expect(getActive(root2)!.state.phase).toBe("designing");
  });

  test("goal start応答はentry route別指示（light注記）", async () => {
    const root = tmpRoot();
    const t = await tools(root);
    await t.graphhopper_route_set({ route: "light" });
    const started = await t.graphhopper_goal({ action: "start", title: "t" });
    expect(started).toContain("entry_route=light");
  });

  test("route_set directはhistoryのみ（pendingなし・goal消費なし）", async () => {
    const { getActive, readPendingRoute, readHistory } = await import("./state");
    const root = tmpRoot();
    const t = await tools(root);
    expect(await t.graphhopper_route_set({ route: "direct" })).toContain("historyのみ");
    expect(readPendingRoute(root)).toBeNull();
    await t.graphhopper_goal({ action: "start", title: "t" });
    expect(getActive(root)!.state.entry_route).toBeNull();
    // directはhistoryに1行残る（goal無しで記録された分）
    expect(readHistory(root).some((h) => h.type === "entry_route")).toBe(true);
  });
});
