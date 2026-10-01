/**
 * graphhopper-mcp の in-process 疎通テスト。
 * InMemoryTransport で Client<->Server を直結し、tool一覧・往復を検証する。
 * state は tmp root（mkdtemp）の .graphhopper/ に隔離する。
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
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
  test("23 toolが登録される", async () => {
    const client = await linked();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "graphhopper_attempt",
        "graphhopper_consult_set",
        "graphhopper_critic_set",
        "graphhopper_decide",
        "graphhopper_discover_clear",
        "graphhopper_discover_start",
        "graphhopper_discover_tick",
        "graphhopper_diff_stash",
        "graphhopper_edit",
        "graphhopper_eval",
        "graphhopper_escalate",
        "graphhopper_goal",
        "graphhopper_hash",
        "graphhopper_invoke",
        "graphhopper_phase",
        "graphhopper_route",
        "graphhopper_route_set",
        "graphhopper_router_check",
        "graphhopper_scoreboard",
        "graphhopper_selector",
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

  test("非法遷移は拒否（designing→done直指定）", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    await call("graphhopper_goal", { action: "start", title: "legal test" });
    const out = await call("graphhopper_phase", { phase: "done" });
    expect(out).toContain("非法遷移");
    // 拒否時もstructured dataを返す（欠くとMCP -32600で真因マスク）
    const raw = await client.callTool({
      name: "graphhopper_phase",
      arguments: { root, phase: "done" },
    });
    expect(
      (raw as { structuredContent?: { ok?: boolean } }).structuredContent?.ok,
    ).toBe(false);
    await client.close();
  });

  test("consult_setはgoal必須・記録後はdata付き", async () => {
    const client = await linked();
    const root = freshRoot();
    // goal無しは拒否＋data付き（欠くとMCP -32600で真因マスク）
    const raw0 = await client.callTool({
      name: "graphhopper_consult_set",
      arguments: { root, kind: "advisor", summary: "x" },
    });
    const c0 = raw0.content as { type: string; text: string }[];
    expect(c0[0]?.text).toContain("error: no active goal");
    expect(
      (raw0 as { structuredContent?: { recorded?: boolean } })
        .structuredContent?.recorded,
    ).toBe(false);
    await client.callTool({
      name: "graphhopper_goal",
      arguments: { root, action: "start", title: "consult test", session_id: "sess-c" },
    });
    const raw1 = await client.callTool({
      name: "graphhopper_consult_set",
      arguments: { root, kind: "advisor", summary: "asked x got y" },
    });
    const c1 = raw1.content as { type: string; text: string }[];
    expect(c1[0]?.text).toContain("consult recorded: advisor");
    expect(
      (raw1 as { structuredContent?: { recorded?: boolean } })
        .structuredContent?.recorded,
    ).toBe(true);
    const st = await client.callTool({
      name: "graphhopper_status",
      arguments: { root },
    });
    const stText = (st.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(stText).toContain("advisor_consult: asked x got y");
    await client.close();
  });

  test("verifier_setのper-lens modelはstatusに表示される", async () => {
    const client = await linked();
    const root = freshRoot();
    await client.callTool({
      name: "graphhopper_goal",
      arguments: { root, action: "start", title: "mixed test", session_id: "sess-m" },
    });
    const raw = await client.callTool({
      name: "graphhopper_verifier_set",
      arguments: {
        root,
        reason: "deep trial",
        results: [{ lens: "general", level: "clean", model: "t/deep" }],
      },
    });
    const c = raw.content as { type: string; text: string }[];
    expect(c[0]?.text).toContain("verifier verdict: clean");
    const st = await client.callTool({
      name: "graphhopper_status",
      arguments: { root },
    });
    const stText = (st.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(stText).toContain("models=general@t/deep");
    await client.close();
  });

  test("router_checkはRISK接触でdeep標示＋consult連携（git repo経由）", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    // git repoを用意し、baseline起点を作る
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "state.ts"), "v1\n");
    execSync("git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: root });
    // advisedでgoal開始（pending消費→entry bind）
    await call("graphhopper_route_set", { route: "advised", reason: "test" });
    await call("graphhopper_goal", { action: "start", title: "deep chain", session_id: "sess-d" });
    // risk fileに触れる（staged＝git diff可視）
    writeFileSync(join(root, "src", "gate.ts"), "v1\n");
    execSync("git add -A", { cwd: root });
    const rc = await call("graphhopper_router_check", {});
    expect(rc).toContain("route: advisor");
    expect(rc).toContain("deep: risk files touched: src/gate.ts");
    // 相談なしではimplementingに進めない（直交）
    expect(await call("graphhopper_phase", { phase: "implementing", session_id: "sess-d" })).toContain(
      "graphhopper_consult_set",
    );
    await call("graphhopper_consult_set", { kind: "advisor", summary: "asked, ok" });
    expect(await call("graphhopper_phase", { phase: "implementing", session_id: "sess-d" })).toContain(
      "phase -> implementing",
    );
    await client.close();
  });

  test("混成runはscoreboardに個別行で載る（MCP経由）", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      return r as { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
    };
    await call("graphhopper_goal", { action: "start", title: "mixed sb", session_id: "sess-m2" });
    await call("graphhopper_verifier_set", {
      reason: "mixed trial",
      results: [
        { lens: "requirement", level: "clean" },
        { lens: "behavior", level: "clean", model: "t/deep" },
        { lens: "progress", level: "clean" },
      ],
    });
    const sb = await call("graphhopper_scoreboard", {});
    const models = sb.structuredContent?.["models"] as { model: string; mixed: number }[];
    const deep = models.find((m) => m.model === "t/deep");
    expect(deep?.mixed).toBe(1);
    const sbText = (sb.content[0]?.text ?? "") as string;
    expect(sbText).toContain("混成");
    await client.close();
  });

  test("別bind sessionの操作にはdriver警告", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    await call("graphhopper_goal", { action: "start", title: "drv test", session_id: "sess-a" });
    const out = await call("graphhopper_phase", { phase: "implementing", session_id: "sess-b" });
    expect(out).toContain("phase -> implementing");
    expect(out).toContain("別session");
    // 同一sessionなら警告なし
    const out2 = await call("graphhopper_phase", { phase: "polish", session_id: "sess-a" });
    expect(out2).not.toContain("別session");
    await client.close();
  });

  test("eval_cmd設定中のattempt(fail)には二重計数注意", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    await call("graphhopper_goal", { action: "start", title: "managed test" });
    await call("graphhopper_phase", { phase: "implementing" });
    const plain = await call("graphhopper_attempt", { ok: false, note: "x" });
    expect(plain).not.toContain("二重計上");
    await call("graphhopper_set_eval", { cmd: "false" });
    const managed = await call("graphhopper_attempt", { ok: false, note: "x" });
    expect(managed).toContain("二重計上");
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

  test("eval skipは条件別文面（phase／未設定／切替／空／無goal）", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    // goal無し→error＋root表記
    const noGoal = await call("graphhopper_eval", {});
    expect(noGoal).toContain("error: no active goal");
    expect(noGoal).toContain(`root=${root}`);
    await call("graphhopper_goal", { action: "start", title: "skip matrix" });
    // designing＋未設定→両行
    const both = await call("graphhopper_eval", {});
    expect(both.startsWith("skip:")).toBe(true);
    expect(both).toContain("phase=designing");
    expect(both).toContain("eval_cmd未設定");
    expect(both).toContain(`root=${root}`);
    // designing＋設定済み→phase行のみ（最短経路）
    await call("graphhopper_set_eval", { cmd: "true" });
    const designing = await call("graphhopper_eval", {});
    expect(designing).toContain("phase=designing");
    expect(designing).not.toContain("eval_cmd未設定");
    // polish＋設定済み→phase行のみ（eval_cmdは残る。旧文面の「設定せよ」誤誘導なし）
    await call("graphhopper_phase", { phase: "implementing" });
    await call("graphhopper_phase", { phase: "polish" });
    const polished = await call("graphhopper_eval", {});
    expect(polished).toContain("phase=polish");
    expect(polished).not.toContain("eval_cmd未設定");
    // implementing＋設定済み→実行される（正例）
    await call("graphhopper_phase", { phase: "implementing" });
    const ran = await call("graphhopper_eval", {});
    expect(ran).toContain("eval_cmd passed");
    // goal切替→eval_cmd消滅→eval行
    await call("graphhopper_goal", { action: "pause" });
    await call("graphhopper_goal", { action: "start", title: "skip matrix 2" });
    const switched = await call("graphhopper_eval", {});
    expect(switched).toContain("eval_cmd未設定");
    // 空cmdはclear扱い→eval行
    await call("graphhopper_set_eval", { cmd: "true" });
    await call("graphhopper_set_eval", { cmd: "" });
    const cleared = await call("graphhopper_eval", {});
    expect(cleared).toContain("eval_cmd未設定");
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

describe("評価機能（成績表・採点）", () => {
  test("verdict/criticにmodelが記録されscoreboardに載る", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      return r as { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
    };
    await call("graphhopper_goal", { action: "start", title: "eval test" });
    await call("graphhopper_phase", { phase: "implementing" });
    await call("graphhopper_phase", { phase: "polish" });
    await call("graphhopper_critic_set", { level: "clean", reason: "ok", model: "test/critic-1" });
    await call("graphhopper_verifier_set", {
      results: [{ lens: "general", level: "clean" }],
      reason: "ok",
      model: "test/verifier-1",
    });
    const sb = await call("graphhopper_scoreboard", {});
    const models = sb.structuredContent?.["models"] as { model: string; role: string; verdicts: number; clean: number; drift: number; mixed: number }[];
    expect(models).toContainEqual({ model: "test/critic-1", role: "critic", verdicts: 1, clean: 1, drift: 0, mixed: 0 });
    expect(models).toContainEqual({ model: "test/verifier-1", role: "verifier", verdicts: 1, clean: 1, drift: 0, mixed: 0 });
    await client.close();
  });

  test("completeで採点されstatus/lineageに載る", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    await call("graphhopper_goal", { action: "start", title: "score test" });
    await call("graphhopper_phase", { phase: "implementing" });
    await call("graphhopper_attempt", { ok: false, note: "x" });
    await call("graphhopper_phase", { phase: "polish" });
    await call("graphhopper_verifier_set", {
      results: [{ lens: "general", level: "clean" }],
      reason: "ok",
    });
    // 非法遷移polish→doneは許可されている
    await call("graphhopper_phase", { phase: "done" });
    const done = await call("graphhopper_goal", { action: "complete" });
    expect(done).toContain("completed");
    // fail1・verdict1のため 100-5-0=95
    const st = await call("graphhopper_status", {});
    expect(st).toContain("score: 95");
    await client.close();
  });
});

describe("graphhopper-mcp route系tool（統合）", () => {
  test("route_set B→bind→verifier×1可・3lens拒否→escalate", async () => {
    const client = await linked();
    const root = freshRoot();
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    // prompt発行
    expect(await call("graphhopper_route", { request: "typo修正" })).toContain("route");
    // selector d1判定（advisory-only。active goal不要）。key無しはfallback
    {
      const saved = process.env.LIQUID_API_KEY;
      delete process.env.LIQUID_API_KEY;
      try {
        const sel = await call("graphhopper_selector", {
          design_excerpt: "doneの定義",
          diff_stat: "3 files +120 -40",
        });
        expect(sel).toContain("判定不能");
        expect(sel).toContain("従来router");
      } finally {
        if (saved !== undefined) process.env.LIQUID_API_KEY = saved;
      }
    }
    // graphhopper_editの軟質returnはマスクせずそのまま返す（goal無しroot）
    {
      const noGoal = await call("graphhopper_edit", {
        filePath: "src/gate.ts",
        expectedHash: "deadbeef",
        oldString: "x",
        newString: "y",
      });
      expect(noGoal).toContain("no active goal");
      expect(noGoal).not.toContain("JSON Parse error");
    }
    // 不正値はAに倒す（別rootで。pendingはgoalが消費するため）
    {
      const client2 = await linked();
      const root2 = freshRoot();
      const r2 = await client2.callTool({
        name: "graphhopper_route_set",
        arguments: { root: root2, route: "zzz" },
      });
      const c2 = r2.content as { type: string; text: string }[];
      expect(c2[0]?.text ?? "").toContain("entry_route=full");
      await client2.close();
    }
    await call("graphhopper_goal", { action: "start", title: "route test" });
    // goal先行のbind
    expect(await call("graphhopper_route_set", { route: "light" })).toContain("bind");
    // light＋general×1は可
    expect(
      await call("graphhopper_verifier_set", {
        results: [{ lens: "general", level: "clean" }],
        reason: "ok",
      }),
    ).toContain("verifier verdict: clean");
    // light＋3lensは拒否
    expect(
      await call("graphhopper_verifier_set", {
        results: [
          { lens: "requirement", level: "clean" },
          { lens: "behavior", level: "clean" },
          { lens: "progress", level: "clean" },
        ],
        reason: "ok",
      }),
    ).toContain("general×1");
    // escalateでfull＋designing
    expect(await call("graphhopper_escalate", {})).toContain("escalated: light -> full");
    // 昇格後は3lens必須（general×1は拒否）
    expect(
      await call("graphhopper_verifier_set", {
        results: [{ lens: "general", level: "clean" }],
        reason: "ok",
      }),
    ).toContain("3lens必須");
    await client.close();
  });

  test("router_check B＋大diffで自動昇格", async () => {
    const { execSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const st = await import("./state");
    const client = await linked();
    const root = freshRoot();
    execSync(`git init -q "${root}" && git -C "${root}" config user.email t@t && git -C "${root}" config user.name t`);
    writeFileSync(join(root, "a.txt"), "x\n");
    execSync(`git -C "${root}" add -A && git -C "${root}" commit -qm init`);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    await call("graphhopper_goal", { action: "start", title: "auto esc" });
    st.bindEntryRoute(root, "advised");
    await call("graphhopper_phase", { phase: "implementing" });
    // goal開始後の実装分だけが実効diffになる（start前脏れは除外される）
    writeFileSync(join(root, "a.txt"), Array(450).fill("y").join("\n") + "\n");
    const out = await call("graphhopper_router_check", {});
    expect(out).toContain("自動昇格");
    expect(st.getActive(root)!.state.phase).toBe("designing");
    expect(st.getActive(root)!.state.entry_route).toBe("full");
    await client.close();
  });

  test("start前脏れは実効diffから除外（誤遷移防止）", async () => {
    const { execSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const st = await import("./state");
    const client = await linked();
    const root = freshRoot();
    execSync(`git init -q "${root}" && git -C "${root}" config user.email t@t && git -C "${root}" config user.name t`);
    writeFileSync(join(root, "a.txt"), "x\n");
    execSync(`git -C "${root}" add -A && git -C "${root}" commit -qm init`);
    // 前goalの残骸（start前にtrackedファイルを脏す。untrackedはgit diff不可視のため対象外）
    writeFileSync(join(root, "a.txt"), "x\n" + Array(100).fill("z").join("\n") + "\n");
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      const c = r.content as { type: string; text: string }[];
      return c[0]?.text ?? "";
    };
    await call("graphhopper_goal", { action: "start", title: "dirt test" });
    const initial = st.getActive(root)!.state.initial_diff_lines!;
    expect(initial).toBeGreaterThan(50);
    // 自goalの実装は脏れに5行追加→実効diffは5行前後（未減算なら100超になる）
    const { readFileSync } = await import("node:fs");
    writeFileSync(join(root, "a.txt"), readFileSync(join(root, "a.txt"), "utf8") + Array(5).fill("w").join("\n") + "\n");
    const out = await call("graphhopper_router_check", {});
    const m = out.match(/diff_lines: (\d+)/);
    expect(m).not.toBeNull();
    const effective = Number(m![1]);
    expect(effective).toBeLessThan(50);
    expect(effective).toBeGreaterThanOrEqual(0);
    expect(out).toContain("route: advisor");
    await client.close();
  });

  test("route_set→startの対応付けは文面で突合可能", async () => {
    const client = await linked();
    const root = freshRoot();
    const callRaw = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: { ...args, root } });
      return r as { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
    };
    const call = async (name: string, args: Record<string, unknown>) =>
      (await callRaw(name, args)).content[0]?.text ?? "";
    // pending先行→start消費：文面に消費route、イベントgoal＝新goal
    await call("graphhopper_route_set", { route: "light", reason: "trace test" });
    const started = await call("graphhopper_goal", { action: "start", title: "trace test" });
    expect(started).toContain("pending entry_route=light を消費");
    const st = await import("./state");
    const gid = st.getActive(root)!.goal.id;
    const ev = st.readHistory(root).find((h) => h.type === "entry_route" && (h as { route?: unknown }).route === "light");
    expect((ev as { goal?: string } | undefined)?.goal).toBe(gid);
    expect((ev as { reason?: string } | undefined)?.reason).toBe("trace test");
    await client.close();
    // goal先行のbind：文面＋dataにgoal id
    const client2 = await linked();
    const root2 = freshRoot();
    const call2 = async (name: string, args: Record<string, unknown>) => {
      const r = await client2.callTool({ name, arguments: { ...args, root: root2 } });
      return r as { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> };
    };
    await call2("graphhopper_goal", { action: "start", title: "bind trace" });
    const gid2 = (await import("./state")).getActive(root2)!.goal.id;
    const bound = await call2("graphhopper_route_set", { route: "advised", reason: "bind trace" });
    expect(bound.content[0]?.text ?? "").toContain(gid2);
    expect(bound.structuredContent?.["goalId"]).toBe(gid2);
    expect(bound.structuredContent?.["bound"]).toBe(true);
    // pending無しstart：null→full扱い文面
    const client3 = await linked();
    const root3 = freshRoot();
    const r3 = await client3.callTool({
      name: "graphhopper_goal",
      arguments: { root: root3, action: "start", title: "legacy trace" },
    });
    const t3 = (r3.content as { type: string; text: string }[])[0]?.text ?? "";
    expect(t3).toContain("pending無し→full（未判定・legacy）扱い");
    // direct後start：directはpendingを書換えないためnull固定
    await client3.callTool({
      name: "graphhopper_route_set",
      arguments: { root: root3, route: "direct", reason: "detour" },
    });
    expect((await import("./state")).getActive(root3)!.state.entry_route).toBeNull();
    await client.close();
    await client2.close();
    await client3.close();
  });
});
