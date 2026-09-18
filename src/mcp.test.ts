/**
 * graphhopper-mcp の in-process 疎通テスト。
 * InMemoryTransport で Client<->Server を直結し、tool一覧・往復を検証する。
 * state は tmp root（mkdtemp）の .graphhopper/ に隔離する。
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, lineageEnriched, parseSkeletonSymbols, resolveRoot } from "./mcp";

async function linked() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "gh-mcp-"));
}

describe("graphhopper-mcp tool一覧", () => {
  test("15 toolが登録される", async () => {
    const client = await linked();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "graphhopper_attempt",
        "graphhopper_critic_set",
        "graphhopper_discover_clear",
        "graphhopper_discover_start",
        "graphhopper_discover_tick",
        "graphhopper_edit",
        "graphhopper_eval",
        "graphhopper_goal",
        "graphhopper_hash",
        "graphhopper_invoke",
        "graphhopper_phase",
        "graphhopper_router_check",
        "graphhopper_set_eval",
        "graphhopper_status",
        "graphhopper_verifier_set",
      ].sort(),
    );
    await client.close();
  });
});

describe("graphhopper-mcp goal往復", () => {
  test("status→start→phase→attempt→status", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    expect(await call("graphhopper_status", {})).toBe("no active goal");
    const started = await call("graphhopper_goal", {
      action: "start",
      title: "mcp test",
      session_id: "sess-test",
    });
    expect(started).toContain('goal started: "mcp test"');
    expect(await call("graphhopper_phase", { phase: "implementing" })).toContain(
      "phase -> implementing",
    );
    expect(await call("graphhopper_attempt", { ok: false, note: "t1" })).toContain(
      "fail_streak=1",
    );
    const st = await call("graphhopper_status", {});
    expect(st).toContain("phase: implementing");
    expect(st).toContain("fail_streak: 1");
    await client.close();
  });

  test("verifier_set空は拒否・completeはclean要求", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    await call("graphhopper_goal", { action: "start", title: "mcp test2" });
    expect(await call("graphhopper_verifier_set", { results: [], reason: "x" })).toContain(
      "error: results が空です",
    );
    expect(await call("graphhopper_goal", { action: "complete" })).toContain(
      "error: complete には直近の graphhopper_verifier_set",
    );
    await client.close();
  });

  test("discover start→tick", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    expect(await call("graphhopper_discover_start", { target: "t", scope: "s" })).toContain(
      "discover started",
    );
    const tick = await call("graphhopper_discover_tick", { findings: [] });
    expect(tick).toContain("round 1 完了");
    await client.close();
  });

  test("eval失敗はfail_streakを進める（phase不変）", async () => {    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    await call("graphhopper_goal", { action: "start", title: "mcp test3" });
    await call("graphhopper_phase", { phase: "implementing" });
    await call("graphhopper_set_eval", { cmd: "false" });
    const out = await call("graphhopper_eval", {});
    expect(out).toContain("eval_cmd FAILED (fail_streak=1)");
    expect(await call("graphhopper_status", {})).toContain("phase: implementing");
    await client.close();
  });
});

describe("graphhopper-mcp edit gate（plugin hook と同型）", () => {
  test("designing中はsource編集が拒否・plans配下は許可", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    writeFileSync(join(root, "a.txt"), "hello\n");
    await call("graphhopper_goal", { action: "start", title: "gate test", session_id: "sess-t" });
    const h = JSON.parse(
      await call("graphhopper_hash", { filePath: "a.txt" }),
    ) as { sha1: string };
    const blocked = await call("graphhopper_edit", {
      filePath: "a.txt",
      expectedHash: h.sha1,
      oldString: "hello\n",
      newString: "hi\n",
      session_id: "sess-t",
    });
    expect(blocked).toContain('"designing" phase');
    await client.close();
  });

  test("implementing移行後はdesign docがlocked", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    const started = await call("graphhopper_goal", {
      action: "start",
      title: "lock test",
      session_id: "sess-t",
    });
    const id = started.match(/\((g-[0-9a-z]+)\)/)?.[1] ?? "";
    expect(id).not.toBe("");
    await call("graphhopper_phase", { phase: "implementing" });
    mkdirSync(join(root, ".graphhopper", "plans"), { recursive: true });
    writeFileSync(join(root, ".graphhopper", "plans", `${id}.md`), "# design\n");
    const h = JSON.parse(
      await call("graphhopper_hash", { filePath: `.graphhopper/plans/${id}.md` }),
    ) as { sha1: string };
    const locked = await call("graphhopper_edit", {
      filePath: `.graphhopper/plans/${id}.md`,
      expectedHash: h.sha1,
      oldString: "# design\n",
      newString: "# changed\n",
      session_id: "sess-t",
    });
    expect(locked).toContain("immutable once the");
    await client.close();
  });

  test("session_id未指定のstartは警告付き", async () => {
    const client = await linked();
    const root = freshRoot();
    const r = await client.callTool({
      name: "graphhopper_goal",
      arguments: { root, action: "start", title: "unbound test" },
    });
    const c = r.content as { type: string; text: string }[];
    expect(c[0]?.text ?? "").toContain("session_id 未指定");
    await client.close();
  });
});

describe("graphhopper-mcp resources", () => {
  const uri = (root: string, rel: string) =>
    `graphhopper://graphhopper/${encodeURIComponent(root)}/${rel}`;

  test("templates 4件・state/goals/plansが読める", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    const started = await call("graphhopper_goal", { action: "start", title: "res test" });
    const id = started.match(/\((g-[0-9a-z]+)\)/)?.[1] ?? "";
    expect(id).not.toBe("");
    mkdirSync(join(root, ".graphhopper", "plans"), { recursive: true });
    writeFileSync(join(root, ".graphhopper", "plans", `${id}.md`), "# design\n");

    const tpl = await client.listResourceTemplates();
    expect(tpl.resourceTemplates.length).toBe(5);

    const st = await client.readResource({ uri: uri(root, "state.json") });
    const stText = (st.contents[0] as { text: string }).text;
    expect(stText).toContain(id);

    const doc = await client.readResource({ uri: uri(root, `plans/${id}.md`) });
    expect((doc.contents[0] as { text: string }).text).toBe("# design\n");
    expect((doc.contents[0] as { mimeType?: string }).mimeType).toBe("text/markdown");
    await client.close();
  });

  test("traversal・未知名・欠番は拒否", async () => {
    const client = await linked();
    const root = freshRoot();
    await expect(client.readResource({ uri: uri(root, "../x.json") })).rejects.toThrow();
    await expect(client.readResource({ uri: uri(root, "nope.json") })).rejects.toThrow();
    await expect(
      client.readResource({ uri: uri(root, "plans/unknown.md") }),
    ).rejects.toThrow();
    await client.close();
  });
});

describe("graphhopper-mcp structured output / elicitation", () => {
  test("status/goalにstructuredContentが付く", async () => {
    const client = await linked();
    const root = freshRoot();
    const st0 = await client.callTool({ name: "graphhopper_status", arguments: { root } });
    expect((st0 as { structuredContent?: unknown }).structuredContent).toEqual({
      active: false,
    });
    const started = await client.callTool({
      name: "graphhopper_goal",
      arguments: { root, action: "start", title: "struct test", session_id: "s" },
    });
    const sc = (started as { structuredContent?: Record<string, unknown> }).structuredContent;
    expect(sc?.["action"]).toBe("start");
    expect(sc?.["ok"]).toBe(true);
    expect(typeof sc?.["goalId"]).toBe("string");
    expect(sc?.["phase"]).toBe("designing");
    await client.close();
  });

  test("elicitation未対応clientではcompleteが従来error文に倒れる", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    await call("graphhopper_goal", { action: "start", title: "elicit test" });
    // in-process Client は elicitation 未対応 → server.elicitInput が失敗し fallback
    const out = await call("graphhopper_goal", { action: "complete" });
    expect(out).toContain("error: complete には直近の graphhopper_verifier_set");
    await client.close();
  });
});

describe("graphhopper-mcp roots", () => {
  test("明示指定が最優先・未対応serverはcwdに倒れる", async () => {
    expect(await resolveRoot({ listRoots: async () => ({ roots: [] }) }, "/explicit")).toBe(
      "/explicit",
    );
    expect(
      await resolveRoot({
        listRoots: async () => {
          throw new Error("unsupported");
        },
      }),
    ).toBe(process.cwd());
  });

  test("client roots の先頭 file:// を使う", async () => {
    const dir = freshRoot();
    const got = await resolveRoot({
      listRoots: async () => ({
        roots: [{ uri: `file://${dir}`, name: "t" }],
      }),
    });
    expect(got).toBe(dir);
  });
});

describe("graphhopper-mcp prompts", () => {
  test("8 charter が列挙・取得できる", async () => {
    const client = await linked();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(
      [
        "graphhopper-critic",
        "graphhopper-librarian",
        "graphhopper-oracle",
        "graphhopper-researcher",
        "graphhopper-verifier-behavior",
        "graphhopper-verifier-general",
        "graphhopper-verifier-progress",
        "graphhopper-verifier-requirement",
      ].sort(),
    );
    await client.close();
  });

  test("researcher は query 必須・critic は design doc を埋め込む", async () => {
    const client = await linked();
    const root = freshRoot();
    await expect(
      client.getPrompt({ name: "graphhopper-researcher", arguments: { root } }),
    ).rejects.toThrow();
    const r = await client.getPrompt({
      name: "graphhopper-researcher",
      arguments: { root, query: "who calls foo", scope: "src" },
    });
    const text = (r.messages[0]?.content as { text: string }).text;
    expect(text).toContain("who calls foo");

    const started = (
      (await client.callTool({
        name: "graphhopper_goal",
        arguments: { root, action: "start", title: "prompt test" },
      })) as { content: { type: string; text: string }[] }
    ).content[0]?.text;
    const id = started?.match(/\((g-[0-9a-z]+)\)/)?.[1] ?? "";
    mkdirSync(join(root, ".graphhopper", "plans"), { recursive: true });
    writeFileSync(join(root, ".graphhopper", "plans", `${id}.md`), "# design\n");
    const c = await client.getPrompt({ name: "graphhopper-critic", arguments: { root } });
    const ctext = (c.messages[0]?.content as { text: string }).text;
    expect(ctext).toContain("# design");
    expect(ctext).toContain("PEP 758");
    await client.close();
  });
});

describe("graphhopper-mcp lineage", () => {
  const uri = (root: string, rel: string) =>
    `graphhopper://graphhopper/${encodeURIComponent(root)}/${rel}`;

  test("phase遷移・verdict・編集が系譜に載る", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    await call("graphhopper_goal", { action: "start", title: "lin test", session_id: "s" });
    await call("graphhopper_phase", { phase: "implementing" });
    await call("graphhopper_attempt", { ok: false, note: "x" });
    await call("graphhopper_phase", { phase: "polish" });
    await call("graphhopper_verifier_set", {
      results: [{ lens: "general", level: "drift", target: "implementing" }],
      reason: "t",
    });
    const res = await client.readResource({ uri: uri(root, "lineage.json") });
    const lin = JSON.parse((res.contents[0] as { text: string }).text) as {
      goals: {
        id: string;
        phases: string[];
        rewinds: number;
        verifier: { level: string }[];
        maxFailStreak: number;
      }[];
    };
    expect(lin.goals.length).toBe(1);
    expect(lin.goals[0]?.phases).toEqual(["designing", "implementing", "polish"]);
    expect(lin.goals[0]?.verifier[0]?.level).toBe("drift");
    expect(lin.goals[0]?.maxFailStreak).toBe(1);
    await client.close();
  });
});

describe("graphhopper-mcp 残り構造化出力", () => {  test("hash/edit/critic/discover に data が付く", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      return r as { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
    };
    writeFileSync(join(root, "b.txt"), "hi\n");
    const h = await call("graphhopper_hash", { filePath: "b.txt" });
    expect((h.structuredContent?.["sha1"] as string).length).toBe(40);
    await call("graphhopper_goal", { action: "start", title: "struct2", session_id: "s" });
    const c = await call("graphhopper_critic_set", { level: "clean", reason: "ok" });
    expect(c.structuredContent?.["level"]).toBe("clean");
    const d = await call("graphhopper_discover_start", { target: "t", scope: "s" });
    expect(d.structuredContent?.["round"]).toBe(0);
    await client.close();
  });
});

describe("graft連携（skeleton enrich）", () => {
  test("parseSkeletonSymbols: 行形式を抽出・上限50", () => {
    const sample = [
      "[graft] refreshed",
      "graft skeleton — src/a.ts",
      "- L1-L1  type Foo  type Foo = string;",
      "- L10-L20  function bar  function bar(x: string): void",
      "not a symbol line",
      "- L30-L30  interface Baz  interface Baz",
    ].join("\n");
    const syms = parseSkeletonSymbols(sample);
    expect(syms).toEqual([
      { name: "Foo", kind: "type", lines: "L1-L1" },
      { name: "bar", kind: "function", lines: "L10-L20" },
      { name: "Baz", kind: "interface", lines: "L30-L30" },
    ]);
  });

  test("lineageEnriched: fake runner の symbol が goal に載る", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    await call("graphhopper_goal", { action: "start", title: "sym test", session_id: "s" });
    await call("graphhopper_phase", { phase: "implementing" });
    writeFileSync(join(root, "c.txt"), "old\n");
    const h = JSON.parse(await call("graphhopper_hash", { filePath: "c.txt" })) as {
      sha1: string;
    };
    const out = await call("graphhopper_edit", {
      filePath: "c.txt",
      expectedHash: h.sha1,
      oldString: "old\n",
      newString: "new\n",
      session_id: "s",
    });
    expect(out).not.toContain("error");

    const lin = await lineageEnriched(root, async (_r, f) => [
      { name: "fake", kind: "function", lines: "L1-L1" },
    ]);
    expect(lin.goals.length).toBe(1);
    expect(lin.goals[0]?.editedFiles).toEqual(["c.txt"]);
    expect(lin.goals[0]?.editedSymbols).toEqual([
      { file: "c.txt", symbols: [{ name: "fake", kind: "function", lines: "L1-L1" }] },
    ]);
    await client.close();
  });

  test("lineageEnriched: runner 失敗時は空配列に倒れる", async () => {
    const root = freshRoot();
    const lin = await lineageEnriched(root, async () => {
      throw new Error("graft missing");
    });
    expect(lin.goals).toEqual([]);
  });
});
