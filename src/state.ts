/**
 * graphhopper state 管理
 *
 * `.graphhopper/` 配下の JSON/JSONL ファイルを読み書きする。
 * - goals.json    : 目標キューと active 指定
 * - state.json    : 現在のループ状態（フェーズ・セッション紐付け・verifier サブステート）
 * - config.json   : プロジェクト毎の上書き設定（任意）
 * - history.jsonl : 監査ログ（append-only）
 * - plans/<goal-id>.md : design ドキュメント（designing フェーズで書く唯一の許可パス）
 *
 * 外部依存なし（node stdlib のみ）。全ての書き込みは tmp+rename で原子的に行う。
 * flywheel-opencode (src/state.ts) の atomic write パターンを踏襲。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** graphhopper 本体（Claude Code版）の3相グラフに合わせる。flywheelの8フェーズより薄い */
export const PHASES = ["designing", "implementing", "polish", "done"] as const;
export type Phase = (typeof PHASES)[number];

export type GoalStatus = "active" | "paused" | "done";

export interface Goal {
  id: string;
  title: string;
  status: GoalStatus;
  created_at: string;
  done_at: string | null;
}

export type VerdictLevel = "clean" | "drift";
/** drift 巻き戻し先。implementing 以外は人間の hand-back 待ち（flywheelのmonitor相当） */
export type DriftTarget = "implementing" | "design" | "requirements";
/** general: route=advisor の単発呼び出し（3レンズを1つにまとめた統合charter） */
export type VerifierLens = "requirement" | "behavior" | "progress" | "general";

export interface VerifierVerdict {
  level: VerdictLevel;
  reason: string;
  target: DriftTarget | null;
  lens: VerifierLens[];
  at: string;
}

/** designing終了前のdesign.md質レビュー（graphhopper-critic、opt-in・ハードゲート無し）の記録。
 * phase遷移の前提条件にはしない——design時点では客観的な閾値が無く、ゲート化すると
 * 「薄く書いてゲートを避ける」自己判断エロージョンを再生産するだけのため。 */
export interface CriticVerdict {
  level: VerdictLevel;
  reason: string;
  at: string;
}

export type RouterRoute = "advisor" | "polish";

export interface RouterState {
  baseline_rev: string | null;
  diff_lines: number | null;
  route: RouterRoute | null;
  checked_at: string | null;
}

export interface LoopState {
  goal_id: string | null;
  /** ループ継続注入の対象セッション。null は未バインド */
  session_id: string | null;
  phase: Phase;
  /** 中断・再開用のメモ（「どこまでやったか」） */
  notes: string;
  /** router gate（loop-driver.sh 相当）が直近に測った diff サイズと分岐先 */
  router: RouterState;
  /** polish フェーズの verifier fan-out 結果。null = 未実行 */
  last_verifier: VerifierVerdict | null;
  /** designing終了前のcritic review結果。null = 未実行（opt-in、setPhaseの前提条件にはしない） */
  critic_review: CriticVerdict | null;
  /** handoffの一度きり通知（会話サイズ閾値超）を出したか。goalにつき1回だけ通知するためのdedup */
  handoff_nudged: boolean;
  /**
   * implementing での連続失敗数（graphhopper_attempt が機械カウント）。
   * stuck_threshold に達したら graphhopper-oracle への相談を促す。
   * ok な attempt か phase 遷移でリセットされる。
   */
  fail_streak: number;
  /**
   * implementing の合否を機械判定するコマンド（graphhopper本体のeval_cmd相当）。
   * 設定されていれば session.idle 発火時に毎回実行し、exit codeで自動的に
   * pass（polishへ遷移）/fail（fail_streakを機械カウント）を判定する。
   * 未設定なら graphhopper_attempt の自己申告にフォールバックする。
   */
  eval_cmd: string | null;
  /**
   * 直近に注入した継続リマインダー時点の進展フィンガープリント
   * （continuationFingerprint の戻り値）。次回 idle 時に同一なら
   * 「前回注入以降に進展なし」とみなして注入をスキップし、待機ackの
   * 言い換え繰り返しによる空転ループを1往復で止める。
   */
  last_continuation_marker: string | null;
  /**
   * 直近の eval_cmd 実行結果のフィンガープリント（ok + 出力tailのハッシュ）。
   * 同一失敗の再注入を抑止しつつ、結果が変わったら注入を再開するための材料。
   */
  last_eval_fingerprint: string | null;
  /**
   * 無限ループ検知（echoループ）の連続カウント。session.idle 発火ごとに
   * 「直前のassistantメッセージとほぼ同一のuserメッセージ」を検知して増える。
   * ループでない（人間の新規入力）と判定されたら0に戻る。
   */
  loop_streak: number;
  /** 無限ループを検知して自動継続注入を停止した「現在の一時状態」か。永続フラグではなく
   * pauseGoal / resumeGoal / completeGoal / 明示 pause / clear で false に戻る。
   * resume の恒久ブロックは loop_stop_count >= loop_stop_max の判定で行う。 */
  loop_stopped: boolean;
  /** ループ検知による自動停止の累積回数（goalごと）。loop_stop_max に達すると resume を
   * 拒否して人間に判断を委ねる。明示 pause はカウントしない。clear で0に戻る。 */
  loop_stop_count: number;
  updated_at: string;
}

export interface GoalsFile {
  goals: Goal[];
  active: string | null;
}

export interface GraphhopperConfig {
  /** router gate の分岐閾値（diff行数）。超えたら polish、以下なら advisor 相当の自己レビューで足りる */
  router_threshold_lines: number;
  /** designing フェーズで編集を許可する path（glob不可、prefix一致）。デフォルトは plans/ 配下のみ */
  design_gate_allow: string[];
  /** subagent 名で model を上書きする（例: { "graphhopper-verifier": "amazon-bedrock/anthropic.claude-opus-5" }） */
  agents: { [name: string]: string };
  /** implementing の連続失敗数がこれに達したら graphhopper-oracle への相談を促す */
  stuck_threshold: number;
  /** handoff一度きり通知の閾値（session.messagesのJSON文字数、transcriptサイズの代理指標）。
   * Claude Code版の GH_HANDOFF_THRESHOLD_KB（既定500KB）相当。opencodeにはtranscript_pathが
   * 無いため client.session.messages() のJSONシリアライズ長で近似する */
  handoff_nudge_chars: number;
  /** echoループ（直前のassistantメッセージとほぼ同一のuserメッセージ）を
   * 何回連続で検知したら自動継続注入を止めるか。0以下なら echo 検知を無効化
   * （tool検知は loop_tool_repeat_threshold で独立に制御される） */
  loop_stop_threshold: number;
  /** ループ検知による自動停止が累積 loop_stop_max 回に達したら resume を拒否する
   * （人間が force:true で明示解除するか clear するまで）。0以下なら resume ブロック無効 */
  loop_stop_max: number;
  /** 同一tool call反復検知のウィンドウ幅（対象は最後の人間user入力以降の tool call のうち
   * 直近この件数）。0以下なら無効 */
  loop_tool_window: number;
  /** 直近 loop_tool_window 件の tool call 内で同一 (tool名+入力ハッシュ) がこの回数
   * 出たらループと判定する。1以下なら tool 検知を無効化 */
  loop_tool_repeat_threshold: number;
}

export const DEFAULT_CONFIG: GraphhopperConfig = {
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

function dir(root: string): string {
  return join(root, ".graphhopper");
}

function goalsPath(root: string): string {
  return join(dir(root), "goals.json");
}

function statePath(root: string): string {
  return join(dir(root), "state.json");
}

function configPath(root: string): string {
  return join(dir(root), "config.json");
}

function historyPath(root: string): string {
  return join(dir(root), "history.jsonl");
}

export function planPath(root: string, goalId: string): string {
  return join(dir(root), "plans", `${goalId}.md`);
}

/** 決定の経緯・棄却した代替案・進捗を追記するログ（design docとは別物、追記専用・ハードゲート無し）。
 * design_gate_allow の prefix (`.graphhopper/plans/`) に含まれるため、designing中も常時書き込み可能。 */
export function planLogPath(root: string, goalId: string): string {
  return join(dir(root), "plans", `${goalId}.log.md`);
}

export function planLogExists(root: string, goalId: string): boolean {
  return existsSync(planLogPath(root, goalId));
}

export type HistoryEvent =
  | { type: "goal_start"; goal: string; title: string }
  | { type: "goal_pause"; goal: string }
  | { type: "goal_resume"; goal: string }
  | { type: "goal_complete"; goal: string }
  | { type: "phase"; goal: string; from: Phase; to: Phase; notes?: string }
  | {
      type: "router_check";
      goal: string;
      diff_lines: number;
      route: RouterRoute;
    }
  | {
      type: "verifier_verdict";
      goal: string;
      level: VerdictLevel;
      target: DriftTarget | null;
      lens: VerifierLens[];
    }
  | { type: "design_gate_block"; goal: string; tool: string; path: string }
  | {
      type: "design_doc_locked_block";
      goal: string;
      tool: string;
      path: string;
    }
  | {
      type: "critic_review_set";
      goal: string;
      level: VerdictLevel;
    }
  | {
      type: "attempt";
      goal: string;
      ok: boolean;
      fail_streak: number;
      note: string;
    }
  | { type: "eval_set"; goal: string; cmd: string }
  | { type: "eval_run"; goal: string; ok: boolean; fail_streak: number }
  | {
      type: "loop_detected";
      goal: string;
      kind: LoopKind;
      streak: number;
      stopped: boolean;
    }
  | { type: "loop_stopped"; goal: string; count: number }
  | { type: "loop_resume_forced"; goal: string }
  | { type: "handoff_nudged"; goal: string; size_chars: number }
  | { type: "continuation_skipped"; goal: string; marker: string };

/** append-only の履歴ログ。LLMの自己申告ではなくplugin機械記録の監査証跡 */
export function recordEvent(root: string, event: HistoryEvent): void {
  try {
    mkdirSync(dir(root), { recursive: true });
    const line =
      JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
    appendFileSync(historyPath(root), line, "utf8");
  } catch {
    // 履歴書き込み失敗でループを止めない
  }
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function atomicWrite(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function readConfig(root: string): GraphhopperConfig {
  const raw = readJson<Partial<GraphhopperConfig>>(configPath(root), {});
  return {
    router_threshold_lines:
      raw.router_threshold_lines ?? DEFAULT_CONFIG.router_threshold_lines,
    design_gate_allow:
      raw.design_gate_allow ?? DEFAULT_CONFIG.design_gate_allow,
    agents: { ...(DEFAULT_CONFIG.agents ?? {}), ...(raw.agents ?? {}) },
    stuck_threshold: raw.stuck_threshold ?? DEFAULT_CONFIG.stuck_threshold,
    handoff_nudge_chars:
      raw.handoff_nudge_chars ?? DEFAULT_CONFIG.handoff_nudge_chars,
    loop_stop_threshold:
      raw.loop_stop_threshold ?? DEFAULT_CONFIG.loop_stop_threshold,
    loop_stop_max: raw.loop_stop_max ?? DEFAULT_CONFIG.loop_stop_max,
    loop_tool_window:
      raw.loop_tool_window ?? DEFAULT_CONFIG.loop_tool_window,
    loop_tool_repeat_threshold:
      raw.loop_tool_repeat_threshold ??
      DEFAULT_CONFIG.loop_tool_repeat_threshold,
  };
}

export function readGoals(root: string): GoalsFile {
  return readJson<GoalsFile>(goalsPath(root), { goals: [], active: null });
}

function emptyState(): LoopState {
  return {
    goal_id: null,
    session_id: null,
    phase: "designing",
    notes: "",
    router: {
      baseline_rev: null,
      diff_lines: null,
      route: null,
      checked_at: null,
    },
    last_verifier: null,
    critic_review: null,
    handoff_nudged: false,
    fail_streak: 0,
    eval_cmd: null,
    last_continuation_marker: null,
    last_eval_fingerprint: null,
    loop_streak: 0,
    loop_stopped: false,
    loop_stop_count: 0,
    updated_at: new Date().toISOString(),
  };
}

export function readState(root: string): LoopState {
  const loaded = readJson<Partial<LoopState>>(statePath(root), emptyState());
  return {
    ...emptyState(),
    ...loaded,
    router: { ...emptyState().router, ...(loaded.router ?? {}) },
  };
}

function writeGoals(root: string, data: GoalsFile): void {
  atomicWrite(goalsPath(root), data);
}

function writeState(root: string, state: LoopState): void {
  state.updated_at = new Date().toISOString();
  atomicWrite(statePath(root), state);
}

export interface ActiveLoop {
  goal: Goal;
  state: LoopState;
}

/** active な goal と state の組を返す。無ければ null */
export function getActive(root: string): ActiveLoop | null {
  const goals = readGoals(root);
  if (!goals.active) return null;
  const goal = goals.goals.find((g) => g.id === goals.active);
  if (!goal) return null;
  return { goal, state: readState(root) };
}

export function startGoal(
  root: string,
  title: string,
  sessionID: string,
): ActiveLoop {
  const goals = readGoals(root);
  const goal: Goal = {
    id: `g-${Date.now().toString(36)}`,
    title,
    status: "active",
    created_at: new Date().toISOString(),
    done_at: null,
  };
  for (const g of goals.goals) {
    if (g.status === "active") g.status = "paused";
  }
  goals.goals.push(goal);
  goals.active = goal.id;
  writeGoals(root, goals);

  const next: LoopState = {
    ...emptyState(),
    goal_id: goal.id,
    session_id: sessionID,
  };
  writeState(root, next);
  recordEvent(root, { type: "goal_start", goal: goal.id, title: goal.title });
  return { goal, state: next };
}

function mutateActive(
  root: string,
  fn: (
    goal: Goal,
    state: LoopState,
  ) => Partial<{ goal: Partial<Goal>; state: Partial<LoopState> }>,
): ActiveLoop | null {
  const goals = readGoals(root);
  if (!goals.active) return null;
  const goal = goals.goals.find((g) => g.id === goals.active);
  if (!goal) return null;
  const state = readState(root);
  const patch = fn(goal, state);
  if (patch.goal) Object.assign(goal, patch.goal);
  if (patch.state) Object.assign(state, patch.state);
  writeGoals(root, goals);
  writeState(root, state);
  return { goal, state };
}

export function pauseGoal(root: string): ActiveLoop | null {
  const r = mutateActive(root, () => ({
    goal: { status: "paused" },
    // 人間による明示的な操作なのでloop停止フラグも解除（pause自体が駆動を止める）
    state: { loop_streak: 0, loop_stopped: false },
  }));
  if (r) recordEvent(root, { type: "goal_pause", goal: r.goal.id });
  return r;
}

export function resumeGoal(
  root: string,
  sessionID: string,
  force = false,
): ActiveLoop | null {
  // 恒久ブロック: loop_stop_max に達したら通常resumeを拒否（forceで明示解除のみ）
  if (isResumeBlocked(root) && !force) return null;
  const r = mutateActive(root, () => ({
    goal: { status: "active" },
    state: { session_id: sessionID, loop_streak: 0, loop_stopped: false },
  }));
  if (r) {
    recordEvent(root, { type: "goal_resume", goal: r.goal.id });
    if (force) {
      // 人間の判断を監査証跡に残す（カウンタは保持するため履歴は残る）
      recordEvent(root, { type: "loop_resume_forced", goal: r.goal.id });
    }
  }
  return r;
}

export function completeGoal(root: string): ActiveLoop | null {
  const r = mutateActive(root, () => ({
    goal: { status: "done", done_at: new Date().toISOString() },
    state: {
      phase: "done",
      loop_streak: 0,
      loop_stopped: false,
    },
  }));
  if (r) recordEvent(root, { type: "goal_complete", goal: r.goal.id });
  return r;
}

/** clear 専用の loop 全リセット（completeGoal はカウンタを保持するので分離） */
export function resetLoopForClear(root: string): void {
  const state = readState(root);
  writeState(root, {
    ...state,
    loop_streak: 0,
    loop_stopped: false,
    loop_stop_count: 0,
  });
}

export function setPhase(
  root: string,
  phase: Phase,
  notes?: string,
): ActiveLoop | null {
  if (!PHASES.includes(phase)) return null;
  const before = getActive(root);
  const r = mutateActive(root, () => ({
    // phaseが変わるたびfail_streakをリセット（implementingに戻ってきた時も0から数え直す）
    state: { phase, fail_streak: 0, ...(notes !== undefined ? { notes } : {}) },
  }));
  if (r && before && before.state.phase !== phase) {
    recordEvent(root, {
      type: "phase",
      goal: r.goal.id,
      from: before.state.phase,
      to: phase,
      ...(notes ? { notes } : {}),
    });
  }
  return r;
}

export function unbindSession(root: string, sessionID: string): void {
  const state = readState(root);
  if (state.session_id !== sessionID) return;
  writeState(root, { ...state, session_id: null });
}

/* ================================================================== *
 * router gate（loop-driver.sh 相当）: diff サイズを機械測定して分岐
 * ================================================================== */
import type { PluginInput } from "@opencode-ai/plugin";
type Shell = PluginInput["$"];

/** baseline_rev を VCS から取得（jj → git → null） */
export async function captureBaselineRev(
  shell: Shell,
  root: string,
): Promise<string | null> {
  try {
    const r =
      await shell`sh -c ${"jj log -r 'heads() & ~empty()' -T commit_id --no-graph --limit 1"}`
        .cwd(root)
        .nothrow()
        .quiet();
    const out = r.stdout.toString().trim();
    if (r.exitCode === 0 && out) return out.split("\n")[0] ?? null;
  } catch {
    // ignore
  }
  try {
    const r = await shell`sh -c ${"git rev-parse HEAD"}`
      .cwd(root)
      .nothrow()
      .quiet();
    const out = r.stdout.toString().trim();
    if (r.exitCode === 0 && out) return out;
  } catch {
    // ignore
  }
  return null;
}

/** baseline からの diff 行数を測定する（jj → git fallback） */
export async function measureDiffLines(
  shell: Shell,
  root: string,
  baseline: string | null,
): Promise<number> {
  if (!baseline) return 0;
  try {
    const r =
      await shell`sh -c ${`jj diff --from ${baseline} --stat 2>/dev/null | tail -1`}`
        .cwd(root)
        .nothrow()
        .quiet();
    const out = r.stdout.toString().trim();
    const m = out.match(/(\d+) insertions?.*?(\d+) deletions?/);
    if (m) return Number(m[1]) + Number(m[2]);
  } catch {
    // ignore
  }
  try {
    const r = await shell`sh -c ${`git diff --shortstat ${baseline}`}`
      .cwd(root)
      .nothrow()
      .quiet();
    const out = r.stdout.toString().trim();
    const ins = out.match(/(\d+) insertion/);
    const del = out.match(/(\d+) deletion/);
    return (ins ? Number(ins[1]) : 0) + (del ? Number(del[1]) : 0);
  } catch {
    return 0;
  }
}

export function recordRouterCheck(
  root: string,
  baseline: string | null,
  diffLines: number,
  route: RouterRoute,
): LoopState {
  const state = readState(root);
  const next: LoopState = {
    ...state,
    router: {
      baseline_rev: baseline,
      diff_lines: diffLines,
      route,
      checked_at: new Date().toISOString(),
    },
  };
  writeState(root, next);
  if (state.goal_id)
    recordEvent(root, {
      type: "router_check",
      goal: state.goal_id,
      diff_lines: diffLines,
      route,
    });
  return next;
}

export function setVerifierVerdict(
  root: string,
  verdict: Omit<VerifierVerdict, "at">,
): LoopState {
  const state = readState(root);
  const next: LoopState = {
    ...state,
    last_verifier: { ...verdict, at: new Date().toISOString() },
  };
  writeState(root, next);
  if (state.goal_id) {
    recordEvent(root, {
      type: "verifier_verdict",
      goal: state.goal_id,
      level: verdict.level,
      target: verdict.target,
      lens: verdict.lens,
    });
  }
  return next;
}

/** design.md質レビュー（graphhopper-critic）の結果を記録する。opt-inでありphase遷移の
 * 前提条件にはしない（verifier_setのlens空拒否のようなself-graded防止機構は付けない）。 */
export function setCriticVerdict(
  root: string,
  verdict: Omit<CriticVerdict, "at">,
): LoopState {
  const state = readState(root);
  const next: LoopState = {
    ...state,
    critic_review: { ...verdict, at: new Date().toISOString() },
  };
  writeState(root, next);
  if (state.goal_id) {
    recordEvent(root, {
      type: "critic_review_set",
      goal: state.goal_id,
      level: verdict.level,
    });
  }
  return next;
}

/** handoffの一度きり通知を送ったことを記録する（goalにつき1回だけ通知するためのdedup）。
 * 会話が大きいこと自体はeval失敗やverdict未記録のような「直すべき異常」ではないため、
 * 一度知らせたら二度と鳴らさない（graphhopper本体 hooks/loop-driver.sh のdedupと同じ思想）。 */
export function setHandoffNudged(root: string, sizeChars: number): LoopState {
  const state = readState(root);
  const next: LoopState = { ...state, handoff_nudged: true };
  writeState(root, next);
  if (state.goal_id) {
    recordEvent(root, {
      type: "handoff_nudged",
      goal: state.goal_id,
      size_chars: sizeChars,
    });
  }
  return next;
}

/* ================================================================== *
 * 無限ループ検知（echoループ + 同一tool call反復）: assistant出力がそのまま次の
 * user入力にミラーされ続けると、session.idle が連続発火して自動継続が延々回る。
 * 検知は2種:
 * - echo: 直前のassistantメッセージとほぼ同一のuserメッセージ（3パターン）
 * - tool: 直近ウィンドウ内で同一 (tool名+入力ハッシュ) の反復
 * どちらかが loop_stop_threshold（echo無効時は loop_tool_repeat_threshold）回
 * 連続したら自動継続を止める（goalをpause）。
 * ================================================================== */

/** 検知の種別。イベント記録・通知文に使う */
export type LoopKind = "echo" | "tool" | "echo+tool";

/** session.messages() の最小構造（SDK型に依存しない軽量型） */
export interface SessionMessageLike {
  info: { id: string; role: "user" | "assistant" };
  parts: Array<{
    type: string;
    text?: string;
    synthetic?: boolean;
    callID?: string;
    tool?: string;
    state?: { status?: string; input?: unknown };
  }>;
}

function normalizeMessage(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/\s+/g, "") // 空白・改行を除去
      .replace(/[。、！!？?・…〜〜：:，,（）()「」『』'"'`~]/g, "") // 句読点を除去
      // 絵文字・記号・ASCII装飾を除去（echo判定のノイズ）
      .replace(/[^\u3040-\u30ff\u4e00-\u9fff\u0020-\u007e\u30fc]/g, "")
      .trim()
  );
}

/** echoループ検知。3パターンを扱う:
 * 1. 末尾=user・直前=assistant がほぼ同一（外部ミラーが出力を user にコピーするケース）
 * 2. 末尾=assistant・直前=user で、その user が「その前の assistant（[-3]）」の echo
 *    （自動継続ループで idle 時点の末尾が必ず assistant になるケースの本体）
 * 3. 連続する assistant メッセージ（[-3] と [-1]）がほぼ同一（強制継続で同文を繰り返す）
 * どれも正規化テキストの同一 or 十分な重複を echo とみなす。 */
export function isEchoMessage(msgs: SessionMessageLike[]): boolean {
  if (msgs.length < 2) return false;
  const last = msgs[msgs.length - 1];
  const prev = msgs[msgs.length - 2];

  const text = (m: SessionMessageLike): string =>
    (m.parts ?? [])
      .filter((p) => p.type === "text" && !p.synthetic)
      .map((p) => p.text ?? "")
      .join("");

  const isEcho = (a: string, b: string): boolean => {
    const x = normalizeMessage(a);
    const y = normalizeMessage(b);
    if (!x || !y) return false;
    // 短すぎる挨拶（"👋" など）は echo と誤判定しない
    if (Math.min(x.length, y.length) < 4) return false;
    if (x === y) return true;
    // 部分一致（一方が他方にほぼ含まれる）。例: 編集で微差が付いた場合
    const short = x.length <= y.length ? x : y;
    const long = x.length <= y.length ? y : x;
    if (long.includes(short)) return short.length >= long.length * 0.5;
    return false;
  };

  // パターン1: 末尾=user・直前=assistant のミラー echo
  if (last.info.role === "user" && prev.info.role === "assistant") {
    return isEcho(text(prev), text(last));
  }

  // パターン2/3: 末尾=assistant（自動継続ループはこちらの形）
  if (last.info.role === "assistant" && msgs.length >= 3) {
    const beforePrev = msgs[msgs.length - 3];
    // 直前の user がその前の assistant の echo になっている
    if (prev.info.role === "user" && beforePrev.info.role === "assistant") {
      if (isEcho(text(beforePrev), text(prev))) return true;
    }
    // 直前の assistant と末尾の assistant が同一文の繰り返し
    if (beforePrev.info.role === "assistant") {
      if (isEcho(text(beforePrev), text(last))) return true;
    }
  }
  return false;
}

export interface LoopDetectionResult {
  streak: number;
  stopped: boolean;
  justStopped: boolean;
}

/* ---------------------------------------------------------------- *
 * 同一tool call反復検知: 最後の人間user入力以降の tool call のうち、直近
 * loop_tool_window 件で同一 (tool名+入力ハッシュ) が loop_tool_repeat_threshold 回
 * 出たらループとみなす。callID で dedupe、completed/error のみ数える。
 * ---------------------------------------------------------------- */

/** JSONのcanonical形式（キーを再帰ソート）。入力の同一性を順序非依存で判定する */
export function canonicalJSON(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) {
    return "[" + input.map((v) => canonicalJSON(v)).join(",") + "]";
  }
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(obj[k])).join(",") +
    "}"
  );
}

/** FNV-1a 64bit ハッシュ（文字列→16進hex）。実用目的のハッシュで十分 */
export function fnv1a(input: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}

/** tool call を `tool名:hash(canonicalJSON(input))` に正規化する。
 * シリアライズ不能・callID欠損・input欠損の tool 部品は null（カウント対象外）。 */
export function toolCallHash(part: SessionMessageLike["parts"][number]): string | null {
  if (part.type !== "tool") return null;
  if (!part.callID || !part.tool || !part.state || !("input" in part.state)) {
    return null;
  }
  if (part.state.status !== "completed" && part.state.status !== "error") {
    return null; // pending / running は数えない
  }
  try {
    return `${part.tool}:${fnv1a(canonicalJSON(part.state.input))}`;
  } catch {
    return null;
  }
}

/** 自動継続注入メッセージの先頭マーカー。session.messages 上で人間入力と
 * 区別するための目印（index.ts の idle ハンドラが注入文の先頭に付与する）。
 * これが無いと自前の注入が「人間の新規入力」に見えて tool 反復検知の
 * ウィンドウが毎回リセットされ、tool ループを検知できなくなる。 */
export const CONTINUATION_MARKER = "[graphhopper-continuation]";

/** 人間の新規入力テキスト部品か。自動継続注入・synthetic は除外する */
export function isHumanTextPart(
  p: SessionMessageLike["parts"][number],
): boolean {
  if (p.type !== "text" || p.synthetic || !(p.text ?? "").length) return false;
  return !p.text!.startsWith(CONTINUATION_MARKER);
}

/** 同一tool call反復を検知する。callID重複は1件に数え直す。 */
export function isToolRepeatLoop(
  msgs: SessionMessageLike[],
  cfg: GraphhopperConfig,
): boolean {
  const window = cfg.loop_tool_window;
  const threshold = cfg.loop_tool_repeat_threshold;
  if (window <= 0 || threshold <= 1) return false;

  // 最後の「人間の新規user入力（自動継続注入・syntheticでない text 部品を持つ）」
  // 以降のメッセージだけを見る。
  // tool result を運ぶ user メッセージ（text 部品なし）は人間入力扱いしない
  // （自動継続バーストを切らない）。自前の継続注入（CONTINUATION_MARKER 付き）も
  // 人間入力扱いしない（注入のたびにウィンドウがリセットされ tool ループを
  // 検知できなくなるバグの修正）。
  let lastHumanIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const hasHumanText = (m.parts ?? []).some(
      (p) => m.info.role === "user" && isHumanTextPart(p),
    );
    if (hasHumanText) {
      lastHumanIdx = i;
      break;
    }
  }

  // callID で dedupe（最新状態を採用）
  const calls = new Map<string, string>();
  for (let i = lastHumanIdx + 1; i < msgs.length; i++) {
    for (const p of msgs[i]?.parts ?? []) {
      if (p.type !== "tool" || !p.callID) continue;
      const h = toolCallHash(p);
      if (h === null) continue;
      calls.set(p.callID, h);
    }
  }

  const recent = Array.from(calls.values()).slice(-window);
  if (recent.length < threshold) return false;

  const counts = new Map<string, number>();
  for (const h of recent) counts.set(h, (counts.get(h) ?? 0) + 1);
  for (const n of counts.values()) if (n >= threshold) return true;
  return false;
}

/** echo / tool のどちらが検知に寄与したかを判定する（両方なら "echo+tool"） */
export function detectLoopKind(
  msgs: SessionMessageLike[],
  cfg: GraphhopperConfig,
): { detected: boolean; kind: LoopKind } {
  const echoEnabled = cfg.loop_stop_threshold > 0;
  const toolEnabled = cfg.loop_tool_repeat_threshold > 1;
  if (!echoEnabled && !toolEnabled) return { detected: false, kind: "echo" };

  const isEcho = echoEnabled && isEchoMessage(msgs);
  const isTool = toolEnabled && isToolRepeatLoop(msgs, cfg);
  const kind: LoopKind = isEcho && isTool ? "echo+tool" : isEcho ? "echo" : "tool";
  return { detected: isEcho || isTool, kind };
}

/** ループ検知で loop_streak / loop_stopped を更新する。検知でない（人間の新規入力）なら
 * streakをリセットし、停止中でも再開する（検知による誤検知でgoalが永久停止しないため）。
 * 閾値に達したら loop_stopped=true を返す（呼び出し側が goal を pause する）。 */
export function updateLoopDetection(
  root: string,
  detected: boolean,
  kind: LoopKind = "echo",
): LoopDetectionResult {
  const cfg = readConfig(root);
  const threshold =
    cfg.loop_stop_threshold > 0
      ? cfg.loop_stop_threshold
      : cfg.loop_tool_repeat_threshold;
  const state = readState(root);

  let streak: number;
  let stopped: boolean;
  if (threshold > 0 && detected) {
    streak = state.loop_streak + 1;
    stopped = state.loop_stopped || streak >= threshold;
  } else {
    streak = 0;
    stopped = false;
  }

  writeState(root, { ...state, loop_streak: streak, loop_stopped: stopped });
  if (state.goal_id && streak > 0) {
    recordEvent(root, {
      type: "loop_detected",
      goal: state.goal_id,
      kind,
      streak,
      stopped,
    });
  }
  return { streak, stopped, justStopped: stopped && !state.loop_stopped };
}

/* ---------------------------------------------------------------- *
 * 継続注入 dedupe: 前回注入以降の「進展」をフィンガープリント化する。
 * 進展 = 人間入力の到達位置・tool 実行件数・phase・eval_cmd・直近 eval 結果。
 * assistant の言い換え待機 ack（テキストのみ・tool なし）は進展に数えない。
 * これにより「deny → 待機ack → 注入 → 言い換え待機ack → 注入 …」の空転が
 * echo 検知（文面一致・閾値6回）を待たずに1往復で止まる。
 * ---------------------------------------------------------------- */

/** 最後の人間入力の到達位置（自動継続注入は人間扱いしない） */
function lastHumanIndex(msgs: SessionMessageLike[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (
      m.info.role === "user" &&
      (m.parts ?? []).some((p) => isHumanTextPart(p))
    ) {
      return i;
    }
  }
  return -1;
}

/** 進展フィンガープリントを計算する（純粋関数・テスト容易性のため分離） */
export function continuationFingerprint(
  msgs: SessionMessageLike[],
  phase: Phase,
  evalCmd: string | null,
  evalFingerprint: string | null,
): string {
  const h = lastHumanIndex(msgs);
  let toolCalls = 0;
  for (let i = h + 1; i < msgs.length; i++) {
    for (const p of msgs[i]?.parts ?? []) {
      if (p.type === "tool" && p.callID) toolCalls++;
    }
  }
  return fnv1a(
    canonicalJSON({
      h,
      t: toolCalls,
      p: phase,
      e: evalCmd ?? "",
      o: evalFingerprint ?? "",
    }),
  );
}

/** 継続リマインダーを注入したことを記録する（次回 idle の skip 判定材料） */
export function noteContinuation(root: string, marker: string): LoopState {
  const state = readState(root);
  const next = { ...state, last_continuation_marker: marker };
  writeState(root, next);
  return next;
}

/** 直近の eval 実行結果フィンガープリントを記録する */
export function noteEvalFingerprint(root: string, fp: string): LoopState {
  const state = readState(root);
  const next = { ...state, last_eval_fingerprint: fp };
  writeState(root, next);
  return next;
}

/** loop 停止時に goal を pause する（自動継続を物理的に止める）。累積停止回数
 * （loop_stop_count）を加算し、loop_stopped イベントを記録する。
 * pause は human の resume でしか解除されない。 */
export function stopLoopByPause(root: string): ActiveLoop | null {
  const state = readState(root);
  const count = state.loop_stop_count + 1;
  writeState(root, { ...state, loop_stop_count: count });
  const r = pauseGoal(root);
  if (r?.goal.id) {
    recordEvent(root, { type: "loop_stopped", goal: r.goal.id, count });
  }
  return r;
}

/** resume がブロックされているか（loop_stop_max に累積停止回数が達した） */
export function isResumeBlocked(root: string): boolean {
  const cfg = readConfig(root);
  if (cfg.loop_stop_max <= 0) return false;
  const state = readState(root);
  return state.loop_stop_count >= cfg.loop_stop_max;
}

/* ================================================================== *
 * stuck escalation: implementing での連続失敗を機械カウントし、
 * stuck_threshold に達したら graphhopper-oracle への相談を促す。
 * diffサイズ（router gate）とは別軸のタイミング判断——
 * 「詰まった回数」で上位モデルを呼ぶ graph engineering のもう1つの分岐点。
 * ================================================================== */

export interface AttemptResult {
  fail_streak: number;
  escalate: boolean;
}

export function setEvalCmd(root: string, cmd: string): LoopState {
  const state = readState(root);
  const next: LoopState = { ...state, eval_cmd: cmd || null };
  writeState(root, next);
  if (state.goal_id)
    recordEvent(root, { type: "eval_set", goal: state.goal_id, cmd });
  return next;
}

export interface EvalResult {
  ok: boolean;
  output: string;
}

/** eval_cmd をシェルで実際に実行し、exit codeで機械的に合否判定する（自己申告に依存しない） */
export async function runEval(
  shell: Shell,
  root: string,
  cmd: string,
): Promise<EvalResult> {
  try {
    const r = await shell`sh -c ${cmd}`.cwd(root).nothrow().quiet();
    const output = [r.stdout.toString(), r.stderr.toString()]
      .filter(Boolean)
      .join("\n");
    return { ok: r.exitCode === 0, output };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

export function recordAttempt(
  root: string,
  ok: boolean,
  note: string,
): AttemptResult {
  const state = readState(root);
  const fail_streak = ok ? 0 : state.fail_streak + 1;
  writeState(root, { ...state, fail_streak, notes: note || state.notes });
  const cfg = readConfig(root);
  const escalate = !ok && fail_streak >= cfg.stuck_threshold;
  if (state.goal_id) {
    recordEvent(root, {
      type: "attempt",
      goal: state.goal_id,
      ok,
      fail_streak,
      note,
    });
  }
  return { fail_streak, escalate };
}

/* ================================================================== *
 * design gate（C-2不変条件）: designing フェーズで edit/write を許可パス以外に通さない
 * tool.execute.before hook から呼ばれる純関数（副作用なし）
 * ================================================================== */

export function isDesignGateBlocked(
  cfg: GraphhopperConfig,
  phase: Phase,
  filePath: string,
): boolean {
  if (phase !== "designing") return false;
  return !cfg.design_gate_allow.some((prefix) => filePath.includes(prefix));
}

/** design doc不変化ゲート: designing終了後は該当goalのdesign docへの書き込みを常にブロックする
 * （graphhopper本体 hooks/design-gate.sh の事後編集ブロックと同じ思想）。verifierのdrift検出
 * アンカーとして読むため、実装に合わせて書き直せると「driftをdesign doc側の書き換えで消せる」
 * Goodhart's Lawの穴になる。決定の経緯・進捗は planLogPath（追記専用・ハードゲート無し）へ。
 * design_gate_allow とは独立（designing中はこの関数は常にfalseを返す）。 */
export function isDesignDocLocked(
  phase: Phase,
  goalId: string,
  filePath: string,
): boolean {
  if (phase === "designing") return false;
  return filePath.includes(`.graphhopper/plans/${goalId}.md`);
}

/* ================================================================== *
 * discover（loop-until-dry）: phase graph の外にあるオンデマンド探索。
 * round cap / dedupe を code側で強制する（opencodeにWorkflow相当が無いため、
 * 「尽きるまで周回・でも確実に止まる」の保証をTS toolに持たせる）。
 * dedupeは「既見全体」（reject/未採用も含む）に対して行う——確定済みだけに
 * 対すると、一度リジェクトされたfindingが毎ラウンド再発見されて無限空転する。
 * ================================================================== */

const MAX_DISCOVER_ROUNDS = 8;
const DRY_ROUNDS_TO_STOP = 2;

export interface DiscoverState {
  target: string;
  scope: string;
  round: number;
  dry_streak: number;
  seen: string[];
  confirmed: {
    title: string;
    severity: string;
    confidence: number;
    quote: string;
  }[];
  stopped_reason: "dry" | "max_rounds" | null;
  started_at: string;
}

function discoverPath(root: string): string {
  return join(dir(root), "discover.json");
}

export function startDiscover(
  root: string,
  target: string,
  scope: string,
): DiscoverState {
  const s: DiscoverState = {
    target,
    scope,
    round: 0,
    dry_streak: 0,
    seen: [],
    confirmed: [],
    stopped_reason: null,
    started_at: new Date().toISOString(),
  };
  atomicWrite(discoverPath(root), s);
  return s;
}

export function readDiscover(root: string): DiscoverState | null {
  if (!existsSync(discoverPath(root))) return null;
  return readJson<DiscoverState | null>(discoverPath(root), null);
}

export interface DiscoverFinding {
  title: string;
  severity: string;
  confidence: number;
  quote: string;
}

/**
 * 1ラウンド分のfindingsを渡してdedupe・round/dry_streak更新を行う。
 * round capとdry判定はここで機械的に強制する（呼び出し側の自己申告に依存しない）。
 */
export function tickDiscover(
  root: string,
  findings: DiscoverFinding[],
): DiscoverState {
  const s = readDiscover(root);
  if (!s)
    throw new Error("no active discover session. call startDiscover first.");
  if (s.stopped_reason) return s; // 既に停止済みなら何もしない（冪等）

  s.round += 1;
  const seenSet = new Set(s.seen);
  const newOnes = findings.filter((f) => !seenSet.has(f.title));
  for (const f of findings) seenSet.add(f.title); // reject/未採用も含め全件seenに入れる
  s.seen = Array.from(seenSet);

  if (newOnes.length === 0) {
    s.dry_streak += 1;
  } else {
    s.dry_streak = 0;
    const adopted = newOnes.filter(
      (f) =>
        f.confidence >= 80 &&
        (f.severity === "critical" || f.severity === "high"),
    );
    s.confirmed.push(...adopted);
  }

  if (s.dry_streak >= DRY_ROUNDS_TO_STOP) s.stopped_reason = "dry";
  else if (s.round >= MAX_DISCOVER_ROUNDS) s.stopped_reason = "max_rounds";

  atomicWrite(discoverPath(root), s);
  return s;
}

export function clearDiscover(root: string): void {
  if (existsSync(discoverPath(root))) atomicWrite(discoverPath(root), null);
}
