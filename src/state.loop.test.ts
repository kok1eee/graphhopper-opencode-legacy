/**
 * ループ検知（echo + 同一tool call反復）・累積loop停止カウンタの単体テスト。
 * bun test で実行する: `bun test src/state.loop.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GraphhopperConfig,
  type SessionMessageLike,
  CONTINUATION_MARKER,
  aggregateVerdicts,
  canonicalJSON,
  checkStuck,
  checkVerifierResults,
  clearActiveGoal,
  continuationFingerprint,
  detectLoopKind,
  isDesignDocLocked,
  isDesignGateBlocked,
  isEchoMessage,
  isHumanTextPart,
  isLegalPhaseTransition,
  isResumeBlocked,
  isToolRepeatLoop,
  isValidBaselineRev,
  fnv1a,
  lastHumanId,
  nextDiffStall,
  nextEditStreak,
  noteDiffLines,
  noteEdit,
  noteStuckNotified,
  measureDiffLines,
  noteContinuation,
  noteEvalFingerprint,
  parseDiffShortstat,
  pauseGoal,
  readConfig,
  readDiscover,
  readGoals,
  readHistory,
  readState,
  recordAttempt,
  recordEvent,
  resetLoopForClear,
  resumeGoal,
  setCriticVerdict,
  setPhase,
  startDiscover,
  startGoal,
  stopLoopByPause,
  buildGoalSummary,
  buildTelemetry,
  recordEventBatch,
  toolCallHash,
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
  require_critic: false,
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

  test("パターン3: 連続assistant同一文（新規user入力後の繰り返し）", () => {
    // [-3]と[-1]が共にassistantで同一文。間のuserは新規入力（echoでない）。
    // パターン2（userがecho）とは別分岐のテスト
    expect(
      isEchoMessage([
        msg("user", "実装を始めよう"),
        msg("assistant", "已实施完毕。等待新的实际作业指示。以上。"),
        msg("user", "別の作業をして"),
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

  test("lastHumanId: 自前注入を飛ばして人間のidを返す・無ければnull", () => {
    const human = msg("user", "実装して");
    const humanId = human.info.id;
    const msgs = [
      human,
      msg("assistant", "了解"),
      {
        info: { id: "c1", role: "user" },
        parts: [{ type: "text", text: `${CONTINUATION_MARKER}\nfoo` }],
      } as SessionMessageLike,
    ];
    expect(lastHumanId(msgs)).toBe(humanId);
    expect(
      lastHumanId([
        msg("assistant", "待機します"),
        msg("assistant", "待機しています"),
      ]),
    ).toBeNull();
  });

  test("スライドウィンドウ下でも注入1往復でfingerprint不変（ID化の回帰）", () => {
    // deny/ack 空転: 人間アンカーが窓内にいる間は、注入前後で人間id・
    // tool件数ともに不変のはず。旧実装（配列インデックス）ではウィンドウが
    // 2件スライドして不一致になり毎 idle 再注入した
    const base = [msg("user", "実装して"), msg("assistant", "了解、進めます")];
    const m1 = continuationFingerprint(base, "implementing", null, null);
    const after = [...base, contMsg("c1"), msg("assistant", "待機します")];
    expect(continuationFingerprint(after, "implementing", null, null)).toBe(
      m1,
    );
  });

  test("人間が窓外に出ると一度だけ変化し以後安定する", () => {
    // 実運用のスライド（先頭脱落）を再現: アンカー喪失の遷移は1回、
    // その後のack追加では不変でなければならない
    const full = [
      msg("user", "実装して"),
      msg("assistant", "了解"),
      contMsg("c1"),
      msg("assistant", "待機します"),
    ];
    const mFull = continuationFingerprint(full, "implementing", null, null);
    const slid = full.slice(2);
    const mSlid = continuationFingerprint(slid, "implementing", null, null);
    expect(mSlid).not.toBe(mFull);
    const more = [
      ...slid,
      contMsg("c2"),
      msg("assistant", "待機しています"),
    ];
    expect(continuationFingerprint(more, "implementing", null, null)).toBe(
      mSlid,
    );
  });

  test("tool件数は窓内アンカー以降のみ数えスライド後は安定する", () => {
    const t1 = toolMsg(
      "assistant",
      completedTool("k1", "bash", { command: "a" }),
    );
    const t2 = toolMsg(
      "assistant",
      completedTool("k2", "bash", { command: "a" }),
    );
    const full = [msg("user", "せよ"), t1, msg("assistant", "中間"), t2];
    // full: h=U.id, t=2
    const mFull = continuationFingerprint(full, "implementing", null, null);
    // Uとt1が脱落 → h=null、窓内toolはt2のみ → 変化は一度だけ
    const slid = full.slice(2);
    const mSlid = continuationFingerprint(slid, "implementing", null, null);
    expect(mSlid).not.toBe(mFull);
    // 非tool ack追加では安定
    const more = [...slid, msg("assistant", "待機")];
    expect(continuationFingerprint(more, "implementing", null, null)).toBe(
      mSlid,
    );
    // 新規toolは進展として検知（変化する）
    const moreTool = [
      ...slid,
      toolMsg("assistant", completedTool("k3", "bash", { command: "b" })),
    ];
    expect(
      continuationFingerprint(moreTool, "implementing", null, null),
    ).not.toBe(mSlid);
  });
});

describe("回帰: diff統計パース (insert-only/delete-only)", () => {
  test("insert-only でも件数を返す（旧regexは両方必須で0に誤判定）", () => {
    expect(parseDiffShortstat(" 1 file changed, 3 insertions(+)")).toBe(3);
  });

  test("delete-only でも件数を返す", () => {
    expect(parseDiffShortstat(" 1 file changed, 2 deletions(-)")).toBe(2);
  });

  test("両方あれば合算", () => {
    expect(
      parseDiffShortstat(" 2 files changed, 10 insertions(+), 5 deletions(-)"),
    ).toBe(15);
  });

  test("件数なしは null（呼び出し側で0扱い・fallback）", () => {
    expect(parseDiffShortstat("")).toBeNull();
    expect(parseDiffShortstat(" 1 file changed")).toBeNull();
  });
});

describe("回帰: baseline検証", () => {
  test("hex は許可", () => {
    expect(isValidBaselineRev("73222ed4")).toBe(true);
    expect(
      isValidBaselineRev(
        "0123456789abcdef0123456789abcdef01234567",
      ),
    ).toBe(true);
  });

  test("注入文字列・空白・空は拒否", () => {
    expect(isValidBaselineRev("x; rm -rf /")).toBe(false);
    expect(isValidBaselineRev("abc def")).toBe(false);
    expect(isValidBaselineRev("")).toBe(false);
    expect(isValidBaselineRev("HEAD~1")).toBe(false);
  });

  test("不正 baseline の measureDiffLines は shell を呼ばず 0", async () => {
    const noShell = undefined as unknown as Parameters<
      typeof measureDiffLines
    >[0];
    await expect(
      measureDiffLines(noShell, tmpRoot(), "x; rm -rf /"),
    ).resolves.toBe(0);
    await expect(measureDiffLines(noShell, tmpRoot(), null)).resolves.toBe(
      0,
    );
  });
});

describe("回帰: design gate の path 判定", () => {
  const root = "/repo";

  test("plans 配下の相対・絶対パスは許可", () => {
    expect(
      isDesignGateBlocked(root, CFG, "designing", ".graphhopper/plans/g-x.md"),
    ).toBe(false);
    expect(
      isDesignGateBlocked(
        root,
        CFG,
        "designing",
        "/repo/.graphhopper/plans/g-x.md",
      ),
    ).toBe(false);
  });

  test("source は拒否・designing以外は素通り", () => {
    expect(
      isDesignGateBlocked(root, CFG, "designing", "src/index.ts"),
    ).toBe(true);
    expect(
      isDesignGateBlocked(root, CFG, "implementing", "src/index.ts"),
    ).toBe(false);
  });

  test("部分文字列の偽装は拒否（旧includesは許可していた）", () => {
    // 別ディレクトリ配下の同名パス
    expect(
      isDesignGateBlocked(
        root,
        CFG,
        "designing",
        "/tmp/.graphhopper/plans/evil.md",
      ),
    ).toBe(true);
    // 類似prefix
    expect(
      isDesignGateBlocked(
        root,
        CFG,
        "designing",
        "my.graphhopper/plans/x.md",
      ),
    ).toBe(true);
    // traversal で plans 外へ脱出
    expect(
      isDesignGateBlocked(
        root,
        CFG,
        "designing",
        ".graphhopper/plans/../../src/x.ts",
      ),
    ).toBe(true);
  });

  test("design doc ロックは正規化後の完全一致・log は対象外", () => {
    const id = "g-abc123";
    expect(
      isDesignDocLocked(root, "polish", id, `.graphhopper/plans/${id}.md`),
    ).toBe(true);
    expect(
      isDesignDocLocked(
        root,
        "polish",
        id,
        `/repo/.graphhopper/plans/${id}.md`,
      ),
    ).toBe(true);
    expect(
      isDesignDocLocked(root, "polish", id, `.graphhopper/plans/${id}.log.md`),
    ).toBe(false);
    expect(
      isDesignDocLocked(
        root,
        "designing",
        id,
        `.graphhopper/plans/${id}.md`,
      ),
    ).toBe(false);
  });
});

describe("回帰: state 読み書きの堅牢化", () => {
  test("破損 phase は designing にフォールバック", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    const path = join(root, ".graphhopper", "state.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.phase = "bogus-phase";
    writeFileSync(path, JSON.stringify(raw), "utf8");
    expect(readState(root).phase).toBe("designing");
  });

  test("canonicalJSON は stringify不能入力で 'undefined' を返す", () => {
    expect(canonicalJSON(undefined)).toBe("undefined");
    expect(canonicalJSON(() => {})).toBe("undefined");
    expect(canonicalJSON({ b: 2, a: 1 })).toBe(canonicalJSON({ a: 1, b: 2 }));
  });
});

describe("config 2層解決（グローバル既定 → プロジェクト上書き）", () => {
  /** GRAPHHOPPER_CONFIG を差分ファイルに向けて readConfig を実行する（実ユーザー設定を読まない） */
  function withGlobal(json: object | null, fn: () => void): void {
    const prev = process.env.GRAPHHOPPER_CONFIG;
    const path = join(tmpRoot(), "global.json");
    if (json !== null) writeFileSync(path, JSON.stringify(json), "utf8");
    process.env.GRAPHHOPPER_CONFIG = path; // 未作成なら readJson が {} を返す
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.GRAPHHOPPER_CONFIG;
      else process.env.GRAPHHOPPER_CONFIG = prev;
    }
  }

  function withProject(root: string, cfg: object): void {
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      join(root, ".graphhopper", "config.json"),
      JSON.stringify(cfg),
      "utf8",
    );
  }

  test("プロジェクト設定が無ければグローバル既定が効く", () => {
    withGlobal({ agents: { "graphhopper-verifier": "zai/glm" }, stuck_threshold: 9 }, () => {
      const cfg = readConfig(tmpRoot());
      expect(cfg.agents["graphhopper-verifier"]).toBe("zai/glm");
      expect(cfg.stuck_threshold).toBe(9);
    });
  });

  test("プロジェクトは同名だけ上書きし、他はグローバルを継承する", () => {
    withGlobal(
      {
        agents: { "graphhopper-verifier": "global-v", "graphhopper-critic": "global-c" },
        stuck_threshold: 9,
      },
      () => {
        const root = tmpRoot();
        withProject(root, { agents: { "graphhopper-verifier": "project-v" } });
        const cfg = readConfig(root);
        expect(cfg.agents["graphhopper-verifier"]).toBe("project-v");
        expect(cfg.agents["graphhopper-critic"]).toBe("global-c");
        expect(cfg.stuck_threshold).toBe(9);
      },
    );
  });

  test("グローバル・プロジェクトとも無ければ DEFAULT にフォールバック", () => {
    withGlobal(null, () => {
      const cfg = readConfig(tmpRoot());
      expect(cfg.agents).toEqual({});
      expect(cfg.stuck_threshold).toBe(CFG.stuck_threshold);
    });
  });

  test("グローバル設定が壊れていても既定で動く（例外を投げない）", () => {
    const prev = process.env.GRAPHHOPPER_CONFIG;
    const path = join(tmpRoot(), "broken.json");
    writeFileSync(path, "{ not json", "utf8");
    process.env.GRAPHHOPPER_CONFIG = path;
    try {
      const cfg = readConfig(tmpRoot());
      expect(cfg.agents).toEqual({});
      expect(cfg.stuck_threshold).toBe(CFG.stuck_threshold);
    } finally {
      if (prev === undefined) delete process.env.GRAPHHOPPER_CONFIG;
      else process.env.GRAPHHOPPER_CONFIG = prev;
    }
  });
});

describe("回帰: clear は goal_complete を記録しない", () => {
  test("履歴汚染なし・goal は done・active は null", () => {
    const root = tmpRoot();
    const { goal } = startGoal(root, "test goal", "sess1");
    const cleared = clearActiveGoal(root);
    expect(cleared?.id).toBe(goal.id);

    const goals = readGoals(root);
    expect(goals.active).toBeNull();
    expect(goals.goals.find((g) => g.id === goal.id)?.status).toBe("done");

    const historyPath = join(root, ".graphhopper", "history.jsonl");
    const history = existsSync(historyPath)
      ? readFileSync(historyPath, "utf8")
      : "";
    expect(history).not.toContain("goal_complete");
    expect(readState(root).phase).toBe("designing");
  });
});

describe("evalリトライ上限 giveUp", () => {
  test("上限到達でgiveUp（escalateは先に発火）", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    let r = recordAttempt(root, false, "");
    expect(r.escalate).toBe(false);
    expect(r.giveUp).toBe(false);
    r = recordAttempt(root, false, "");
    expect(r.escalate).toBe(false);
    r = recordAttempt(root, false, "");
    expect(r.fail_streak).toBe(3);
    expect(r.escalate).toBe(true); // stuck_threshold=3
    expect(r.giveUp).toBe(false);
    r = recordAttempt(root, false, "");
    r = recordAttempt(root, false, "");
    expect(r.fail_streak).toBe(5);
    expect(r.giveUp).toBe(false);
    r = recordAttempt(root, false, "");
    expect(r.fail_streak).toBe(6);
    expect(r.giveUp).toBe(true); // max_eval_fails=6
  });

  test("okでリセットされる", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    recordAttempt(root, false, "");
    recordAttempt(root, false, "");
    const r = recordAttempt(root, true, "");
    expect(r.fail_streak).toBe(0);
    expect(r.escalate).toBe(false);
    expect(r.giveUp).toBe(false);
  });

  function rootWithConfig(cfg: object): string {
    const root = tmpRoot();
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      join(root, ".graphhopper", "config.json"),
      JSON.stringify(cfg),
      "utf8",
    );
    startGoal(root, "test goal", "sess1");
    return root;
  }

  test("無効時(0以下)はgiveUpしない", () => {
    const root = rootWithConfig({ max_eval_fails: 0 });
    let r = recordAttempt(root, false, "");
    for (let i = 0; i < 9; i++) r = recordAttempt(root, false, "");
    expect(r.fail_streak).toBe(10);
    expect(r.escalate).toBe(true);
    expect(r.giveUp).toBe(false);
  });

  test("クランプ: stuck 10 / max 6 → 実効10", () => {
    const root = rootWithConfig({ stuck_threshold: 10, max_eval_fails: 6 });
    let r = recordAttempt(root, false, "");
    for (let i = 0; i < 8; i++) r = recordAttempt(root, false, "");
    expect(r.fail_streak).toBe(9);
    expect(r.giveUp).toBe(false);
    r = recordAttempt(root, false, "");
    expect(r.fail_streak).toBe(10);
    expect(r.giveUp).toBe(true);
  });

  test("resumeでfail_streakがリセットされる", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    recordAttempt(root, false, "");
    recordAttempt(root, false, "");
    expect(readState(root).fail_streak).toBe(2);
    pauseGoal(root);
    resumeGoal(root, "sess1");
    expect(readState(root).fail_streak).toBe(0);
  });
});

describe("verifier集約 aggregateVerdicts / checkVerifierResults", () => {
  test("全clean → clean", () => {
    expect(
      aggregateVerdicts([
        { lens: "requirement", level: "clean" },
        { lens: "behavior", level: "clean" },
        { lens: "progress", level: "clean" },
      ]),
    ).toEqual({ level: "clean", target: null });
  });

  test("単一drift → drift", () => {
    expect(
      aggregateVerdicts([
        { lens: "requirement", level: "clean" },
        { lens: "behavior", level: "drift", target: "design" },
        { lens: "progress", level: "clean" },
      ]),
    ).toEqual({ level: "drift", target: "design" });
  });

  test("混在時はimplementingを優先", () => {
    expect(
      aggregateVerdicts([
        { lens: "requirement", level: "drift", target: "design" },
        { lens: "behavior", level: "drift", target: "implementing" },
        { lens: "progress", level: "clean" },
      ]),
    ).toEqual({ level: "drift", target: "implementing" });
  });

  test("advisor単発（general 1件）", () => {
    expect(
      aggregateVerdicts([{ lens: "general", level: "clean" }]),
    ).toEqual({ level: "clean", target: null });
    expect(
      aggregateVerdicts([
        { lens: "general", level: "drift", target: "requirements" },
      ]),
    ).toEqual({ level: "drift", target: "requirements" });
  });

  test("空配列は拒否", () => {
    expect(checkVerifierResults([])).toMatch(/^error/);
    expect(checkVerifierResults(null)).toMatch(/^error/);
    expect(checkVerifierResults(undefined)).toMatch(/^error/);
  });

  test("未知lens・重複lensは拒否", () => {
    expect(
      checkVerifierResults([
        // @ts-expect-error 未知lensのテスト
        { lens: "unknown", level: "clean" },
      ]),
    ).toMatch(/^error/);
    expect(
      checkVerifierResults([
        { lens: "requirement", level: "clean" },
        { lens: "requirement", level: "clean" },
      ]),
    ).toMatch(/^error/);
  });

  test("driftのtarget無しは拒否・cleanは通る", () => {
    expect(
      checkVerifierResults([{ lens: "behavior", level: "drift" }]),
    ).toMatch(/^error/);
    expect(
      checkVerifierResults([
        { lens: "behavior", level: "drift", target: "implementing" },
      ]),
    ).toBeNull();
    expect(
      checkVerifierResults([{ lens: "general", level: "clean" }]),
    ).toBeNull();
  });
});

describe("stuck信号: 同一ファイル再編集", () => {
  test("同一連続で発火・別ファイルでリセット（純粋）", () => {
    let s = { file: null as string | null, streak: 0 };
    s = nextEditStreak(s, "src/a.ts");
    expect(s).toEqual({ file: "src/a.ts", streak: 1 });
    s = nextEditStreak(s, "src/a.ts");
    expect(s.streak).toBe(2);
    s = nextEditStreak(s, "src/b.ts");
    expect(s).toEqual({ file: "src/b.ts", streak: 1 });
  });

  test("noteEditで蓄積しcheckStuckが発火する", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    for (let i = 0; i < 4; i++) noteEdit(root, "src/a.ts");
    expect(checkStuck(root).escalate).toBe(false);
    noteEdit(root, "src/a.ts");
    const s = checkStuck(root);
    expect(s.escalate).toBe(true);
    expect(s.reasons.join(",")).toContain("edit_repeat(src/a.ts×5)");
  });

  test("eval pass（ok）でリセットされる", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    noteEdit(root, "src/a.ts");
    noteEdit(root, "src/a.ts");
    recordAttempt(root, true, "");
    const st = readState(root);
    expect(st.edit_streak).toBe(0);
    expect(st.edit_file).toBeNull();
  });
});

describe("stuck信号: diff停滞", () => {
  test("同一行数で発火・変化でリセット（純粋）", () => {
    let s = { lines: null as number | null, stall: 0 };
    s = nextDiffStall(s, 10);
    expect(s).toEqual({ lines: 10, stall: 0 });
    s = nextDiffStall(s, 10);
    s = nextDiffStall(s, 10);
    expect(s.stall).toBe(2);
    s = nextDiffStall(s, 12);
    expect(s).toEqual({ lines: 12, stall: 0 });
    s = nextDiffStall(s, null);
    expect(s.stall).toBe(0);
  });

  test("noteDiffLinesで蓄積しcheckStuckが発火する", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    noteDiffLines(root, 100);
    for (let i = 0; i < 2; i++) noteDiffLines(root, 100);
    expect(checkStuck(root).escalate).toBe(false); // stall=2
    noteDiffLines(root, 100);
    expect(checkStuck(root).escalate).toBe(false); // stall=3
    noteDiffLines(root, 100);
    const s = checkStuck(root); // stall=4
    expect(s.escalate).toBe(true);
    expect(s.reasons.join(",")).toContain("diff_stall×4");
  });
});

describe("stuck集約と通知抑止", () => {
  test("信号なしではescalateしない", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    expect(checkStuck(root)).toEqual({ escalate: false, reasons: [] });
  });

  test("fail_streak単独ではcheckStuckは発火しない（recordAttempt側の責務）", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    recordAttempt(root, false, "x");
    recordAttempt(root, false, "x");
    // fail_streak=2 でも進捗停滞系が無ければ escalate しない
    expect(checkStuck(root)).toEqual({ escalate: false, reasons: [] });
  });

  test("同一理由の再通知はスキップ・変化で再通知", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    const reasons = ["edit_repeat(src/a.ts×5)"];
    expect(noteStuckNotified(root, reasons)).toBe(true);
    expect(noteStuckNotified(root, reasons)).toBe(false);
    expect(noteStuckNotified(root, [...reasons, "diff_stall×4"])).toBe(true);
  });

  test("historyにstuck_hintが記録される", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    noteStuckNotified(root, ["fail_streak=3"]);
    const history = readFileSync(
      join(root, ".graphhopper", "history.jsonl"),
      "utf8",
    );
    expect(history).toContain("stuck_hint");
  });

  test("無効時(stuck_edit_repeat<=1)は発火しない", () => {
    for (const v of [0, 1]) {
      const root = tmpRoot();
      mkdirSync(join(root, ".graphhopper"), { recursive: true });
      writeFileSync(
        join(root, ".graphhopper", "config.json"),
        JSON.stringify({ stuck_edit_repeat: v }),
        "utf8",
      );
      startGoal(root, "test goal", "sess1");
      for (let i = 0; i < 10; i++) noteEdit(root, "src/a.ts");
      expect(checkStuck(root).escalate).toBe(false);
    }
  });

  test("無効時(stuck_diff_stall<=1)は発火しない", () => {
    for (const v of [0, 1]) {
      const root = tmpRoot();
      mkdirSync(join(root, ".graphhopper"), { recursive: true });
      writeFileSync(
        join(root, ".graphhopper", "config.json"),
        JSON.stringify({ stuck_diff_stall: v }),
        "utf8",
      );
      startGoal(root, "test goal", "sess1");
      for (let i = 0; i < 10; i++) noteDiffLines(root, 100);
      expect(checkStuck(root).escalate).toBe(false);
    }
  });

  test("複数信号の同時発火でreasonsに両方入る", () => {
    const root = tmpRoot();
    startGoal(root, "test goal", "sess1");
    for (let i = 0; i < 5; i++) noteEdit(root, "src/a.ts");
    for (let i = 0; i < 5; i++) noteDiffLines(root, 100);
    const s = checkStuck(root);
    expect(s.escalate).toBe(true);
    expect(s.reasons.length).toBe(2);
  });

  test("測定不能時はlines保持・stallリセット", () => {
    expect(nextDiffStall({ lines: 10, stall: 3 }, null)).toEqual({
      lines: 10,
      stall: 0,
    });
  });
});

describe("遷移合法性（program-side flow gate）", () => {
  test("合法遷移表", () => {
    expect(isLegalPhaseTransition("designing", "implementing")).toBe(true);
    expect(isLegalPhaseTransition("implementing", "polish")).toBe(true);
    expect(isLegalPhaseTransition("polish", "implementing")).toBe(true);
    expect(isLegalPhaseTransition("polish", "done")).toBe(true);
    expect(isLegalPhaseTransition("designing", "designing")).toBe(true);
  });

  test("非法遷移（*→done直指定・逆行）は拒否", () => {
    expect(isLegalPhaseTransition("designing", "done")).toBe(false);
    expect(isLegalPhaseTransition("implementing", "done")).toBe(false);
    expect(isLegalPhaseTransition("done", "implementing")).toBe(false);
    expect(isLegalPhaseTransition("done", "designing")).toBe(false);
    // implementing/polish→designingはB→A昇格専用経路として許可（濫用はhistory監査）
    expect(isLegalPhaseTransition("implementing", "designing")).toBe(true);
    expect(isLegalPhaseTransition("polish", "designing")).toBe(true);
  });

  test("setPhaseは非法遷移を拒否する（done抜け穴封じ）", () => {
    const root = tmpRoot();
    startGoal(root, "t", "s");
    expect(setPhase(root, "done")).toBeNull();
    expect(setPhase(root, "polish")).toBeNull();
    expect(setPhase(root, "implementing")?.state.phase).toBe("implementing");
    expect(setPhase(root, "polish")?.state.phase).toBe("polish");
    expect(setPhase(root, "implementing")?.state.phase).toBe("implementing");
  });
});

describe("outbox（durable通知）", () => {
  test("curated種別のみ投下・高頻度は対象外", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    recordEvent(root, { type: "attempt", goal: g.id, ok: false, fail_streak: 1, note: "x" });
    recordEvent(root, { type: "goal_complete", goal: g.id });
    const files = readdirSync(join(root, ".graphhopper", "outbox"));
    expect(files.length).toBe(1);
    expect(files[0]).toContain("goal_complete");
  });

  test("readHistoryで読める", () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    recordEvent(root, { type: "goal_complete", goal: g.id });
    const h = readHistory(root);
    expect(h.some((e) => e.type === "goal_complete")).toBe(true);
  });
});

describe("discover goal紐付け", () => {
  test("開始時点のactive goalが載る・lineageに載る", async () => {
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    const d = startDiscover(root, "t", "s");
    expect(d.goal_id).toBeNull();
    const d2 = startDiscover(root, "t2", "s2", g.id);
    expect(d2.goal_id).toBe(g.id);
    expect(readDiscover(root)?.goal_id).toBe(g.id);
    const { buildLineage } = await import("./state");
    expect(buildLineage(root).discover?.goal_id).toBe(g.id);
  });
});

describe("critic gate（flag両対応）", () => {
  test("既定falseでは素通り・trueではcritic必須", async () => {
    const { checkPhaseMove } = await import("./gate");
    const root = tmpRoot();
    startGoal(root, "t", "s");
    // 既定configはrequire_critic=false（このrepoのconfig.jsonもfalseのはずだが
    // テストrootにはconfigが無い→DEFAULT false）
    expect(checkPhaseMove(root, "implementing")).toBeNull();
    // trueに倒す
    writeFileSync(
      join(root, ".graphhopper", "config.json"),
      JSON.stringify({ require_critic: true }),
    );
    const err = checkPhaseMove(root, "implementing");
    expect(err).toContain("require_critic");
    setCriticVerdict(root, { level: "clean", reason: "ok" });
    expect(checkPhaseMove(root, "implementing")).toBeNull();
  });
});

describe("design scaffold＋構造ゲート", () => {
  test("startGoalで骨格が自動生成され、冪等（既存を壊さない）", async () => {
    const { scaffoldDesignDoc } = await import("./state");
    const { planPath } = await import("./state");
    const root = tmpRoot();
    const g = startGoal(root, "scaffold test", "s").goal;
    const p = planPath(root, g.id);
    expect(existsSync(p)).toBe(true);
    const raw = readFileSync(p, "utf8");
    expect(raw).toContain("## 1. goal理解");
    expect(raw).toContain("## 4. 実装タスク列");
    writeFileSync(p, "# custom\n");
    expect(scaffoldDesignDoc(root, g.id, "t")).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("# custom\n");
  });

  test("checkDesignDoc: テンプレ通過・欠落検出・ファイル不在", async () => {
    const { checkDesignDoc } = await import("./gate");
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    expect(checkDesignDoc(root, g.id)).toEqual([]);
    const { planPath } = await import("./state");
    writeFileSync(planPath(root, g.id), "# design\n\n## 1. goal理解\n");
    const missing = checkDesignDoc(root, g.id);
    expect(missing).toContain("現状");
    expect(missing).toContain("設計判断");
    expect(checkDesignDoc(root, "g-nonexistent")).toEqual(["design doc自体が無い"]);
  });

  test("checkPhaseMove: 骨格を削るとimplementing遷移が止まる", async () => {
    const { checkPhaseMove } = await import("./gate");
    const { planPath } = await import("./state");
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    expect(checkPhaseMove(root, "implementing")).toBeNull();
    writeFileSync(planPath(root, g.id), "# empty\n");
    const err = checkPhaseMove(root, "implementing");
    expect(err).toContain("骨格不足");
  });
});

describe("タスク列抽出（progress素材）", () => {
  test("チェックボックス行を抽出・完了数を数える", async () => {
    const { extractTasks, checkDesignDoc } = await import("./gate");
    const { planPath } = await import("./state");
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    // scaffold自体が `- [ ] T1` を1行含む
    const sc = extractTasks(root, g.id);
    expect(sc.total).toBe(1);
    expect(sc.done).toBe(0);
    writeFileSync(
      planPath(root, g.id),
      "# d\n\n- [x] done1\n- [ ] todo1\n- plain bullet\n",
    );
    const p = extractTasks(root, g.id);
    expect(p.total).toBe(2);
    expect(p.done).toBe(1);
    expect(p.items[0]).toEqual({ text: "done1", done: true });
  });

  test("ファイル不在は空", async () => {
    const { extractTasks } = await import("./gate");
    expect(extractTasks(tmpRoot(), "g-nope")).toEqual({ total: 0, done: 0, items: [] });
  });
});

describe("評価機能（state層）", () => {
  test("verdict未指定modelはconfig既定で補完される", async () => {
    const { setVerifierVerdict, setCriticVerdict } = await import("./state");
    const root = tmpRoot();
    startGoal(root, "t", "s");
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      join(root, ".graphhopper", "config.json"),
      JSON.stringify({ agents: { "graphhopper-verifier": "m/v", "graphhopper-critic": "m/c" } }),
    );
    const v = setVerifierVerdict(root, { level: "clean", reason: "r", target: null, lens: ["general"] });
    expect(v.last_verifier?.model).toBe("m/v");
    const c = setCriticVerdict(root, { level: "drift", reason: "r" });
    expect(c.critic_review?.model).toBe("m/c");
    const v2 = setVerifierVerdict(root, { level: "clean", reason: "r", target: null, lens: ["general"], model: "x/y" });
    expect(v2.last_verifier?.model).toBe("x/y");
  });

  test("computeGoalScore式: 巻き戻し・fail・gate・追加roundで減点", async () => {
    const { computeGoalScore, setPhase, setVerifierVerdict, completeGoal } = await import("./state");
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    setPhase(root, "implementing");
    recordAttempt(root, false, "x");
    recordAttempt(root, false, "x");
    setPhase(root, "polish");
    setVerifierVerdict(root, { level: "drift", reason: "r", target: "implementing", lens: ["general"] });
    setPhase(root, "implementing");
    // rewinds=1, maxFail=2, gate=0, rounds=1 → 100-15-10-0-0=75
    expect(computeGoalScore(root, g.id)).toEqual({
      value: 75,
      breakdown: { rewinds: 1, maxFailStreak: 2, gateBlocks: 0, verifierRounds: 1 },
    });
    const done = completeGoal(root);
    expect(done?.goal.score?.value).toBe(75);
  });

  test("buildScoreboard集計", async () => {
    const { buildScoreboard, setVerifierVerdict } = await import("./state");
    const root = tmpRoot();
    startGoal(root, "t", "s");
    setVerifierVerdict(root, { level: "drift", reason: "r", target: "implementing", lens: ["general"], model: "m/a" });
    setVerifierVerdict(root, { level: "clean", reason: "r", target: null, lens: ["general"], model: "m/a" });
    const sb = buildScoreboard(root);
    expect(sb.models).toContainEqual({ model: "m/a", role: "verifier", verdicts: 2, clean: 1, drift: 1, mixed: 0 });
    expect(sb.goals.length).toBe(1);
  });
});

describe("scoreboard hints（提案のみ・ガード付き）", () => {
  test("サンプル不足は判断保留・低scoreと多巻き戻しを指摘", async () => {
    const { buildScoreboard, setVerifierVerdict, completeGoal, setPhase, startGoal } = await import("./state");
    const root = tmpRoot();
    const g = startGoal(root, "t", "s").goal;
    setVerifierVerdict(root, { level: "drift", reason: "r", target: "implementing", lens: ["general"], model: "m/a" });
    let sb = buildScoreboard(root);
    expect(sb.hints.some((h) => h.includes("データ不足"))).toBe(true);
    for (let i = 0; i < 5; i++) {
      setVerifierVerdict(root, { level: "drift", reason: "r", target: "implementing", lens: ["general"], model: "m/a" });
    }
    sb = buildScoreboard(root);
    expect(sb.hints.some((h) => h.includes("drift検出率"))).toBe(true);
    expect(sb.hints.some((h) => h.includes("データ不足"))).toBe(false);
    // 低score goal: rewind2 + fail2でscore<70を作る（100-30-10=60）
    setPhase(root, "implementing");
    setPhase(root, "polish");
    setPhase(root, "implementing");
    setPhase(root, "polish");
    setPhase(root, "implementing");
    setPhase(root, "polish");
    recordAttempt(root, false, "x");
    recordAttempt(root, false, "x");
    const done = completeGoal(root);
    expect(done?.goal.score?.value).toBeLessThan(70);
    sb = buildScoreboard(root);
    expect(sb.hints.some((h) => h.includes("要振り返り"))).toBe(true);
    expect(sb.hints.some((h) => h.includes("巻き戻し2回"))).toBe(true);
    void g;
  });
});

describe("deep検知（RISK_PATHS×自goal差分）", () => {
  // bun $ 形の最小fake（template呼び→cwd→nothrow→quiet）。jj/gitで応答を分ける
  const fakeShell = (
    jj: { code: number; out: string },
    git: { code: number; out: string },
  ) =>
    ((strings: TemplateStringsArray) => {
      const cmd = strings.join(" ");
      const r = cmd.includes("jj diff") ? jj : git;
      return {
        cwd: () => ({
          nothrow: () => ({
            quiet: () =>
              Promise.resolve({
                exitCode: r.code,
                stdout: { toString: () => r.out },
              }),
          }),
        }),
      };
    }) as unknown as Parameters<
      typeof import("./state").measureChangedFiles
    >[0];

  test("detectDeepRisk: 自goalのrisk接触のみtrue", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    expect(s.detectDeepRisk(root, ["src/state.ts"], [])).toEqual({
      deep: true,
      reason: "risk files touched: src/state.ts",
    });
    // 初期脏れは除外
    expect(
      s.detectDeepRisk(root, ["src/state.ts"], ["src/state.ts"]),
    ).toEqual({ deep: false, reason: null });
    expect(s.detectDeepRisk(root, ["README.md"], [])).toEqual({
      deep: false,
      reason: null,
    });
    // legacy（初期集合null）はfalse
    expect(s.detectDeepRisk(root, ["src/state.ts"], null)).toEqual({
      deep: false,
      reason: null,
    });
    expect(s.detectDeepRisk(root, ["src/state.ts"], undefined)).toEqual({
      deep: false,
      reason: null,
    });
    // 正規化: 絶対パス・./prefix
    expect(s.detectDeepRisk(root, [join(root, "src/gate.ts")], []).deep).toBe(
      true,
    );
    expect(s.detectDeepRisk(root, ["./src/gate.ts"], []).deep).toBe(true);
  });

  test("measureChangedFiles: jj→git→空", async () => {
    const s = await import("./state");
    const noShell = undefined as unknown as Parameters<
      typeof import("./state").measureChangedFiles
    >[0];
    expect(await s.measureChangedFiles(noShell, tmpRoot(), null)).toEqual([]);
    expect(await s.measureChangedFiles(noShell, tmpRoot(), "zzz")).toEqual([]);
    const jjOk = fakeShell(
      { code: 0, out: "src/state.ts\nREADME.md\n" },
      { code: 0, out: "" },
    );
    expect(await s.measureChangedFiles(jjOk, "/r", "abc123")).toEqual([
      "src/state.ts",
      "README.md",
    ]);
    const jjFail = fakeShell({ code: 1, out: "" }, { code: 0, out: "src/gate.ts\n" });
    expect(await s.measureChangedFiles(jjFail, "/r", "abc123")).toEqual([
      "src/gate.ts",
    ]);
    const both = fakeShell({ code: 1, out: "" }, { code: 1, out: "" });
    expect(await s.measureChangedFiles(both, "/r", "abc123")).toEqual([]);
  });

  test("snapshotInitialDiffFiles: 設定・null無視・pause/resume保持", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    const g1 = s.startGoal(root, "first", "s1").goal;
    expect(s.getActive(root)!.state.initial_diff_files).toBeNull();
    s.snapshotInitialDiffFiles(root, ["src/state.ts"]);
    expect(s.getActive(root)!.state.initial_diff_files).toEqual([
      "src/state.ts",
    ]);
    s.snapshotInitialDiffFiles(root, null);
    expect(s.getActive(root)!.state.initial_diff_files).toEqual([
      "src/state.ts",
    ]);
    s.pauseGoal(root);
    s.startGoal(root, "second", "s2");
    expect(s.getActive(root)!.state.initial_diff_files).toBeNull();
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const p = join(root, ".graphhopper", "goals.json");
    const gj = JSON.parse(readFileSync(p, "utf8"));
    gj.active = g1.id;
    writeFileSync(p, JSON.stringify(gj));
    s.resumeGoal(root, "s1");
    expect(s.getActive(root)!.state.initial_diff_files).toEqual([
      "src/state.ts",
    ]);
  });

  test("recordRouterCheckWithRisk: deep反映とhistory記録", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.snapshotInitialDiffFiles(root, []);
    const shell = fakeShell({ code: 0, out: "src/gate.ts\n" }, { code: 0, out: "" });
    const st = await s.recordRouterCheckWithRisk(shell, root, "abc123", 10, "advisor");
    expect(st.router.deep).toBe(true);
    expect(st.router.deep_reason).toContain("src/gate.ts");
    const ev = s
      .readHistory(root)
      .find((h) => h.type === "router_check");
    expect(ev?.deep).toBe(true);
    const root2 = tmpRoot();
    s.startGoal(root2, "t", "s1");
    s.snapshotInitialDiffFiles(root2, []);
    const shell2 = fakeShell({ code: 0, out: "README.md\n" }, { code: 0, out: "" });
    const st2 = await s.recordRouterCheckWithRisk(shell2, root2, "abc123", 5, "advisor");
    expect(st2.router.deep).toBe(false);
    expect(st2.router.deep_reason).toBeNull();
  });

  test("deepはconsult gateと直交する", async () => {
    const s = await import("./state");
    const { checkPhaseMove } = await import("./gate");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.bindEntryRoute(root, "advised");
    s.snapshotInitialDiffFiles(root, []);
    const shell = fakeShell({ code: 0, out: "src/state.ts\n" }, { code: 0, out: "" });
    await s.recordRouterCheckWithRisk(shell, root, "abc123", 10, "advisor");
    // deepでも相談なしでは通らない
    expect(checkPhaseMove(root, "implementing")).toContain(
      "graphhopper_consult_set",
    );
    s.setConsult(root, "advisor", { summary: "ok" });
    expect(checkPhaseMove(root, "implementing")).toBeNull();
    // full entry＋deepは相談なしで通る
    const root2 = tmpRoot();
    s.startGoal(root2, "t", "s1");
    s.snapshotInitialDiffFiles(root2, []);
    await s.recordRouterCheckWithRisk(shell, root2, "abc123", 10, "advisor");
    expect(checkPhaseMove(root2, "implementing")).toBeNull();
  });

  test("shell例外時はfail-open（deepなし）", async () => {
    const s = await import("./state");
    const throwing = (() => {
      throw new Error("boom");
    }) as unknown as Parameters<
      typeof import("./state").measureChangedFiles
    >[0];
    expect(await s.measureChangedFiles(throwing, "/r", "abc123")).toEqual([]);
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.snapshotInitialDiffFiles(root, []);
    const st = await s.recordRouterCheckWithRisk(throwing, root, "abc123", 10, "advisor");
    expect(st.router.deep).toBe(false);
    expect(st.router.deep_reason).toBeNull();
  });
});

describe("混成帰属（per-lens model）", () => {
  test("checkVerifierResultsはmodelの型のみ検証（lens規則不変）", async () => {
    const { checkVerifierResults } = await import("./state");
    expect(
      checkVerifierResults([{ lens: "general", level: "clean", model: 123 as unknown as string }]),
    ).toContain("model");
    expect(
      checkVerifierResults([{ lens: "general", level: "clean", model: "  " }]),
    ).toContain("model");
    expect(
      checkVerifierResults([{ lens: "general", level: "clean", model: "m/a" }]),
    ).toBeNull();
    // lens規則は不変（light/advisedはgeneral×1のみ）
    expect(
      checkVerifierResults(
        [
          { lens: "requirement", level: "clean", model: "m/a" },
          { lens: "behavior", level: "clean", model: "m/b" },
        ],
        { entryRoute: "advised" },
      ),
    ).toContain("general");
  });

  test("setVerifierVerdictはmodelsをlens長に揃える", async () => {
    const { setVerifierVerdict } = await import("./state");
    const root = tmpRoot();
    startGoal(root, "t", "s");
    const v = setVerifierVerdict(root, {
      level: "clean",
      reason: "r",
      target: null,
      lens: ["requirement", "behavior"],
      model: "m/a",
      models: ["m/a"],
    });
    expect(v.last_verifier?.models).toEqual(["m/a", "m/a"]);
    const v2 = setVerifierVerdict(root, {
      level: "clean",
      reason: "r",
      target: null,
      lens: ["requirement", "behavior"],
      model: "m/a",
      models: ["m/a", "m/b", "m/c"],
    });
    expect(v2.last_verifier?.models).toEqual(["m/a", "m/b"]);
  });

  test("混成runはdistinct modelに行bump＋hints注記", async () => {
    const { buildScoreboard, setVerifierVerdict } = await import("./state");
    const root = tmpRoot();
    startGoal(root, "t", "s");
    setVerifierVerdict(root, {
      level: "clean",
      reason: "r",
      target: null,
      lens: ["requirement", "behavior"],
      model: "m/a",
      models: ["m/a", "m/b"],
    });
    const sb = buildScoreboard(root);
    expect(sb.models).toContainEqual({
      model: "m/a",
      role: "verifier",
      verdicts: 1,
      clean: 1,
      drift: 0,
      mixed: 1,
    });
    expect(sb.models).toContainEqual({
      model: "m/b",
      role: "verifier",
      verdicts: 1,
      clean: 1,
      drift: 0,
      mixed: 1,
    });
    expect(sb.hints.some((h) => h.includes("混成"))).toBe(true);
  });

  test("formatLensModelsは差分のみ表示", async () => {
    const { formatLensModels } = await import("./state");
    expect(
      formatLensModels(["behavior", "requirement"], ["m/b", "m/a"], "m/a"),
    ).toBe("behavior@m/b");
    expect(formatLensModels(["general"], ["m/a"], "m/a")).toBe("");
    expect(formatLensModels(["general"], undefined, "m/a")).toBe("");
  });
});

describe("pause/resumeスナップショット（goal切替の文脈漏れ対策）", () => {
  test("pauseで文脈保存→別goal走行→resumeで復帰", async () => {
    const { pauseGoal, resumeGoal, startGoal, setPhase, setEvalCmd, getActive } = await import("./state");
    const root = tmpRoot();
    const g1 = startGoal(root, "first", "s1").goal;
    setPhase(root, "implementing");
    setEvalCmd(root, "make test");
    pauseGoal(root);
    // 別goalが走る（stateは上書きされる）
    startGoal(root, "second", "s2");
    setPhase(root, "polish");
    // g1に戻す
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const p = join(root, ".graphhopper", "goals.json");
    const gj = JSON.parse(readFileSync(p, "utf8"));
    gj.active = g1.id;
    writeFileSync(p, JSON.stringify(gj));
    const r = resumeGoal(root, "s1");
    expect(r?.goal.id).toBe(g1.id);
    const a = getActive(root)!;
    expect(a.state.goal_id).toBe(g1.id);
    expect(a.state.phase).toBe("implementing");
    expect(a.state.eval_cmd).toBe("make test");
    expect(a.state.session_id).toBe("s1");
  });

  test("snapshot無しのresumeは現状維持（後方互換）", async () => {
    const { resumeGoal, startGoal, getActive } = await import("./state");
    const root = tmpRoot();
    startGoal(root, "t", "s");
    const r = resumeGoal(root, "s2");
    expect(r?.state.phase).toBe("designing");
    expect(getActive(root)?.state.session_id).toBe("s2");
  });
});

describe("stashDiff（verifier用diff退避）", () => {
  test("不正baselineはshellを呼ばずnull", async () => {
    const noShell = undefined as unknown as Parameters<
      typeof import("./state").stashDiff
    >[0];
    const { stashDiff } = await import("./state");
    await expect(stashDiff(noShell, tmpRoot(), "x; rm", "g-abc")).resolves.toBeNull();
    await expect(stashDiff(noShell, tmpRoot(), null, "g-abc")).resolves.toBeNull();
    await expect(stashDiff(noShell, tmpRoot(), "abc123", "bad id")).resolves.toBeNull();
  });

  test("実git repoで退避できる", async () => {
    const { stashDiff } = await import("./state");
    const { $ } = await import("bun");
    const root = tmpRoot();
    await $`git init -q ${root}`.quiet();
    await $`git -C ${root} config user.email t@t`.quiet();
    await $`git -C ${root} config user.name t`.quiet();
    await Bun.write(`${root}/a.txt`, "one\n");
    await $`git -C ${root} add -A`.quiet();
    await $`git -C ${root} commit -qm init`.quiet();
    const rev = (await $`git -C ${root} rev-parse HEAD`.text()).trim();
    await Bun.write(`${root}/a.txt`, "one\ntwo\n");
    const stashed = await stashDiff($, root, rev, "g-abc123");
    expect(stashed).not.toBeNull();
    expect(stashed!.lines).toBeGreaterThan(0);
    expect(stashed!.path).toContain("g-abc123");
    const { existsSync } = await import("node:fs");
    expect(existsSync(stashed!.path)).toBe(true);
  });

  test("初期脏れを除外した実効diffだけ退避する", async () => {
    const s = await import("./state");
    type Shell = Parameters<typeof s.stashDiff>[0];
    // name-only列＋per-file差分＋全文を振る舞い分けるfake
    const stashFake = (files: string[], perFile: Record<string, string>, full: string) =>
      ((strings: TemplateStringsArray, ...vals: unknown[]) => {
        const joined = strings.join("#");
        const ok = (out: string) => ({
          cwd: () => ({
            nothrow: () => ({
              quiet: () =>
                Promise.resolve({
                  exitCode: 0,
                  stdout: { toString: () => out },
                }),
            }),
          }),
        });
        if (joined.includes("--name-only")) return ok(files.join("\n") + "\n");
        if (vals.length >= 2) {
          const f = s.normalizeForGate("/r", String(vals[1]));
          return ok(perFile[f] ?? "");
        }
        return ok(full);
      }) as unknown as Shell;
    const shell = stashFake(
      ["old.txt", "new.txt"],
      { "old.txt": "OLD DIFF\n", "new.txt": "NEW DIFF\n" },
      "FULL DIFF\n",
    );
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.snapshotInitialDiffFiles(root, ["old.txt"]);
    const stashed = await s.stashDiff(shell, root, "abc123", "g-abc123");
    expect(stashed).not.toBeNull();
    const { readFileSync } = await import("node:fs");
    const body = readFileSync(stashed!.path, "utf8");
    expect(body).toContain("NEW DIFF");
    expect(body).not.toContain("OLD DIFF");
    expect(body).not.toContain("FULL DIFF");
  });

  test("legacy（初期集合null）は全文退避に倒す", async () => {
    const s = await import("./state");
    type Shell = Parameters<typeof s.stashDiff>[0];
    const shell = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const joined = strings.join("#");
      const ok = (out: string) => ({
        cwd: () => ({
          nothrow: () => ({
            quiet: () =>
              Promise.resolve({
                exitCode: 0,
                stdout: { toString: () => out },
              }),
          }),
        }),
      });
      if (joined.includes("--name-only"))
        return ok("old.txt\nnew.txt\n");
      if (vals.length >= 2) return ok("PER-FILE\n");
      return ok("FULL DIFF\n");
    }) as unknown as Shell;
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    // snapshotなし＝initial_diff_files null
    const stashed = await s.stashDiff(shell, root, "abc123", "g-abc123");
    expect(stashed).not.toBeNull();
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(stashed!.path, "utf8")).toContain("FULL DIFF");
  });

  test("自goal変更なし（全除外）は空退避", async () => {
    const s = await import("./state");
    type Shell = Parameters<typeof s.stashDiff>[0];
    const shell = ((strings: TemplateStringsArray) => {
      const joined = strings.join("#");
      const ok = (out: string) => ({
        cwd: () => ({
          nothrow: () => ({
            quiet: () =>
              Promise.resolve({
                exitCode: 0,
                stdout: { toString: () => out },
              }),
          }),
        }),
      });
      if (joined.includes("--name-only")) return ok("old.txt\n");
      return ok("SHOULD NOT APPEAR\n");
    }) as unknown as Shell;
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.snapshotInitialDiffFiles(root, ["old.txt"]);
    const stashed = await s.stashDiff(shell, root, "abc123", "g-abc123");
    expect(stashed).not.toBeNull();
    expect(stashed!.lines).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(stashed!.path, "utf8")).toBe("");
  });
});

describe("退避diff掃除（complete/clear）", () => {
  test("completeGoal/clearActiveGoalでgh-verifyファイルが消える", async () => {
    const { removeStashedDiff, stashedDiffPath } = await import("./state");
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const place = (root: string, gid: string): string => {
      const p = stashedDiffPath(root, gid);
      // .graphhopper/tmp配下に配置されること（子権限で読めるrepo内）
      expect(p).toContain(join(".graphhopper", "tmp"));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "diff\n", "utf8");
      return p;
    };
    const gid = `g-${Date.now().toString(36)}test`;
    // 不正idは無視（例外なし）
    expect(() => removeStashedDiff(tmpRoot(), "bad id")).not.toThrow();
    // 存在しないgoalの掃除も成功扱い
    expect(() => removeStashedDiff(tmpRoot(), gid)).not.toThrow();
    // 実ファイルが消えること
    const root = mkdtempSync(join(tmpdir(), "gh-clean-"));
    const { startGoal, completeGoal, clearActiveGoal } = await import("./state");
    startGoal(root, "t", "sClean");
    const { getActive } = await import("./state");
    const activeId = getActive(root)!.goal.id;
    const p1 = place(root, activeId);
    expect(existsSync(p1)).toBe(true);
    completeGoal(root);
    expect(existsSync(p1)).toBe(false);
    // clear側
    startGoal(root, "t2", "sClean2");
    const activeId2 = getActive(root)!.goal.id;
    const p2 = place(root, activeId2);
    clearActiveGoal(root);
    expect(existsSync(p2)).toBe(false);
  });
});

describe("entry_route（jevトリアージ）", () => {
  test("pendingはgoal startで消費される（light）", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    s.writePendingRoute(root, "light", "test");
    expect(s.readPendingRoute(root)?.route).toBe("light");
    const { goal } = s.startGoal(root, "t", "s1");
    expect(s.getActive(root)!.state.entry_route).toBe("light");
    expect(s.readPendingRoute(root)).toBeNull();
    expect(
      s.readHistory(root).some((h) => h.type === "entry_route" && (h as { route?: string }).route === "light" && (h as { goal?: string }).goal === goal.id),
    ).toBe(true);
  });

  test("旧B pendingはlightに正規化される", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      join(root, ".graphhopper", "pending_route.json"),
      JSON.stringify({ route: "B", reason: "legacy", at: "t" }),
    );
    expect(s.readPendingRoute(root)?.route).toBe("light");
  });

  test("pending無しはnull＝full", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    expect(s.getActive(root)!.state.entry_route).toBeNull();
  });

  test("bindEntryRouteは未記録にのみbindする（direct拒否）", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    expect(s.bindEntryRoute(root, "advised", "r")!.state.entry_route).toBe("advised");
    expect(s.bindEntryRoute(root, "full", "r")).toBeNull();
    expect(s.getActive(root)!.state.entry_route).toBe("advised");
    const root2 = tmpRoot();
    s.startGoal(root2, "t", "s1");
    expect(s.bindEntryRoute(root2, "direct", "r")).toBeNull();
    expect(s.getActive(root2)!.state.entry_route).toBeNull();
  });

  test("bindEntryRouteはdone/pausedにbindしない（live実証の欠測防止）", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    // done＋null（completeはentry_routeを消さない）にbindしない
    s.completeGoal(root);
    expect(s.getActive(root)!.goal.status).toBe("done");
    expect(s.bindEntryRoute(root, "advised", "r")).toBeNull();
    expect(s.getActive(root)!.state.entry_route).toBeNull();
    // pausedにもbindしない
    const root2 = tmpRoot();
    s.startGoal(root2, "t", "s1");
    s.pauseGoal(root2);
    expect(s.bindEntryRoute(root2, "advised", "r")).toBeNull();
    expect(s.getActive(root2)!.state.entry_route).toBeNull();
    // activeには従来通りbindする
    const root3 = tmpRoot();
    s.startGoal(root3, "t", "s1");
    expect(s.bindEntryRoute(root3, "advised", "r")!.state.entry_route).toBe("advised");
  });

  test("escalateはlight/advised→fullのみ（designing巻き戻し＋escalated_at）", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    expect(s.escalateEntryRoute(root)).toBeNull();
    s.bindEntryRoute(root, "light");
    s.setPhase(root, "implementing");
    const r = s.escalateEntryRoute(root)!;
    expect(r.state.entry_route).toBe("full");
    expect(r.state.phase).toBe("designing");
    expect(r.state.escalated_at).not.toBeNull();
    expect(s.escalateEntryRoute(root)).toBeNull();
    // oracleは昇格対象外
    const root2 = tmpRoot();
    s.startGoal(root2, "t", "s1");
    s.bindEntryRoute(root2, "oracle");
    expect(s.escalateEntryRoute(root2)).toBeNull();
  });

  test("verifier_setのroute×lens照合", () => {
    const g = { lens: "general", level: "clean" } as const;
    const three = [
      { lens: "requirement", level: "clean" },
      { lens: "behavior", level: "clean" },
      { lens: "progress", level: "clean" },
    ] as Parameters<typeof checkVerifierResults>[0];
    expect(checkVerifierResults([g], { entryRoute: "light" })).toBeNull();
    expect(checkVerifierResults([g], { entryRoute: "advised" })).toBeNull();
    expect(checkVerifierResults(three, { entryRoute: "light" })).not.toBeNull();
    expect(checkVerifierResults(three, { entryRoute: "light", escalated: true })).toBeNull();
    expect(checkVerifierResults([g], { entryRoute: "light", escalated: true })).not.toBeNull();
    expect(checkVerifierResults([g], { entryRoute: "full" })).toBeNull();
    expect(checkVerifierResults(three, { entryRoute: "oracle" })).toBeNull();
    expect(checkVerifierResults([g], { entryRoute: "oracle" })).toBeNull();
    expect(checkVerifierResults([g], {})).toBeNull();
    expect(checkVerifierResults([g])).toBeNull();
  });

  test("normalizeEntryRoute: 新名・旧名・不正", async () => {
    const s = await import("./state");
    expect(s.normalizeEntryRoute("light")).toBe("light");
    expect(s.normalizeEntryRoute("Advised")).toBe("advised");
    expect(s.normalizeEntryRoute("B")).toBe("light");
    expect(s.normalizeEntryRoute("c")).toBe("direct");
    expect(s.normalizeEntryRoute("zzz")).toBeNull();
    expect(s.normalizeEntryRoute(null)).toBeNull();
  });
});

describe("light/advised designing巻き戻しのescalate強制", () => {
  test("light未昇格の素の巻き戻しはescalate誘導エラー", async () => {
    const s = await import("./state");
    const { checkPhaseMove } = await import("./gate");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.bindEntryRoute(root, "light");
    s.setPhase(root, "implementing");
    const err = checkPhaseMove(root, "designing");
    expect(err).toContain("graphhopper_escalate");
    // fullは素の巻き戻し可
    const root2 = tmpRoot();
    s.startGoal(root2, "t", "s1");
    s.setPhase(root2, "implementing");
    expect(checkPhaseMove(root2, "designing")).toBeNull();
    // polish起点もlightはescalate強制
    const root3 = tmpRoot();
    s.startGoal(root3, "t", "s1");
    s.bindEntryRoute(root3, "light");
    s.setPhase(root3, "implementing");
    s.setPhase(root3, "polish");
    expect(checkPhaseMove(root3, "designing")).toContain("graphhopper_escalate");
    // oracleは素の巻き戻し可（full相当）
    const root4 = tmpRoot();
    s.startGoal(root4, "t", "s1");
    s.bindEntryRoute(root4, "oracle");
    s.setPhase(root4, "implementing");
    expect(checkPhaseMove(root4, "designing")).toBeNull();
  });

  test("escalateはpolishからも可（last_verifierリセット）", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.bindEntryRoute(root, "light");
    s.setPhase(root, "implementing");
    s.setPhase(root, "polish");
    s.setVerifierVerdict(root, {
      level: "clean",
      reason: "x",
      target: null,
      lens: ["general"],
    });
    expect(s.getActive(root)!.state.last_verifier).not.toBeNull();
    const r = s.escalateEntryRoute(root)!;
    expect(r.state.phase).toBe("designing");
    expect(r.state.last_verifier).toBeNull();
    expect(r.state.entry_route).toBe("full");
  });
});

describe("昇格後critic必須＋stuck自動昇格", () => {
  test("escalated後はcritic無しでimplementingに進めない", async () => {
    const s = await import("./state");
    const { checkPhaseMove } = await import("./gate");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.bindEntryRoute(root, "light");
    s.setPhase(root, "implementing");
    s.escalateEntryRoute(root);
    expect(checkPhaseMove(root, "implementing")).toContain("critic_review");
    s.setCriticVerdict(root, { level: "clean", reason: "ok" });
    expect(checkPhaseMove(root, "implementing")).toBeNull();
  });

  test("autoEscalateOnStuckはlight/advised未昇格のみ昇格", async () => {
    const s = await import("./state");
    const g = await import("./gate");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    expect(g.autoEscalateOnStuck(root)).toBeNull();
    s.bindEntryRoute(root, "advised");
    s.setPhase(root, "implementing");
    expect(g.autoEscalateOnStuck(root)!.state.entry_route).toBe("full");
    expect(g.autoEscalateOnStuck(root)).toBeNull();
  });
});

describe("entry相談ゲート（advised/oracle）", () => {
  test("advisedはadvisor相談なしでimplementingに進めない", async () => {
    const s = await import("./state");
    const { checkPhaseMove } = await import("./gate");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.bindEntryRoute(root, "advised");
    expect(checkPhaseMove(root, "implementing")).toContain(
      "graphhopper_consult_set",
    );
    s.setConsult(root, "advisor", { summary: "asked x, got y" });
    expect(s.getActive(root)!.state.advisor_consult?.summary).toBe(
      "asked x, got y",
    );
    expect(checkPhaseMove(root, "implementing")).toBeNull();
  });

  test("oracleはoracle相談が必要（advisor相談では不可）", async () => {
    const s = await import("./state");
    const { checkPhaseMove } = await import("./gate");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.bindEntryRoute(root, "oracle");
    expect(checkPhaseMove(root, "implementing")).toContain(
      "graphhopper_consult_set",
    );
    s.setConsult(root, "advisor", { summary: "wrong kind" });
    expect(checkPhaseMove(root, "implementing")).toContain(
      "graphhopper_consult_set",
    );
    s.setConsult(root, "oracle", { summary: "asked o, got p" });
    expect(checkPhaseMove(root, "implementing")).toBeNull();
  });

  test("full/light/nullは相談なしで通る", async () => {
    const s = await import("./state");
    const { checkPhaseMove } = await import("./gate");
    for (const route of ["full", "light"] as const) {
      const root = tmpRoot();
      s.startGoal(root, "t", "s1");
      s.bindEntryRoute(root, route);
      expect(checkPhaseMove(root, "implementing")).toBeNull();
    }
    const rootNull = tmpRoot();
    s.startGoal(rootNull, "t", "s1");
    expect(checkPhaseMove(rootNull, "implementing")).toBeNull();
  });

  test("昇格後はcriticのみ（advisor相談不要）", async () => {
    const s = await import("./state");
    const { checkPhaseMove } = await import("./gate");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.bindEntryRoute(root, "advised");
    s.setPhase(root, "implementing");
    s.escalateEntryRoute(root);
    // 相談ゲートではなくcritic gateが効く
    expect(checkPhaseMove(root, "implementing")).toContain("critic_review");
    s.setCriticVerdict(root, { level: "clean", reason: "ok" });
    expect(checkPhaseMove(root, "implementing")).toBeNull();
  });

  test("pause→別goal→resumeで相談記録が漏れない／失われない", async () => {
    const s = await import("./state");
    const { checkPhaseMove } = await import("./gate");
    const root = tmpRoot();
    const g1 = s.startGoal(root, "first", "s1").goal;
    s.bindEntryRoute(root, "advised");
    s.setConsult(root, "advisor", { summary: "g1 consult" });
    s.pauseGoal(root);
    // 別goalが走る（stateは上書きされる）
    s.startGoal(root, "second", "s2");
    s.bindEntryRoute(root, "advised");
    // g2は未相談→ゲートが効く（g1の記録を継承していない＝リークなし）
    expect(checkPhaseMove(root, "implementing")).toContain(
      "graphhopper_consult_set",
    );
    s.setConsult(root, "advisor", { summary: "g2 consult" });
    s.pauseGoal(root);
    // g1に戻す
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const p = join(root, ".graphhopper", "goals.json");
    const gj = JSON.parse(readFileSync(p, "utf8"));
    gj.active = g1.id;
    writeFileSync(p, JSON.stringify(gj));
    const r = s.resumeGoal(root, "s1");
    expect(r?.goal.id).toBe(g1.id);
    // g1の記録が復帰（喪失なし・g2の記録で上書きなし）
    expect(s.getActive(root)!.state.advisor_consult?.summary).toBe(
      "g1 consult",
    );
  });
});

describe("初期脏れsnapshot（baseline誤認防止）", () => {
  test("effectiveDiffLines: 減算・floor・legacy", async () => {
    const s = await import("./state");
    expect(s.effectiveDiffLines(10, 3)).toBe(7);
    expect(s.effectiveDiffLines(2, 5)).toBe(0);
    expect(s.effectiveDiffLines(10, null)).toBe(10);
    expect(s.effectiveDiffLines(10, undefined)).toBe(10);
  });

  test("snapshotInitialDirt: 設定・不正値無視", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    expect(s.getActive(root)!.state.initial_diff_lines).toBeNull();
    s.snapshotInitialDirt(root, 1349);
    expect(s.getActive(root)!.state.initial_diff_lines).toBe(1349);
    s.snapshotInitialDirt(root, null);
    s.snapshotInitialDirt(root, -1);
    expect(s.getActive(root)!.state.initial_diff_lines).toBe(1349);
  });

  test("pause/resumeで初期脏れが維持される", async () => {
    const s = await import("./state");
    const root = tmpRoot();
    s.startGoal(root, "t", "s1");
    s.snapshotInitialDirt(root, 100);
    s.pauseGoal(root);
    s.startGoal(root, "other", "s2");
    s.pauseGoal(root);
    const goals = s.readGoals(root);
    const first = goals.goals.find((g) => g.title === "t")!;
    goals.active = first.id;
    first.status = "active";
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(
      join(root, ".graphhopper", "goals.json"),
      JSON.stringify(goals),
    );
    s.resumeGoal(root, "s1");
    expect(s.getActive(root)!.state.initial_diff_lines).toBe(100);
  });
});

describe("goal_summary telemetry", () => {
  test("集計規則: last-write・entry_routeのみfirst・rewinds・2round", () => {
    const root = tmpRoot();
    const gid = "g-test";
    recordEvent(root, { type: "goal_start", goal: gid, title: "t" });
    recordEvent(root, { type: "entry_route", goal: gid, route: "light", reason: "x" });
    recordEvent(root, { type: "router_check", goal: gid, diff_lines: 100, route: "advisor" });
    recordEvent(root, { type: "router_check", goal: gid, diff_lines: 500, route: "polish" });
    recordEvent(root, {
      type: "verifier_verdict", goal: gid, level: "drift", target: "implementing", lens: ["requirement"],
    });
    recordEvent(root, {
      type: "verifier_verdict", goal: gid, level: "clean", target: null,
      lens: ["requirement", "behavior", "progress"],
    });
    recordEvent(root, { type: "phase", goal: gid, from: "polish", to: "implementing" });
    recordEvent(root, { type: "phase", goal: gid, from: "polish", to: "implementing" });
    recordEvent(root, { type: "escalated", goal: gid, from: "light", at: "now" });
    recordEvent(root, { type: "critic_review_set", goal: gid, level: "clean" });
    recordEvent(root, { type: "attempt", goal: gid, ok: false, fail_streak: 2, note: "x" });
    recordEvent(root, { type: "eval_run", goal: gid, ok: true, fail_streak: 3 });
    const s = buildGoalSummary(root, gid, {
      score: 80,
      now: new Date(Date.parse(new Date().toISOString()) + 61000).toISOString(),
    });
    expect(s.entry_route).toBe("light");
    expect(s.router_route).toBe("polish");
    expect(s.diff_lines).toBe(500);
    expect(s.lenses).toEqual(["requirement", "behavior", "progress"]);
    expect(s.verdict_level).toBe("clean");
    expect(s.rewinds).toBe(2);
    expect(s.verifier_rounds).toBe(2);
    expect(s.max_fail_streak).toBe(3);
    expect(s.escalated).toBe(true);
    expect(s.critic_level).toBe("clean");
    expect(s.score).toBe(80);
    expect(s.duration_s).toBeGreaterThanOrEqual(0);
  });

  test("欠測はnull（entry_route未記録はfull）・goal_start無しはduration null", () => {
    const root = tmpRoot();
    const gid = "g-missing";
    recordEvent(root, { type: "goal_complete", goal: gid, score: 100 });
    const s = buildGoalSummary(root, gid, { score: 100 });
    expect(s.entry_route).toBe("full");
    expect(s.router_route).toBeNull();
    expect(s.verdict_level).toBeNull();
    expect(s.lenses).toEqual([]);
    expect(s.duration_s).toBeNull();
    expect(s.title).toBe("(unknown)");
    expect(s.escalated).toBe(false);
  });

  test("2行1append＋buildTelemetryのbackfill再合成", () => {
    const root = tmpRoot();
    const gid = "g-batch";
    recordEvent(root, { type: "goal_start", goal: gid, title: "t" });
    recordEventBatch(root, [
      { type: "goal_complete", goal: gid, score: 90 },
      buildGoalSummary(root, gid, { score: 90 }),
    ]);
    // history末尾2行がgoal_complete＋goal_summary
    const lines = readFileSync(join(root, ".graphhopper", "history.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(JSON.parse(lines[lines.length - 2]!).type).toBe("goal_complete");
    expect(JSON.parse(lines[lines.length - 1]!).type).toBe("goal_summary");
    expect(buildTelemetry(root).map((t) => t.goal)).toEqual([gid]);
    // summary欠落の既存completeは再合成される
    const root2 = tmpRoot();
    recordEvent(root2, { type: "goal_start", goal: "g-old", title: "old" });
    recordEvent(root2, { type: "goal_complete", goal: "g-old", score: 70 });
    const tele = buildTelemetry(root2);
    expect(tele.length).toBe(1);
    expect(tele[0]!.goal).toBe("g-old");
    expect(tele[0]!.score).toBe(70);
    expect(tele[0]!.title).toBe("old");
  });

  test("backfillのdurationはgoal_completeのts基準（クエリ時刻に依存しない）", () => {
    const root = tmpRoot();
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-01-01T01:00:00.000Z"; // +3600s
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      join(root, ".graphhopper", "history.jsonl"),
      [
        JSON.stringify({ ts: t0, type: "goal_start", goal: "g-fixed", title: "f" }),
        JSON.stringify({ ts: t1, type: "goal_complete", goal: "g-fixed", score: 50 }),
      ].join("\n") + "\n",
    );
    const tele = buildTelemetry(root);
    expect(tele.length).toBe(1);
    // 修正前はクエリ時刻now基準で巨大値になった
    expect(tele[0]!.duration_s).toBe(3600);
  });

  test("旧A/B/C行はread時正規化（disk不変）", () => {
    const root = tmpRoot();
    mkdirSync(join(root, ".graphhopper"), { recursive: true });
    writeFileSync(
      join(root, ".graphhopper", "history.jsonl"),
      [
        JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", type: "goal_start", goal: "g-leg", title: "l" }),
        JSON.stringify({ ts: "2026-01-01T00:01:00.000Z", type: "entry_route", goal: "g-leg", route: "B" }),
        JSON.stringify({ ts: "2026-01-01T00:02:00.000Z", type: "goal_complete", goal: "g-leg", score: 60 }),
      ].join("\n") + "\n",
    );
    const tele = buildTelemetry(root);
    expect(tele.length).toBe(1);
    expect(tele[0]!.entry_route).toBe("light");
    expect(tele[0]!.duration_s).toBe(120);
  });
});
