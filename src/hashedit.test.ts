/**
 * hashline編集堅牢化（T5）・allow-list順序不変条件の単体テスト。
 * bun test で実行する: `bun test src/hashedit.test.ts`
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRAPHHOPPER_AGENTS, SEARCH_ONLY_BASH, injectAgents } from "./agents";
import { applySingleEdit, decodeUtf8Strict, sha1Hex, verifyHash } from "./hashedit";
import {
  checkHashEditAccess,
  isGateTargetTool,
  readGraphhopperHash,
  runGraphhopperEdit,
} from "./gate";
import {
  isDesignDocLocked,
  isDesignGateBlocked,
  startGoal,
  unbindSession,
  type GraphhopperConfig,
} from "./state";

const CFG: GraphhopperConfig = {
  router_threshold_lines: 400,
  design_gate_allow: [".graphhopper/plans/"],
  agents: {},
  stuck_threshold: 3,
  loop_stop_threshold: 6,
  loop_stop_max: 3,
  loop_tool_window: 8,
  loop_tool_repeat_threshold: 4,
  max_eval_fails: 6,
  stuck_edit_repeat: 5,
  stuck_diff_stall: 4,
  lsp_servers: [],
};

describe("hashedit", () => {
  test("sha1既知ベクタ", () => {
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  test("一致適用", () => {
    expect(applySingleEdit("hello world", "world", "bun")).toBe("hello bun");
  });

  test("不一致拒否（throw）", () => {
    expect(() => applySingleEdit("hello", "xyz", "bun")).toThrow("not found");
  });

  test("複数一致拒否（throw）", () => {
    expect(() => applySingleEdit("aa aa", "aa", "b")).toThrow("multiple");
  });

  test("空oldString拒否", () => {
    expect(() => applySingleEdit("hello", "", "x")).toThrow();
  });

  test("verifyHash一致", () => {
    expect(verifyHash("abc", sha1Hex("abc"))).toBe(sha1Hex("abc"));
  });

  test("verifyHash不一致は期待/現hashを返す", () => {
    const good = sha1Hex("abc");
    try {
      verifyHash("abd", good);
      expect(true).toBe(false);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(good);
      expect(msg).toContain(sha1Hex("abd"));
    }
  });

  test("decodeUtf8Strict: 正常UTF-8はそのまま", () => {
    expect(decodeUtf8Strict(Buffer.from("日本語abc", "utf8"))).toBe("日本語abc");
  });

  test("decodeUtf8Strict: 不正UTF-8はthrow（lossy置換しない）", () => {
    expect(() => decodeUtf8Strict(Buffer.from([0xff, 0xfe, 0x00]))).toThrow(
      "not valid UTF-8",
    );
  });

  test("decodeUtf8Strict: BOMはU+FEFFとして保持される", () => {
    const withBom = Buffer.from([0xef, 0xbb, 0xbf, 0x61]);
    expect(decodeUtf8Strict(withBom)).toBe("\uFEFFa");
  });
});

describe("gate dispatch（before/after両hookの真実源）", () => {
  test("write/edit/graphhopper_editの3名が対象（case-insensitive）", () => {
    expect(isGateTargetTool("write")).toBe(true);
    expect(isGateTargetTool("edit")).toBe(true);
    expect(isGateTargetTool("graphhopper_edit")).toBe(true);
    expect(isGateTargetTool("GRAPHHOPPER_EDIT")).toBe(true);
    expect(isGateTargetTool("Graphhopper_Edit")).toBe(true);
  });

  test("対象外toolは計数・gateの網に入らない", () => {
    for (const t of ["read", "bash", "glob", undefined]) {
      expect(isGateTargetTool(t)).toBe(false);
    }
  });
});

describe("checkHashEditAccess（execute内拒否＋goal外）", () => {
  test("メイン一致でok", () => {
    expect(checkHashEditAccess("sess-main", "sess-main", true)).toBe("ok");
  });

  test("goal外はno-goal（イベント記録なし・早期return）", () => {
    expect(checkHashEditAccess("sess-main", "sess-main", false)).toBe("no-goal");
    expect(checkHashEditAccess("sess-main", null, false)).toBe("no-goal");
  });

  test("子セッションはsubagent（throw拒否）", () => {
    expect(checkHashEditAccess("sess-child", "sess-main", true)).toBe("subagent");
    expect(checkHashEditAccess(undefined, "sess-main", true)).toBe("subagent");
  });

  test("未バインド（mainSessionID null）はgoal外扱い", () => {
    expect(checkHashEditAccess("sess-main", null, true)).toBe("no-goal");
    expect(checkHashEditAccess(undefined, null, true)).toBe("no-goal");
  });
});

describe("design gate（hash_edit経路も同型）", () => {
  test("designing中はsrc拒否・plans許可", () => {
    expect(isDesignGateBlocked("/r", CFG, "designing", "src/a.ts")).toBe(true);
    expect(
      isDesignGateBlocked("/r", CFG, "designing", ".graphhopper/plans/g-x.md"),
    ).toBe(false);
  });

  test("designing終了後はdesign doc自体がlock（.log.mdは対象外）", () => {
    expect(isDesignDocLocked("/r", "implementing", "g-x", ".graphhopper/plans/g-x.md")).toBe(
      true,
    );
    expect(
      isDesignDocLocked("/r", "implementing", "g-x", ".graphhopper/plans/g-x.log.md"),
    ).toBe(false);
  });
});

describe("SEARCH_ONLY_BASH順序不変条件（findLast規律）", () => {
  const keys = Object.keys(SEARCH_ONLY_BASH);
  const idx = (k: string) => keys.indexOf(k);

  test("base deny以外の全denyが全allowより後方", () => {
    const allowIdx = keys
      .filter((k) => SEARCH_ONLY_BASH[k] === "allow")
      .map((k) => idx(k));
    const lastAllow = Math.max(...allowIdx);
    expect(allowIdx.length).toBeGreaterThan(0);
    for (const k of keys) {
      if (k === "*") continue; // 先頭base denyは意図的
      if (SEARCH_ONLY_BASH[k] === "deny") {
        expect(idx(k)).toBeGreaterThan(lastAllow);
      }
    }
  });

  test("書き換え系deny対が存在", () => {
    for (const d of [
      "ruff check* --fix*",
      "ruff format*",
      "npx ruff check* --fix*",
      "npx ruff format*",
      "pyright *--createstub*",
      "npx pyright *--createstub*",
      "ast-grep *--update-all*",
      "ast-grep *-U*",
    ]) {
      expect(SEARCH_ONLY_BASH[d]).toBe("deny");
    }
  });

  test("sg は deny（Linuxでは newgrp のため機械依存の穴を作らない）", () => {
    expect(SEARCH_ONLY_BASH["sg"]).toBe("deny");
    expect(SEARCH_ONLY_BASH["sg *"]).toBe("deny");
  });

  test("診断allow群が存在", () => {
    for (const a of [
      "pyright *",
      "ruff check *",
      "tsc --noEmit *",
      "ast-grep *",
      "npx tsc --noEmit *",
      "npx pyright *",
      "npx ruff check *",
    ]) {
      expect(SEARCH_ONLY_BASH[a]).toBe("allow");
    }
  });
});

describe("subagent read-only guard", () => {
  test("全subagentにtools:{graphhopper_edit:false}注入", () => {
    const input: { agent?: Record<string, { tools?: Record<string, boolean> }> } = {};
    injectAgents(input as never, "/tmp/gh-nope");
    for (const name of Object.keys(GRAPHHOPPER_AGENTS)) {
      const injected = input.agent?.[name];
      expect(injected?.tools?.["graphhopper_edit"]).toBe(false);
    }
  });

  test("ユーザー事前定義があってもguardは残る", () => {
    const input: { agent?: Record<string, Record<string, unknown>> } = {
      agent: {
        "graphhopper-researcher": { description: "user custom", tools: { read: true } },
      },
    };
    injectAgents(input as never, "/tmp/gh-nope");
    const kept = input.agent?.["graphhopper-researcher"];
    expect(kept?.["description"]).toBe("user custom");
    expect((kept?.["tools"] as Record<string, boolean>)["graphhopper_edit"]).toBe(false);
    expect((kept?.["tools"] as Record<string, boolean>)["read"]).toBe(true);
  });

  test("librarianが存在しresearcherが純化文言", () => {
    expect(GRAPHHOPPER_AGENTS["graphhopper-librarian"]).toBeDefined();
    expect(GRAPHHOPPER_AGENTS["graphhopper-researcher"]?.description).toContain(
      "graphhopper-librarian",
    );
  });
});

describe("runGraphhopperEdit統合経路（分岐→アクション対応）", () => {
  function setup(): { root: string; session: string } {
    const root = mkdtempSync(join(tmpdir(), "gh-hashedit-test-"));
    const session = "sess-main";
    startGoal(root, "test goal", session);
    return { root, session };
  }

  function history(root: string): string {
    return readFileSync(join(root, ".graphhopper", "history.jsonl"), "utf8");
  }

  test("hash→edit往復で適用＋applied記録", () => {
    const { root, session } = setup();
    writeFileSync(join(root, "a.txt"), "hello world", "utf8");
    const { sha1 } = JSON.parse(readGraphhopperHash(root, "a.txt"));
    const out = JSON.parse(
      runGraphhopperEdit(root, session, {
        filePath: "a.txt",
        expectedHash: sha1,
        oldString: "world",
        newString: "bun",
      }),
    );
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello bun");
    expect(out.sha1).toBe(sha1Hex("hello bun"));
    expect(history(root)).toContain("hash_edit_applied");
  });

  test("hash不一致はthrow＋refused記録", () => {
    const { root, session } = setup();
    writeFileSync(join(root, "a.txt"), "hello", "utf8");
    expect(() =>
      runGraphhopperEdit(root, session, {
        filePath: "a.txt",
        expectedHash: "deadbeef",
        oldString: "hello",
        newString: "x",
      }),
    ).toThrow("hash mismatch");
    expect(history(root)).toContain("hash_edit_refused");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello");
  });

  test("複数一致はthrow（throwとreturnの取り違え防止）", () => {
    const { root, session } = setup();
    writeFileSync(join(root, "a.txt"), "aa aa", "utf8");
    const { sha1 } = JSON.parse(readGraphhopperHash(root, "a.txt"));
    expect(() =>
      runGraphhopperEdit(root, session, {
        filePath: "a.txt",
        expectedHash: sha1,
        oldString: "aa",
        newString: "b",
      }),
    ).toThrow("multiple");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("aa aa");
  });

  test("子セッションはthrow（returnとの取り違え防止）", () => {
    const { root, session } = setup();
    writeFileSync(join(root, "a.txt"), "hello", "utf8");
    const { sha1 } = JSON.parse(readGraphhopperHash(root, "a.txt"));
    expect(() =>
      runGraphhopperEdit(root, "sess-child", {
        filePath: "a.txt",
        expectedHash: sha1,
        oldString: "hello",
        newString: "x",
      }),
    ).toThrow("subagent");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello");
  });

  test("goal外は軟質return・イベント記録なし", () => {
    const root = mkdtempSync(join(tmpdir(), "gh-hashedit-test-"));
    const out = runGraphhopperEdit(root, "sess-main", {
      filePath: "a.txt",
      expectedHash: "x",
      oldString: "a",
      newString: "b",
    });
    expect(out.startsWith("error:")).toBe(true);
    expect(existsSync(join(root, ".graphhopper", "history.jsonl"))).toBe(false);
  });

  test("未バインド（session_id null）はgoal外return", () => {
    const { root, session } = setup();
    writeFileSync(join(root, "a.txt"), "hello", "utf8");
    unbindSession(root, session);
    const out = runGraphhopperEdit(root, session, {
      filePath: "a.txt",
      expectedHash: "x",
      oldString: "hello",
      newString: "x",
    });
    expect(out.startsWith("error:")).toBe(true);
    expect(history(root)).not.toContain("hash_edit_refused");
  });

  test("読めないファイルはthrow＋refused記録", () => {
    const { root, session } = setup();
    expect(() =>
      runGraphhopperEdit(root, session, {
        filePath: "no-such-file.txt",
        expectedHash: "x",
        oldString: "a",
        newString: "b",
      }),
    ).toThrow("cannot read");
    expect(history(root)).toContain("hash_edit_refused");
    expect(existsSync(join(root, "no-such-file.txt"))).toBe(false);
  });

  test("非UTF-8ファイルは拒否（refused記録・書き戻しなし）", () => {
    const { root, session } = setup();
    const bin = join(root, "sjis.txt");
    writeFileSync(bin, Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0xff]));
    const before = readFileSync(bin);
    expect(() => readGraphhopperHash(root, "sjis.txt")).toThrow(
      "not valid UTF-8",
    );
    expect(() =>
      runGraphhopperEdit(root, session, {
        filePath: "sjis.txt",
        expectedHash: "x",
        oldString: "a",
        newString: "b",
      }),
    ).toThrow("not valid UTF-8");
    expect(history(root)).toContain("hash_edit_refused");
    expect(readFileSync(bin)).toEqual(before);
  });
});
