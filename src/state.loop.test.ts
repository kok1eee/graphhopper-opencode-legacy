/**
 * ループ検知（echo + 同一tool call反復）・累積loop停止カウンタの単体テスト。
 * bun test で実行する: `bun test src/state.loop.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GraphhopperConfig,
  type SessionMessageLike,
  CONTINUATION_MARKER,
  canonicalJSON,
  clearActiveGoal,
  continuationFingerprint,
  detectLoopKind,
  isDesignDocLocked,
  isDesignGateBlocked,
  isEchoMessage,
  isHumanTextPart,
  isResumeBlocked,
  isToolRepeatLoop,
  isValidBaselineRev,
  fnv1a,
  lastHumanId,
  measureDiffLines,
  noteContinuation,
  noteEvalFingerprint,
  parseDiffShortstat,
  pauseGoal,
  readGoals,
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
