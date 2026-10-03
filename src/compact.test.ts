import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildKeepQuestions,
  COMPACT_KEEP_MAX,
  COMPACT_CANDIDATE_MAX,
  formatKeepList,
  pushGoalIntent,
  runCompactGate,
  selectCandidates,
  type ToolRow,
} from "./compact";

const row = (
  tool: string,
  output: unknown,
  status = "completed",
  message_id = "m-old",
): ToolRow => ({
  data: JSON.stringify({ type: "tool", tool, state: { status, input: { a: 1 }, output } }),
  message_id,
  time_created: 1,
});

describe("selectCandidates（候補抽出）", () => {
  test("最新10メッセージ内は除外（capに届かない件数で検証）", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row("read", `out${i}`, "completed", `m${i}`),
    );
    const mids = Array.from({ length: 30 }, (_, i) => `m${29 - i}`);
    const cands = selectCandidates(rows, mids);
    // m20..m29（最新10）が除外され、m0..m19の20件
    expect(cands.length).toBe(20);
    expect(cands[0].outputText).toBe("out0");
    expect(cands[19].outputText).toBe("out19");
  });
  test("古い順・40件cap", () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      row("read", `out${i}`, "completed", `m${i}`),
    );
    const cands = selectCandidates(rows, []);
    expect(cands.length).toBe(COMPACT_CANDIDATE_MAX);
    expect(cands[0].outputText).toBe("out0");
    expect(cands[39].outputText).toBe("out39");
  });
  test("未完了・空・壊れJSON・秘匿は落とす", () => {
    const rows = [
      row("read", "x", "running"),
      row("read", "   "),
      { data: "{broken", message_id: "m", time_created: 1 },
      row("bash", "key=sk-abcdefgh12345678"),
      row("read", "ok-result"),
    ];
    const cands = selectCandidates(rows, []);
    expect(cands.map((c) => c.outputText)).toEqual(["ok-result"]);
  });
  test("800字切詰め・input200字", () => {
    const cands = selectCandidates([row("read", "x".repeat(2000))], []);
    expect(cands[0].outputText.length).toBeLessThanOrEqual(801);
    expect(cands[0].outputText.endsWith("…")).toBe(true);
  });
});

describe("buildKeepQuestions/formatKeepList", () => {
  const cands = [
    { key: "keep_0", tool: "read", inputSummary: "a", outputText: "out-a" },
    { key: "keep_1", tool: "bash", inputSummary: "b", outputText: "out-b" },
  ];
  test("質問キーはkeep_N・instructionsに対象明記", () => {
    const { stateText, questions } = buildKeepQuestions(cands);
    expect(Object.keys(questions)).toEqual(["keep_0", "keep_1"]);
    expect(questions.keep_1.instructions).toContain("[bash]");
    expect(stateText).toContain("#1 [bash]");
  });
  test("閾値境界：0.5は採用・直下は不採用", () => {
    expect(
      formatKeepList(cands, { keep_0: 0.5, keep_1: 0.49 }).keptKeys,
    ).toEqual(["keep_0"]);
  });
  test("20件/8k字cap・形式固定", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      key: `keep_${i}`,
      tool: "t",
      inputSummary: "i",
      outputText: "o".repeat(500),
    }));
    const probs = Object.fromEntries(many.map((m) => [m.key, 0.99]));
    const { lines } = formatKeepList(many, probs);
    expect(lines.length).toBeLessThanOrEqual(COMPACT_KEEP_MAX);
    expect(lines.join("\n").length).toBeLessThanOrEqual(8000 + 600);
    expect(lines[0]).toMatch(/^- \[keep:0\.99\] /);
  });
});

describe("readSessionToolRows（malformed混入）", () => {
  test("壊れJSONがあっても良い行を拾う（全体skipにしない）", async () => {
    const { Database } = await import("bun:sqlite");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "gh-compact-mal-"));
    const path = join(dir, "t.db");
    const db = new Database(path);
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INT)");
    db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INT, data TEXT)");
    db.exec("INSERT INTO message VALUES ('m1', 's', 1)");
    db.exec("INSERT INTO part VALUES ('p0', 'm1', 's', 0, '{broken json')");
    db.exec("INSERT INTO part VALUES ('p1', 'm1', 's', 1, ?)", [
      JSON.stringify({ type: "tool", tool: "read", state: { status: "completed", input: {}, output: "good" } }),
    ]);
    db.close();
    const { readSessionToolRows } = await import("./compact");
    const rows = readSessionToolRows(path, "s");
    expect(rows.length).toBe(1);
    expect(rows[0].data).toContain("good");
  });
});

describe("pushGoalIntent（既存処理の移設）", () => {
  test("active goalあり→push・なし→何もしない", () => {
    const pushed: string[] = [];
    const full = {
      goal: { title: "t", id: "g1", status: "active" },
      state: { phase: "implementing", notes: null, eval_cmd: null },
    };
    expect(pushGoalIntent(() => full, (t) => void pushed.push(t))).toBe(true);
    expect(pushed[0]).toContain("g1");
    expect(pushGoalIntent(() => null, (t) => void pushed.push(t))).toBe(false);
    expect(pushed.length).toBe(1);
  });
});

describe("runCompactGate（fail-open・実DB）", () => {
  const saved = process.env.LIQUID_API_KEY;
  const setKey = (v: string | undefined) => {
    if (v === undefined) delete process.env.LIQUID_API_KEY;
    else process.env.LIQUID_API_KEY = v;
  };
  const restore = () => {
    if (saved === undefined) delete process.env.LIQUID_API_KEY;
    else process.env.LIQUID_API_KEY = saved;
  };
  const mkDb = async (parts: Array<{ mid: string; tool: string; output: unknown; t: number }>) => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "gh-compact-"));
    const path = join(dir, "t.db");
    const db = new Database(path);
    db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INT)");
    db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INT, data TEXT)");
    parts.forEach((p, i) => {
      db.exec("INSERT INTO message VALUES (?, 'sess', ?)", [`${p.mid}`, p.t]);
      db.exec("INSERT INTO part VALUES (?, ?, 'sess', ?, ?)", [
        `p${i}`, p.mid, p.t,
        JSON.stringify({ type: "tool", tool: p.tool, state: { status: "completed", input: {}, output: p.output } }),
      ]);
    });
    db.close();
    return path;
  };
  const sharedRoot = mkdtempSync(join(tmpdir(), "gh-compact-gate-"));
  const gate = (opts: {
    dbPath: string | null; sessionID: string; push: (t: string) => void; fetchFn?: typeof fetch;
  }) =>
    runCompactGate({ root: sharedRoot, timeoutMs: 50, ...opts });
  const logged = () =>
    readFileSync(join(sharedRoot, ".graphhopper", "decisions.jsonl"), "utf-8")
      .trim().split("\n").map((l) => JSON.parse(l));
  const okFetch = (noul: number) =>
    (async () => ({
      ok: true,
      json: async () => ({ answers: { keep_0: { noul } } }),
    })) as unknown as typeof fetch;

  test("dbPathなし/sessionIDなし→skip（pushなし・throwなし）", async () => {
    const pushed: string[] = [];
    const push = (t: string) => void pushed.push(t);
    expect(await gate({ dbPath: null, sessionID: "s", push })).toMatchObject({ kept: false });
    expect(await gate({ dbPath: "/x", sessionID: "", push })).toMatchObject({ kept: false });
    expect(pushed).toEqual([]);
    const kinds = logged().map((l: { kind: string }) => l.kind);
    expect(kinds.filter((k) => k === "compact-skip").length).toBeGreaterThanOrEqual(2);
  });

  test("DB不在→skip記録・key未設定→skip（fetchを呼ばない）", async () => {
    const pushed: string[] = [];
    const push = (t: string) => void pushed.push(t);
    let fetched = 0;
    const spy = (async () => {
      fetched++;
      return { ok: false, status: 500 };
    }) as unknown as typeof fetch;
    expect(
      await gate({ dbPath: "/nonexistent-dir/x.db", sessionID: "s", push, fetchFn: spy }),
    ).toMatchObject({ kept: false, reason: expect.stringContaining("DB") });
    expect(pushed).toEqual([]);
    expect(
      logged()
        .filter((l: { kind: string }) => l.kind === "compact-skip")
        .some((l: { reason: string }) => l.reason.includes("DB")),
    ).toBe(true);
    setKey(undefined);
    try {
      const db = await mkDb([
        { mid: "m1", tool: "read", output: "x", t: 1 },
        ...Array.from({ length: 11 }, (_, i) => ({ mid: `k${i}`, tool: "read", output: "f", t: 10 + i })),
      ]);
      const out = await gate({ dbPath: db, sessionID: "sess", push, fetchFn: spy });
      expect(out).toMatchObject({ kept: false });
      expect(String((out as { reason: string }).reason)).toContain("LIQUID");
      expect(fetched).toBe(0);
      expect(
        logged()
          .filter((l: { kind: string }) => l.kind === "compact-skip")
          .some((l: { reason: string }) => l.reason.includes("LIQUID")),
      ).toBe(true);
    } finally {
      restore();
    }
  });

  test("30件の大結果→push総量が上限内（ヘッダ込みtrim）", async () => {
    setKey("liquid_test");
    const pushed: string[] = [];
    const push = (t: string) => void pushed.push(t);
    try {
      // 1行530字×15行=7950：formatKeepListは通すが、ヘッダ53＋改行15で
      // 8018となりgate trimが1行落とす（発火の直接証明：header+14行=15行）。
      // tool名9字で行長を調整している（短いと発火域に届かない）
      const bigInput = { cmd: "x".repeat(300) };
      const parts = Array.from({ length: 30 }, (_, i) => ({
        mid: `g${i}`,
        tool: "readxxxxx",
        input: bigInput,
        output: "y".repeat(500),
        t: i + 1,
      }));
      const fillers = Array.from({ length: 11 }, (_, i) => ({
        mid: `h${i}`,
        tool: "read",
        output: "f",
        t: 100 + i,
      }));
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { Database } = await import("bun:sqlite");
      const dir = mkdtempSync(join(tmpdir(), "gh-compact-big-"));
      const path = join(dir, "t.db");
      const db = new Database(path);
      db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INT)");
      db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INT, data TEXT)");
      [...parts, ...fillers].forEach((p, i) => {
        db.exec("INSERT INTO message VALUES (?, 'sess', ?)", [p.mid, p.t]);
        db.exec("INSERT INTO part VALUES (?, ?, 'sess', ?, ?)", [
          `p${i}`,
          p.mid,
          p.t,
          JSON.stringify({ type: "tool", tool: p.tool, state: { status: "completed", input: (p as { input?: unknown }).input ?? {}, output: p.output } }),
        ]);
      });
      db.close();
      const answers: Record<string, { noul: number }> = {};
      parts.forEach((p, i) => {
        answers[`keep_${i}`] = { noul: 0.99 };
      });
      const fake = (async () => ({ ok: true, json: async () => ({ answers }) })) as unknown as typeof fetch;
      const out = await gate({ dbPath: path, sessionID: "sess", push, fetchFn: fake });
      expect(out).toMatchObject({ kept: true });
      // 1行530字×15行=7950：formatKeepListは通すがヘッダ53＋改行15で
      // 8018となりgate trimが1行落とす（発火の直接証明：header+14行=15行）
      expect(pushed.join("\n").length).toBeLessThanOrEqual(8000);
      expect(pushed[0].split("\n").length).toBe(15);
      const keptLogged = logged().filter((l: { kind: string }) => l.kind === "compact");
      expect(keptLogged.length).toBeGreaterThanOrEqual(1);
    } finally {
      restore();
    }
  });

  test("d1失敗→skip・成功→push（実DB経由）", async () => {
    setKey("liquid_test");
    const pushed: string[] = [];
    const push = (t: string) => void pushed.push(t);
    try {
      // 最新10件に埋もれないよう古い対象＋新しいフィラー11件
      const fillers = Array.from({ length: 11 }, (_, i) => ({
        mid: `f${i}`,
        tool: "read",
        output: "filler",
        t: 10 + i,
      }));
      const db = await mkDb([
        { mid: "m1", tool: "read", output: "important result", t: 1 },
        ...fillers,
      ]);
      const bad = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
      expect(await gate({ dbPath: db, sessionID: "sess", push, fetchFn: bad })).toMatchObject({
        kept: false,
      });
      expect(pushed).toEqual([]);
      const r = await gate({ dbPath: db, sessionID: "sess", push, fetchFn: okFetch(0.9) });
      expect(r).toMatchObject({ kept: true, pushed: 1 });
      expect(pushed[0]).toContain("keep-list");
      expect(pushed[0]).toContain("important result");
    } finally {
      restore();
    }
  });

  test("timeout超過もskip（throwなし）", async () => {
    setKey("liquid_test");
    const pushed: string[] = [];
    const push = (t: string) => void pushed.push(t);
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch;
    try {
      const db = await mkDb([
        { mid: "m1", tool: "read", output: "x", t: 1 },
        ...Array.from({ length: 11 }, (_, i) => ({ mid: `h${i}`, tool: "read", output: "f", t: 10 + i })),
      ]);
      const t = performance.now();
      const out = await gate({ dbPath: db, sessionID: "sess", push, fetchFn: hang });
      expect(out).toMatchObject({ kept: false });
      expect(performance.now() - t).toBeLessThan(3000);
      expect(pushed).toEqual([]);
    } finally {
      restore();
    }
  });

  test("秘匿3パターン×input/outputを除外", async () => {
    const rows = [
      row("read", "token sk-abcdefgh12345678 here"),
      row("bash", "ok", "completed", "m"),
      { ...row("read", "fine"), data: JSON.stringify({ type: "tool", tool: "read", state: { status: "completed", input: { h: "Bearer abc.def.ghi" }, output: "fine" } }) },
      row("read", "AKIAIOSFODNN7EXAMPLE data"),
    ];
    const cands = selectCandidates(rows, []);
    expect(cands.map((c) => c.outputText)).toEqual(["ok"]);
  });
});
