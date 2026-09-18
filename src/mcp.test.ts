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
import { createServer } from "./mcp";

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
