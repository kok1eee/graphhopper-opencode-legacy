/**
 * gate — design gate・hash検証editの純粋関数＋本体。
 *
 * src/index.ts（plugin entry）から分離したモジュール。
 * 背景: opencodeのplugin loaderはentry moduleの全export値を走査し、
 * 関数でない値（{server}オブジェクトでもない値）があると
 * "Plugin export is not a function" でplugin全体のloadに失敗する。
 * よってentryはplugin関数（Graphhopper）のみをexportし、
 * テスト対象のhelperはここに置く。hashedit.test.tsはここからimportする。
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { applySingleEdit, decodeUtf8Strict, sha1Hex, verifyHash } from "./hashedit";
import * as state from "./state";

/* フェーズごとの次のアクション指示文（plugin tool応答・MCP応答の単一源泉）。
 * plugin entry（index.ts）には置けない（loaderが非関数exportでload失敗するため）。
 * 内容を変えたらplugin/MCP両方の応答に反映される。 */
export const PHASE_ACTION: Record<state.Phase, string> = {
  designing:
    "goalを理解し、設計判断・実装タスク列を .graphhopper/plans/<goal-id>.md に書く。source編集はここではブロックされる。書けたら task(subagent_type: 'graphhopper-critic') で設計を1回敵対レビューし、指摘を design.md に反映してから graphhopper_phase(phase: 'implementing') へ（任意で graphhopper_critic_set に結果を記録できる。opt-inでphase遷移の前提条件ではない）。design.md はこのフェーズを抜けた後は不変になる（verifierのdrift検出アンカーのため）——決定の経緯・棄却した代替案・進捗はここで固めず、実装中は .graphhopper/plans/<goal-id>.log.md に追記すること",
  implementing:
    "design.md のタスクを実装する。goal中のsource編集は graphhopper_edit（hash検証付き）を使え、素のedit/writeはフォールバック。まず graphhopper_set_eval(cmd) で合否を機械判定できるコマンド（テスト/lint/typecheck）を1度設定せよ。設定後はターン終了ごとに自動実行され、passならpolishへ自動遷移、failならfail_streakが機械カウントされ、escalateが返ったら task(subagent_type: 'graphhopper-oracle') に相談する。eval_cmdが無い（機械判定できない）場合のみ graphhopper_attempt(ok, note) の自己申告にフォールバックする。外部公式doc裏付けが必要なら task(subagent_type: 'graphhopper-librarian') を使える",
  polish:
    "graphhopper_router_check の route に従う。route=polish（大diff）ならまず simplify を実行する: メインが router.baseline_rev から diff を /tmp/gh-simplify-diff.txt に退避し、task(subagent_type: 'graphhopper-simplify') を1回呼んで提案を集める（3レンズ統合）。適用はメインが行う: 各 finding を Read で裏付け、critical は挙動不変・局所的なものだけ自動適用、high は人間確認、medium/note は報告のみ。適用後は eval_cmd を再実行して機械確認。route=advisor（小diff）なら simplify はスキップ。その後 verifier: route=polish なら requirement/behavior/progress の3charterで、route=advisor なら general charter で task(subagent_type: 'graphhopper-verifier') を呼び、verifierは変更ファイルに型・lint診断を実行して裏付けに使え（診断クリーン≠driftなし）。結果を graphhopper_verifier_set で記録。集約 clean で graphhopper_phase(phase: 'done') へ。集約 drift かつ target=implementing なら implementing に戻る。advisor でも第三者チェック（verifier）は省略不可",
  done: "完了済み。graphhopper_goal(action: 'complete') を確認",
};

/* continuation（session.idle → promptAsync）のuser向け表示用の1行要約。
 * LLM向けの詳細指示は PHASE_ACTION のまま chat.system.transform 側で注入する
 * （design g-mtwhdb4t）。done は continuation 自体が発火しない（idle ハンドラが
 * phase==="done" で早期return）ため実質未使用だが、Record の型完全性のために残す。 */
export const PHASE_ACTION_SHORT: Record<state.Phase, string> = {
  designing: "設計ドキュメントを書き、criticレビュー後にimplementingへ",
  implementing: "design.mdのタスクを実装し、eval_cmdを設定",
  polish: "router_checkのrouteに従いsimplify/verifierを実行",
  done: "goalをcompleteする",
};

/* design gate・信号A計数の対象tool（D2a/D2b）。before/after両hookで共有する
 * 単一の真実源。3名のいずれかが漏れると新tool経由でgate/stuck検知が
 * バイパスされるため、hashedit.test.tsで機械検証する。 */
export const GATE_TARGET_TOOLS = ["write", "edit", "graphhopper_edit"] as const;

export function isGateTargetTool(toolName: string | undefined): boolean {
  return (
    typeof toolName === "string" &&
    (GATE_TARGET_TOOLS as readonly string[]).includes(toolName.toLowerCase())
  );
}

/* graphhopper_edit executeの事前判定（D2c＋goal外仕様）。純粋関数として
 * 分離し機械検証する。拒否はthrow（after計数に混入しない。万一afterが
 * throw時にも発火する実装でもstreak加算はfail-closed側＝早期escalateに倒れる）。 */
export type HashEditAccess = "ok" | "no-goal" | "subagent";

export function checkHashEditAccess(
  sessionID: string | undefined,
  mainSessionID: string | null | undefined,
  hasActiveGoal: boolean,
): HashEditAccess {
  if (!hasActiveGoal) return "no-goal";
  // 未バインド（session削除後等）はgoal外扱い。design D2の
  // 「active goalなし、または state.session_id がnull」条項。
  if (!mainSessionID) return "no-goal";
  if (!sessionID || sessionID !== mainSessionID) return "subagent";
  return "ok";
}

/* graphhopper_hash の本体（exportして機械検証する）。
 * hash基準は graphhopper_edit と揃えてutf8デコード文字列とする
 * （生バイトだと非UTF-8でペア不整合になる。F3対応）。 */
export function readGraphhopperHash(root: string, filePath: string): string {
  const p = isAbsolute(filePath) ? filePath : join(root, filePath);
  const content = decodeUtf8Strict(readFileSync(p));
  const st = statSync(p);
  return JSON.stringify({
    path: filePath,
    sha1: sha1Hex(content),
    size: Buffer.byteLength(content, "utf8"),
    mtime: st.mtime.toISOString(),
  });
}

export interface HashEditArgs {
  filePath: string;
  expectedHash: string;
  oldString: string;
  newString: string;
}

/* graphhopper_edit の本体（exportして機械検証する）。
 * tool.execute の薄いラッパーにし、分岐→アクション対応
 * （no-goal→軟質return / subagent→throw / 拒否→記録+throw /
 * 成功→記録+新hash返却）をテストで固定する。 */
export function runGraphhopperEdit(
  root: string,
  sessionID: string | undefined,
  args: HashEditArgs,
): string {
  const active = state.getActive(root);
  const access = checkHashEditAccess(
    sessionID,
    active?.state.session_id,
    !!active && active.goal.status === "active",
  );
  if (access === "no-goal") {
    return "error: no active goal (use plain edit as fallback, no event recorded)";
  }
  if (access === "subagent") {
    throw new Error(
      "Refused: graphhopper_edit from subagent session is blocked (read-only invariant)",
    );
  }
  if (!active) return "error: no active goal (unexpected)";
  const p = isAbsolute(args.filePath)
    ? args.filePath
    : join(root, args.filePath);
  let content: string;
  try {
    content = decodeUtf8Strict(readFileSync(p));
  } catch (e) {
    state.recordEvent(root, {
      type: "hash_edit_refused",
      goal: active.goal.id,
      path: args.filePath,
      reason: e instanceof Error ? e.message : String(e),
    });
    throw new Error(
      `hash_edit_refused: cannot read ${args.filePath} (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  try {
    verifyHash(content, args.expectedHash);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    state.recordEvent(root, {
      type: "hash_edit_refused",
      goal: active.goal.id,
      path: args.filePath,
      reason,
    });
    throw e instanceof Error ? e : new Error(reason);
  }
  let next: string;
  try {
    next = applySingleEdit(content, args.oldString, args.newString);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    state.recordEvent(root, {
      type: "hash_edit_refused",
      goal: active.goal.id,
      path: args.filePath,
      reason,
    });
    throw e instanceof Error ? e : new Error(reason);
  }
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, next, "utf8");
  renameSync(tmp, p);
  state.recordEvent(root, {
    type: "hash_edit_applied",
    goal: active.goal.id,
    path: args.filePath,
  });
  return JSON.stringify({
    path: args.filePath,
    sha1: sha1Hex(next),
    size: Buffer.byteLength(next, "utf8"),
  });
}

/* 拒否文の単一源泉（plugin hook の throw 文と MCP の error 返却で共有）。
 * 文面を変えると両方の応答に反映される。 */
export function designGateRefusal(
  toolName: string | undefined,
  filePath: string,
  allow: string[],
): string {
  return (
    `Refused: ${toolName} to ${filePath} is blocked because the goal is in the "designing" phase. ` +
    `Only paths under ${allow.join(", ")} may be written while designing. ` +
    `Write the design doc first, then graphhopper_phase(phase: "implementing") before editing source.`
  );
}

export function designDocLockedRefusal(
  toolName: string | undefined,
  filePath: string,
  goalId: string,
): string {
  return (
    `Refused: ${toolName} to ${filePath} is blocked because the design doc is immutable once the "designing" phase ends ` +
    `(it anchors verifier drift detection — rewriting it to match the implementation would let drift be erased by editing the doc instead of fixing the code). ` +
    `Record decisions/rejected alternatives/progress in .graphhopper/plans/${goalId}.log.md instead (no gate on that path).`
  );
}
