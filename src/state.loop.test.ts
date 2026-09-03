/**
 * ループ検知（echo + 同一tool call反復）・累積loop停止カウンタの単体テスト。
 * bun test で実行する: `bun test src/state.loop.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GraphhopperConfig,
  type SessionMessageLike,
  CONTINUATION_MARKER,
  canonicalJSON,
  continuationFingerprint,
  detectLoopKind,
  isEchoMessage,
  isHumanTextPart,
  isResumeBlocked,
  isToolRepeatLoop,
  fnv1a,
  noteContinuation,
  noteEvalFingerprint,
  pauseGoal,
  readState,
  resetLoopForClear,
  resumeGoal,
  startGoal,
  stopLoopByPause,
  toolCallHash,
} from "./state";

const CFG: GraphhopperConfig = {
  router_threshold_lines: 400,
  design_gate_allow: [".graphhopper/plans/"],
  agents: {},
  handoff_nudge_chars: 500_000,
  stuck_threshold: 3,
  loop_stop_threshold: 6,
  loop_stop_max: 3,
  loop_tool_window: 8,
  loop_tool_repeat_threshold: 4,
};

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "gh-loop-test-"));
}

function msg(
  role: "user" | "assistant",
  text: string,
  synthetic = false,
): SessionMessageLike {
  return {
    info: { id: `${role}-${Math.random().toString(36).slice(2)}`, role },
    parts: [{ type: "text", text, synthetic }],
  };
}

function toolMsg(role: "user" | "assistant", call: Partial<SessionMessageLike["parts"][number]>): SessionMessageLike {
  return {
    info: { id: `${role}-${Math.random().toString(36).slice(2)}`, role },
    parts: [call as SessionMessageLike["parts"][number]],
  };
}

const completedTool = (callID: string, tool: string, input: unknown) => ({
  type: "tool",
  callID,
  tool,
  state: { status: "completed", input },
});

describe("isEchoMessage", () => {
  test("パターン1: 末尾=user・直前=assistant のミラー echo", () => {
    expect(
      isEchoMessage([
        msg("user", "実装を始めよう"),
        msg("assistant", "実装完了、検証済み、再起動で有効です。"),
        msg("user", "実装完了、検証済み、再起動で有効です。"),
      ]),
    ).toBe(true);
  });

  test("パターン2: 自動継続ループ（末尾=assistant、echo user が[-3]と一致）", () => {
    expect(
      isEchoMessage([
        msg("user", "実装を始めよう"),
        msg("assistant", "已实施完毕。等待新的实际作业指示。以上。"),
        msg("user", "已实施完毕。等待新的实际作业指示。以上。"),
        msg("assistant", "已实施完毕。等待新的实际作业指示。以上。"),
      ]),
    ).toBe(true);
  });

  test("パターン3: 連続assistant同一文（echoユーザーが挟まる構造）", () => {
    expect(
      isEchoMessage([
        msg("user", "実装を始めよう"),
        msg("assistant", "已实施完毕。等待新的实际作业指示。以上。"),
        msg("user", "已实施完毕。等待新的实际作业指示。以上。"),
        msg("assistant", "已实施完毕。等待新的实际作业指示。以上。"),
      ]),
    ).toBe(true);
  });

  test("通常会話は false", () => {
    expect(
      isEchoMessage([
        msg("user", "実装を始めよう"),
        msg("assistant", "design を書きます。"),
        msg("user", "OK、進めて"),
        msg("assistant", "implementing に遷移しました。"),
      ]),
    ).toBe(false);
  });

  test("短い挨拶は false", () => {
    expect(isEchoMessage([msg("assistant", "👋"), msg("user", "👋")])).toBe(false);
  });
});

describe("isToolRepeatLoop / toolCallHash", () => {
  const mkBash = (i: number) =>
    toolMsg("assistant", completedTool(`c${i}`, "bash", { command: "npm test" }));

  test("同一 tool+input の反復（4回）で検知", () => {
    const msgs = [
      msg("user", "実装して"),
      mkBash(1),
      mkBash(2),
      mkBash(3),
      mkBash(4),
    ];
    expect(isToolRepeatLoop(msgs, CFG)).toBe(true);
  });

  test("callID 重複は dedupe して数える（同一callIDの多重状態が誤計上されない）", () => {
    // c1 は同一callIDで複数状態（completed/running）が現れる → 1件に数える。
    // 別入力の c2 も入れる。distinct は2件 < threshold4 → 検知しない
    const msgs = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("c1", "bash", { command: "npm test" })),
      toolMsg("assistant", { type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: { command: "npm test" } } }),
      toolMsg("assistant", completedTool("c1", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("c2", "bash", { command: "npm run build" })),
    ];
    expect(isToolRepeatLoop(msgs, CFG)).toBe(false);

    // c1 を3回重複状態で出しても 1件（+c2）→ 検知しない（二重計上されないことの確認）
    const dupMany = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("c1", "bash", { command: "npm test" })),
      toolMsg("assistant", { type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: { command: "npm test" } } }),
      toolMsg("assistant", completedTool("c1", "bash", { command: "npm test" })),
      toolMsg("assistant", { type: "tool", callID: "c1", tool: "bash", state: { status: "running", input: { command: "npm test" } } }),
      toolMsg("assistant", completedTool("c1", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("c2", "bash", { command: "npm run build" })),
    ];
    expect(isToolRepeatLoop(dupMany, CFG)).toBe(false);
  });

  test("pending/running は数えない", () => {
    const msgs = [
      msg("user", "実装して"),
      toolMsg("assistant", { type: "tool", callID: "p1", tool: "bash", state: { status: "pending", input: { command: "npm test" } } }),
      toolMsg("assistant", { type: "tool", callID: "p2", tool: "bash", state: { status: "running", input: { command: "npm test" } } }),
      toolMsg("assistant", { type: "tool", callID: "p3", tool: "bash", state: { status: "running", input: { command: "npm test" } } }),
      toolMsg("assistant", { type: "tool", callID: "p4", tool: "bash", state: { status: "running", input: { command: "npm test" } } }),
    ];
    expect(isToolRepeatLoop(msgs, CFG)).toBe(false);
  });

  test("input 欠損の tool 部品はスキップ", () => {
    const msgs = [
      msg("user", "実装して"),
      toolMsg("assistant", { type: "tool", callID: "x1", tool: "bash", state: { status: "completed" } }),
      toolMsg("assistant", { type: "tool", callID: "x2", tool: "bash", state: { status: "completed" } }),
      toolMsg("assistant", { type: "tool", callID: "x3", tool: "bash", state: { status: "completed" } }),
      toolMsg("assistant", { type: "tool", callID: "x4", tool: "bash", state: { status: "completed" } }),
    ];
    expect(isToolRepeatLoop(msgs, CFG)).toBe(false);
  });

  test("異なる入力の tool call は検知しない", () => {
    const msgs = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("d1", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("d2", "bash", { command: "npm run build" })),
      toolMsg("assistant", completedTool("d3", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("d4", "bash", { command: "npm run build" })),
    ];
    expect(isToolRepeatLoop(msgs, CFG)).toBe(false);
  });

  test("人間の新規入力でバーストが切れる（正常な再利用は非検知）", () => {
    // 前ターンの同一 tool call は、人間入力が挟まるため判定に残らない
    const before = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("a1", "read", { path: "src/x.ts" })),
      toolMsg("assistant", completedTool("a2", "read", { path: "src/x.ts" })),
      toolMsg("assistant", completedTool("a3", "read", { path: "src/x.ts" })),
      toolMsg("assistant", completedTool("a4", "read", { path: "src/x.ts" })),
    ];
    const after = [
      msg("user", "方針変更: 別の場所を確認して"),
      toolMsg("assistant", completedTool("b1", "read", { path: "src/y.ts" })),
    ];
    expect(isToolRepeatLoop([...before, ...after], CFG)).toBe(false);
  });

  test("canonicalJSON はキー順に依存しない・fnv1a は同値で一致", () => {
    expect(canonicalJSON({ a: 1, b: 2 })).toBe(canonicalJSON({ b: 2, a: 1 }));
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
    expect(fnv1a("hello")).not.toBe(fnv1a("world"));
  });
});

describe("detectLoopKind", () => {
  test("echo のみで kind=echo", () => {
    const msgs = [
      msg("user", "実装を始めよう"),
      msg("assistant", "完了です。"),
      msg("user", "完了です。"),
    ];
    const r = detectLoopKind(msgs, CFG);
    expect(r.detected).toBe(true);
    expect(r.kind).toBe("echo");
  });

  test("tool のみで kind=tool", () => {
    const msgs = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("t1", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t2", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t3", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t4", "bash", { command: "npm test" })),
    ];
    const r = detectLoopKind(msgs, CFG);
    expect(r.detected).toBe(true);
    expect(r.kind).toBe("tool");
  });

  test("echo と tool 両方で kind=echo+tool", () => {
    // 人間入力を挟まず、assistant が同一文 + 同一 tool call を4連続（退化ループの実構造）。
    // echo パターン3（[-3]/[-1] assistant 同一文）+ tool 反復（4件同一）を両方満たす
    const asstWithTool = (text: string, callID: string) => ({
      info: {
        id: `asst-${Math.random().toString(36).slice(2)}`,
        role: "assistant",
      } as const,
      parts: [
        { type: "text", text },
        completedTool(callID, "bash", { command: "npm test" }),
      ],
    });
    const msgs = [
      msg("user", "実装して"),
      asstWithTool("已实施完毕。等待新的实际作业指示。以上。", "e1"),
      asstWithTool("已实施完毕。等待新的实际作业指示。以上。", "e2"),
      asstWithTool("已实施完毕。等待新的实际作业指示。以上。", "e3"),
      asstWithTool("已实施完毕。等待新的实际作业指示。以上。", "e4"),
    ] as SessionMessageLike[];
    const r = detectLoopKind(msgs, CFG);
    expect(r.detected).toBe(true);
    expect(r.kind).toBe("echo+tool");
  });

  test("echo 無効（loop_stop_threshold=0）でも tool 検知は生きる", () => {
    const cfg = { ...CFG, loop_stop_threshold: 0 };
    const echoMsgs = [
      msg("user", "実装を始めよう"),
      msg("assistant", "完了です。"),
      msg("user", "完了です。"),
    ];
    expect(detectLoopKind(echoMsgs, cfg).detected).toBe(false);

    const toolMsgs = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("t1", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t2", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t3", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t4", "bash", { command: "npm test" })),
    ];
    expect(detectLoopKind(toolMsgs, cfg).detected).toBe(true);
  });

  test("tool 無効（repeat_threshold<=1）なら tool 検知しない", () => {
    const cfg = { ...CFG, loop_tool_repeat_threshold: 1 };
    const toolMsgs = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("t1", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t2", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t3", "bash", { command: "npm test" })),
      toolMsg("assistant", completedTool("t4", "bash", { command: "npm test" })),
    ];
    expect(detectLoopKind(toolMsgs, cfg).detected).toBe(false);
  });
});

describe("累積loop停止カウンタ", () => {
  test("自動stopで+1、明示pauseでは増えない、clearで0", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");

    stopLoopByPause(root);
    expect(isResumeBlocked(root)).toBe(false); // 1/3

    stopLoopByPause(root);
    stopLoopByPause(root);
    expect(isResumeBlocked(root)).toBe(true); // 3/3

    // force resume でもカウンタは保持
    const r = resumeGoal(root, "sess1", true);
    expect(r).not.toBeNull();
    expect(isResumeBlocked(root)).toBe(true);

    // 明示 pause では増えない
    pauseGoal(root);
    expect(isResumeBlocked(root)).toBe(true);

    // clear でリセット
    resetLoopForClear(root);
    expect(isResumeBlocked(root)).toBe(false);
  });

  test("通常resumeはブロック時に拒否、forceで復帰", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    stopLoopByPause(root);
    stopLoopByPause(root);
    stopLoopByPause(root); // 3/3 → blocked

    expect(resumeGoal(root, "sess1")).toBeNull(); // blocked
    expect(resumeGoal(root, "sess1", true)).not.toBeNull(); // force
  });

  test("blocked前は通常resumeが通る", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    stopLoopByPause(root); // 1/3
    expect(resumeGoal(root, "sess1")).not.toBeNull();
  });
});

describe("継続注入dedupe", () => {
  const contMsg = (id: string): SessionMessageLike => ({
    info: { id, role: "user" },
    parts: [{ type: "text", text: `${CONTINUATION_MARKER}\n[graphhopper] Goal: x` }],
  });

  test("自前の継続注入は人間入力扱いしない", () => {
    expect(isHumanTextPart({ type: "text", text: `${CONTINUATION_MARKER} foo` })).toBe(false);
    expect(isHumanTextPart({ type: "text", text: "実装して" })).toBe(true);
    expect(isHumanTextPart({ type: "text", text: "実装して", synthetic: true })).toBe(false);
  });

  test("待機ackの言い換えだけではフィンガープリントが変わらない", () => {
    const base = [msg("user", "実装して"), msg("assistant", "了解、進めます")];
    const m1 = continuationFingerprint(base, "implementing", null, null);
    // 注入 → 言い換え待機ack → idle: ack文面が変わっても進展なし
    const after = [...base, contMsg("c1"), msg("assistant", "明示の合図があるまで待機します")];
    const m2 = continuationFingerprint(after, "implementing", null, null);
    expect(m2).toBe(m1);
  });

  test("tool実行・人間入力・phase変化ではフィンガープリントが変わる", () => {
    const base = [msg("user", "実装して"), msg("assistant", "了解")];
    const m1 = continuationFingerprint(base, "implementing", null, null);
    // tool 実行あり
    const withTool = [...base, toolMsg("assistant", completedTool("t1", "read", { path: "a.ts" }))];
    expect(continuationFingerprint(withTool, "implementing", null, null)).not.toBe(m1);
    // 人間入力あり
    const withHuman = [...base, msg("user", "続けて")];
    expect(continuationFingerprint(withHuman, "implementing", null, null)).not.toBe(m1);
    // phase 変化
    expect(continuationFingerprint(base, "polish", null, null)).not.toBe(m1);
    // eval 結果変化
    expect(continuationFingerprint(base, "implementing", "npm test", "false:abc")).not.toBe(
      continuationFingerprint(base, "implementing", "npm test", "true:def"),
    );
  });

  test("自前注入をまたいでもtool反復検知のウィンドウが切れない", () => {
    const msgs = [
      msg("user", "実装して"),
      toolMsg("assistant", completedTool("t1", "bash", { command: "npm test" })),
      contMsg("c1"),
      toolMsg("assistant", completedTool("t2", "bash", { command: "npm test" })),
      contMsg("c2"),
      toolMsg("assistant", completedTool("t3", "bash", { command: "npm test" })),
      contMsg("c3"),
      toolMsg("assistant", completedTool("t4", "bash", { command: "npm test" })),
    ];
    expect(detectLoopKind(msgs, CFG).detected).toBe(true);
  });

  test("noteContinuation/noteEvalFingerprintの往復", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    expect(readState(root).last_continuation_marker).toBeNull();
    noteContinuation(root, "marker1");
    expect(readState(root).last_continuation_marker).toBe("marker1");
    noteEvalFingerprint(root, "false:abc");
    expect(readState(root).last_eval_fingerprint).toBe("false:abc");
  });
});
