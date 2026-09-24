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
 * config は「グローバル既定 → プロジェクト上書き」の2層で解決する（readConfig）。
 * グローバル既定は `~/.config/opencode/graphhopper.json`（`GRAPHHOPPER_CONFIG` で変更可）。
 * 全プロジェクトで同じ agents 設定を使いたい場合はグローバルに1枚置けばよい。
 *
 * 外部依存なし（node stdlib のみ）。全ての書き込みは tmp+rename で原子的に行う。
 * flywheel-opencode (src/state.ts) の atomic write パターンを踏襲。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
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
  /** 直近に edit/write されたファイル（正規化前パス）。同一ファイル再編集の
   * 検知アンカー。別ファイル・eval pass・phase 遷移・resume でリセット */
  edit_file: string | null;
  /** 同一ファイルへの連続 edit/write 回数。stuck_edit_repeat に達したら
   * stuck 扱い（堂々巡りの再編集の機械検知） */
  edit_streak: number;
  /** 直近に測定したワーキングコピー差分行数。diff 停滞の検知アンカー */
  last_diff_lines: number | null;
  /** ワーキングコピー差分が変わらない idle  eval 回数。stuck_diff_stall に
   * 達したら stuck 扱い。差分変化・eval pass・phase 遷移・resume でリセット */
  diff_stall: number;
  /** 直近に stuck 通知した理由集合。同一理由の再通知を抑止する。
   * resume でクリアする */
  last_stuck_reasons: string[];
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
  /** eval_cmd / attempt の連続失敗数がこれに達したら giveUp し goal を pause する
   * （既定 6 = stuck_threshold 既定 3 の2倍。fail 3,4,5 で escalate 相談→
   * 改善なければ 6 で諦めの順序）。0以下で無効。有効時は stuck_threshold
   * 以上にクランプされる（相談前に諦める逆転を防ぐ） */
  max_eval_fails: number;
  /** 同一ファイルへの連続 edit/write がこの回数に達したら stuck 扱いにする。
   * 1以下で無効 */
  stuck_edit_repeat: number;
  /** ワーキングコピー差分が変わらない idle eval がこの回数続いたら stuck 扱い。
   * 1以下で無効 */
  stuck_diff_stall: number;
  /** 追加LSP server定義（design g-mu5atclj D4）。同extensionsはbuiltinを上書き、未知は追記 */
  lsp_servers: { command: string; args: string[]; extensions: string[] }[];
  /** trueで designing→implementing 遷移に critic_review 記録を要求する。
   * 既定 false（opt-in維持。ゲート化の是非は未決のためflagで両対応） */
  require_critic: boolean;
}

export const DEFAULT_CONFIG: GraphhopperConfig = {
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

/** 全プロジェクト共通の既定設定。`GRAPHHOPPER_CONFIG` で明示指定も可能。 */
function globalConfigPath(): string {
  return (
    process.env.GRAPHHOPPER_CONFIG ??
    join(homedir(), ".config", "opencode", "graphhopper.json")
  );
}

function historyPath(root: string): string {
  return join(dir(root), "history.jsonl");
}

export function planPath(root: string, goalId: string): string {
  return join(dir(root), "plans", `${goalId}.md`);
}

/* design doc scaffold: goal開始時に骨格を自動生成する。
 * 構造検証（gate.ts checkDesignDoc）のアンカー。既存ファイルは壊さない（冪等）。 */
export function designTemplate(goalId: string, title: string): string {
  return [
    `# design: ${title} (${goalId})`,
    ``,
    `## 1. goal理解`,
    ``,
    `（何を・なぜやるか。1〜3文）`,
    ``,
    `## 2. 現状`,
    ``,
    `（調査済み事実。証拠付き）`,
    ``,
    `## 3. 設計判断`,
    ``,
    `（採用・棄却の判断と理由）`,
    ``,
    `## 4. 実装タスク列`,
    ``,
    `- [ ] T1 （タスク）`,
    ``,
    `## 5. 棄却した代替案`,
    ``,
    `| 対象 | 採用 | 棄却 |`,
    `|---|---|---|`,
    ``,
  ].join("\n");
}

/** scaffoldが無ければ生成する。生成したら true、既存なら false */
export function scaffoldDesignDoc(root: string, goalId: string, title: string): boolean {
  try {
    const p = planPath(root, goalId);
    if (existsSync(p)) return false;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, designTemplate(goalId, title), "utf8");
    return true;
  } catch {
    return false;
  }
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
  | { type: "eval_gave_up"; goal: string; fail_streak: number }
  | { type: "stuck_hint"; goal: string; reasons: string[] }
  | {
      type: "loop_detected";
      goal: string;
      kind: LoopKind;
      streak: number;
      stopped: boolean;
    }
  | { type: "loop_stopped"; goal: string; count: number }
  | { type: "loop_resume_forced"; goal: string }
  | { type: "continuation_skipped"; goal: string; marker: string }
  | { type: "hash_edit_applied"; goal: string; path: string }
  | {
      type: "hash_edit_refused";
      goal: string;
      path: string;
      reason: string;
    };

/** append-only の履歴ログ。LLMの自己申告ではなくplugin機械記録の監査証跡 */
export function recordEvent(root: string, event: HistoryEvent): void {
  try {
    mkdirSync(dir(root), { recursive: true });
    const record = { ts: new Date().toISOString(), ...event };
    const line = JSON.stringify(record) + "\n";
    appendFileSync(historyPath(root), line, "utf8");
    writeOutbox(root, record);
  } catch {
    // 履歴書き込み失敗でループを止めない
  }
}

/* ================================================================== *
 * outbox（durable通知）: プログラムが受け取れる完了・異常通知。
 * 会話上の「終わったよ」ではなくファイルで受け取る。watcher試作が読む。
 * curated種別のみ投下し、上限超は古いものから刈る。失敗しても本線を壊さない。
 * ================================================================== */

const OUTBOX_KEEP = 100;

/** outboxに投下する種別（完了・drift・諦め・停止のみ。attempt等の高頻度は対象外） */
const OUTBOX_EVENTS: ReadonlySet<string> = new Set([
  "goal_complete",
  "verifier_verdict",
  "eval_gave_up",
  "loop_stopped",
]);

function outboxPath(root: string): string {
  return join(dir(root), "outbox");
}

function writeOutbox(
  root: string,
  record: { ts: string; type: string; goal?: unknown },
): void {
  try {
    if (!OUTBOX_EVENTS.has(record.type)) return;
    mkdirSync(outboxPath(root), { recursive: true });
    const stamp = record.ts.replace(/[:.]/g, "-");
    const goal = typeof record.goal === "string" ? record.goal : "nogoal";
    writeFileSync(
      join(outboxPath(root), `${stamp}-${record.type}-${goal}.json`),
      JSON.stringify(record, null, 2) + "\n",
      "utf8",
    );
    const files = readdirSync(outboxPath(root))
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - OUTBOX_KEEP))) {
      try {
        unlinkSync(join(outboxPath(root), f));
      } catch {
        // 刈り取り失敗は無視
      }
    }
  } catch {
    // outbox失敗で本線を壊さない
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
  // グローバル既定 < プロジェクト上書き。agents だけは name 単位でマージする
  // （プロジェクト側で一部の subagent だけ別モデルに差し替えられるように）。
  const global = readJson<Partial<GraphhopperConfig>>(globalConfigPath(), {});
  const project = readJson<Partial<GraphhopperConfig>>(configPath(root), {});
  const raw: Partial<GraphhopperConfig> = {
    ...global,
    ...project,
    agents: { ...(global.agents ?? {}), ...(project.agents ?? {}) },
  };
  const stuck_threshold =
    raw.stuck_threshold ?? DEFAULT_CONFIG.stuck_threshold;
  const maxRaw = raw.max_eval_fails ?? DEFAULT_CONFIG.max_eval_fails;
  return {
    router_threshold_lines:
      raw.router_threshold_lines ?? DEFAULT_CONFIG.router_threshold_lines,
    design_gate_allow:
      raw.design_gate_allow ?? DEFAULT_CONFIG.design_gate_allow,
    agents: { ...(DEFAULT_CONFIG.agents ?? {}), ...(raw.agents ?? {}) },
    stuck_threshold,
    loop_stop_threshold:
      raw.loop_stop_threshold ?? DEFAULT_CONFIG.loop_stop_threshold,
    loop_stop_max: raw.loop_stop_max ?? DEFAULT_CONFIG.loop_stop_max,
    loop_tool_window:
      raw.loop_tool_window ?? DEFAULT_CONFIG.loop_tool_window,
    loop_tool_repeat_threshold:
      raw.loop_tool_repeat_threshold ??
      DEFAULT_CONFIG.loop_tool_repeat_threshold,
    // 相談 (stuck) より諦め (giveUp) が先に発火しないよう下限を揃える
    max_eval_fails: maxRaw <= 0 ? maxRaw : Math.max(maxRaw, stuck_threshold),
    stuck_edit_repeat:
      raw.stuck_edit_repeat ?? DEFAULT_CONFIG.stuck_edit_repeat,
    stuck_diff_stall:
      raw.stuck_diff_stall ?? DEFAULT_CONFIG.stuck_diff_stall,
    lsp_servers: raw.lsp_servers ?? DEFAULT_CONFIG.lsp_servers,
    require_critic: raw.require_critic ?? DEFAULT_CONFIG.require_critic,
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
    fail_streak: 0,
    eval_cmd: null,
    last_continuation_marker: null,
    last_eval_fingerprint: null,
    loop_streak: 0,
    loop_stopped: false,
    loop_stop_count: 0,
    edit_file: null,
    edit_streak: 0,
    last_diff_lines: null,
    diff_stall: 0,
    last_stuck_reasons: [],
    updated_at: new Date().toISOString(),
  };
}

export function readState(root: string): LoopState {
  const loaded = readJson<Partial<LoopState>>(statePath(root), emptyState());
  const merged: LoopState = {
    ...emptyState(),
    ...loaded,
    router: { ...emptyState().router, ...(loaded.router ?? {}) },
  };
  // 破損 state.json の未知 phase は designing にフォールバックする。
  // 未検証のまま通すと PHASE_ACTION[phase] 参照が undefined になる。
  if (!(PHASES as readonly string[]).includes(merged.phase)) {
    merged.phase = "designing";
  }
  return merged;
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
  // design scaffold: 骨格を自動生成（既存があれば壊さない）。
  // 構造検証ゲートのアンカーになる
  scaffoldDesignDoc(root, goal.id, goal.title);
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
    // pause→人間修正→resume の運用で eval リトライ・stuck 信号を数え直すため
    // fail_streak・stuck系も戻す（loop 停止からの resume でも escalate は再カウント）。
    // loop_stop_count（恒久ブロック予算）は維持する
    state: {
      session_id: sessionID,
      loop_streak: 0,
      loop_stopped: false,
      fail_streak: 0,
      edit_file: null,
      edit_streak: 0,
      last_diff_lines: null,
      diff_stall: 0,
      last_stuck_reasons: [],
    },
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

/** clear 専用: goal を done 化するが `goal_complete` イベントは記録しない
 * （clear は完了ではなく破棄のため、監査ログに完了として残さない）。
 * done 化自体（status/done_at）は維持し、`active` からは外す。
 * loop カウンタは0に戻し、phase は designing に戻す（phase イベントも記録しない）。 */
export function clearActiveGoal(root: string): Goal | null {
  const goals = readGoals(root);
  if (!goals.active) return null;
  const goal = goals.goals.find((g) => g.id === goals.active);
  if (!goal) return null;
  goal.status = "done";
  goal.done_at = new Date().toISOString();
  goals.active = null;
  writeGoals(root, goals);
  const s = readState(root);
  writeState(root, {
    ...s,
    phase: "designing",
    notes: "",
    fail_streak: 0,
    loop_streak: 0,
    loop_stopped: false,
    loop_stop_count: 0,
  });
  return goal;
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

/* 遷移合法性表（takt workflow doctorの発想の機械版）。
 * - 同一phaseは許可（notes更新等の無遷移呼び出しのため）
 * - polish→implementingのみ巻き戻し可（verifier driftの行き先）
 * - *→doneは不可: doneはcompleteGoal（verifier cleanガード付き）のみ。
 *   clearActiveGoalはstate直書きのためこの表の対象外 */
export const LEGAL_TRANSITIONS: Record<Phase, Phase[]> = {
  designing: ["designing", "implementing"],
  implementing: ["implementing", "polish"],
  polish: ["polish", "implementing", "done"],
  done: ["done"],
};

export function isLegalPhaseTransition(from: Phase, to: Phase): boolean {
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

export function setPhase(
  root: string,
  phase: Phase,
  notes?: string,
): ActiveLoop | null {
  if (!PHASES.includes(phase)) return null;
  const before = getActive(root);
  // 遷移合法性（takt workflow doctorの発想の機械版）。
  // 特に *→done の直指定を塞ぐ: doneはcomplete（verifier cleanガード付き）のみ。
  // setPhase(done)で抜けるとgoalがactiveのままloopだけ止まるself-graded doneの穴になる。
  if (before && !isLegalPhaseTransition(before.state.phase, phase)) return null;
  const r = mutateActive(root, () => ({
    // phaseが変わるたびfail系・stuck系カウンタをリセット
    // （implementingに戻ってきた時も0から数え直す。巻き戻し直後のインフレ防止）
    state: {
      phase,
      fail_streak: 0,
      edit_file: null,
      edit_streak: 0,
      last_diff_lines: null,
      diff_stall: 0,
      last_stuck_reasons: [],
      ...(notes !== undefined ? { notes } : {}),
    },
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
    if (r.exitCode === 0 && out) {
      const rev = out.split("\n")[0] ?? null;
      if (rev && isValidBaselineRev(rev)) return rev;
      return null;
    }
  } catch {
    // ignore
  }
  try {
    const r = await shell`sh -c ${"git rev-parse HEAD"}`
      .cwd(root)
      .nothrow()
      .quiet();
    const out = r.stdout.toString().trim();
    if (r.exitCode === 0 && out && isValidBaselineRev(out)) return out;
  } catch {
    // ignore
  }
  return null;
}

/** baseline_rev の形式検証（jj commit_id / git sha は共に full hex）。
 * VCS由来とはいえ shell 補間に渡す前に検証し、不正なら null 扱いにする。 */
export function isValidBaselineRev(baseline: string): boolean {
  return /^[0-9a-fA-F]+$/.test(baseline);
}

/** `--stat` / `--shortstat` 末行（"N files changed, M insertions(+), K deletions(-)"）
 * をパースして挿入+削除行数を返す。insert-only / delete-only 対応。
 * どちらも無ければ null（diff無しとパース不能を区別せず、呼び出し側で0扱い）。 */
export function parseDiffShortstat(out: string): number | null {
  const ins = out.match(/(\d+) insertion/);
  const del = out.match(/(\d+) deletion/);
  if (!ins && !del) return null;
  return (ins ? Number(ins[1]) : 0) + (del ? Number(del[1]) : 0);
}

/** baseline からの diff 行数を測定する（jj → git fallback） */
export async function measureDiffLines(
  shell: Shell,
  root: string,
  baseline: string | null,
): Promise<number> {
  if (!baseline || !isValidBaselineRev(baseline)) return 0;
  try {
    // Bun shell の補間値は自動escapeされるため、baseline を直接埋め込む。
    // 以前の `sh -c "jj diff --from ${baseline} ..."` は sh 内で無escapeだった。
    // pipe (tail) を避け、末行の取り出しは JS で行う。
    const r = await shell`jj diff --from ${baseline} --stat`
      .cwd(root)
      .nothrow()
      .quiet();
    if (r.exitCode === 0) {
      const lines = r.stdout.toString().trim().split("\n");
      const parsed = parseDiffShortstat(lines[lines.length - 1] ?? "");
      if (parsed !== null) return parsed;
    }
  } catch {
    // ignore
  }
  try {
    const r = await shell`git diff --shortstat ${baseline}`
      .cwd(root)
      .nothrow()
      .quiet();
    const out = r.stdout.toString().trim();
    return parseDiffShortstat(out) ?? 0;
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

/** verifier fan-out の1レンズ分の結果（verifier_set の results 要素） */
export interface VerifierResult {
  lens: VerifierLens;
  level: VerdictLevel;
  target?: DriftTarget | null;
}

/** verifier_set 入力の検証。通れば null、ダメならエラー文（tool がそのまま返す）。
 * self-graded 完了防止の機械ゲート（旧 lens 空拒否の後継）。 */
export function checkVerifierResults(
  results: VerifierResult[] | null | undefined,
): string | null {
  if (!Array.isArray(results) || results.length === 0) {
    return "error: results が空です。graphhopper_verifier_set は task(subagent_type: 'graphhopper-verifier') を実際に呼んだ後にしか記録できません（self-graded完了を防ぐための機械的ゲート）。route=advisorでも最低1回、'general'charterで呼んでください。";
  }
  const known: VerifierLens[] = [
    "requirement",
    "behavior",
    "progress",
    "general",
  ];
  const seen = new Set<string>();
  for (const r of results) {
    if (!r || typeof r !== "object") return "error: results の要素が不正です";
    if (!known.includes(r.lens)) {
      return `error: 未知の lens です: ${String((r as { lens?: unknown }).lens)}`;
    }
    if (seen.has(r.lens)) {
      return `error: lens が重複しています: ${r.lens}`;
    }
    seen.add(r.lens);
    if (r.level !== "clean" && r.level !== "drift") {
      return `error: 不正な level です: ${String((r as { level?: unknown }).level)}`;
    }
    if (
      r.target !== undefined &&
      r.target !== null &&
      r.target !== "implementing" &&
      r.target !== "design" &&
      r.target !== "requirements"
    ) {
      return `error: 不正な target です: ${String(r.target)}`;
    }
    if (r.level === "drift" && !r.target) {
      return `error: drift には target が必要です (lens: ${r.lens})`;
    }
  }
  return null;
}

/** verifier fan-out 結果の集約ルール（純粋関数）。
 * 前提: checkVerifierResults で検証済み（非空・既知lens・重複なし・
 * drift に target 必須）。「confidence高 & severity high/critical のみ採用」
 * というメインの裁量だった基準をコード化したもの:
 * - 1つでも drift → 全体 drift。target は `implementing` を優先
 *   （即時巻き戻し可能な唯一の行き先）、無ければ先頭の drift target。
 * - 全 clean → clean (target null)。 */
export function aggregateVerdicts(results: VerifierResult[]): {
  level: VerdictLevel;
  target: DriftTarget | null;
} {
  const drifts = results.filter((r) => r.level === "drift");
  if (drifts.length === 0) return { level: "clean", target: null };
  const impl = drifts.find((r) => r.target === "implementing");
  return {
    level: "drift",
    target: (impl ?? drifts[0])?.target ?? null,
  };
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

/** JSONのcanonical形式（キーを再帰ソート）。入力の同一性を順序非依存で判定する。
 * stringify不能な入力（undefined / function / symbol）は "undefined" を返す。 */
export function canonicalJSON(input: unknown): string {
  if (input === null || typeof input !== "object") {
    const s = JSON.stringify(input);
    return s === undefined ? "undefined" : s;
  }
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

/** 最後の人間入力メッセージの id（無ければ null）。
 * id はスライドウィンドウをまたいで安定するため、dedupe の人間アンカーに使う。
 * id 欠損時は空文字に倒す（null=不在と区別。衝突しても安定するため
 * dedupe が壊れない）。 */
export function lastHumanId(msgs: SessionMessageLike[]): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (
      m.info.role === "user" &&
      (m.parts ?? []).some((p) => isHumanTextPart(p))
    ) {
      const id: unknown = (m.info as { id?: unknown }).id;
      return typeof id === "string" ? id : "";
    }
  }
  return null;
}

/** 進展フィンガープリントを計算する（純粋関数・テスト容易性のため分離）。
 * 人間アンカーは配列インデックスではなくメッセージ id で持つ。
 * 末尾N取得のスライドウィンドウ下でも、deny/ack の追加では人間 id・tool 件数
 * ともに不変のため dedupe「1往復で止まる」が成立する。 */
export function continuationFingerprint(
  msgs: SessionMessageLike[],
  phase: Phase,
  evalCmd: string | null,
  evalFingerprint: string | null,
): string {
  const h = lastHumanId(msgs);
  let toolCalls = 0;
  let afterHuman = h === null;
  for (const m of msgs) {
    if (!afterHuman) {
      const id: unknown = (m.info as { id?: unknown }).id;
      if ((typeof id === "string" ? id : "") === h) {
        afterHuman = true;
      }
      continue;
    }
    for (const p of m?.parts ?? []) {
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
  /** 連続失敗が max_eval_fails に達し、goal を pause すべきか */
  giveUp: boolean;
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
  // ok は進展の証拠: edit 堂々巡り・diff 停滞もリセットする
  // （idle の eval 経路と attempt(ok) 自己申告経路の両方に効く）
  writeState(root, {
    ...state,
    fail_streak,
    notes: note || state.notes,
    ...(ok
      ? { edit_file: null, edit_streak: 0, diff_stall: 0 }
      : {}),
  });
  const cfg = readConfig(root);
  const escalate = !ok && fail_streak >= cfg.stuck_threshold;
  const giveUp =
    !ok && cfg.max_eval_fails > 0 && fail_streak >= cfg.max_eval_fails;
  if (state.goal_id) {
    recordEvent(root, {
      type: "attempt",
      goal: state.goal_id,
      ok,
      fail_streak,
      note,
    });
  }
  return { fail_streak, escalate, giveUp };
}

/* ================================================================== *
 * stuck 信号の追加: fail_streak（連続失敗）に加え、同一ファイル再編集と
 * diff 停滞を機械カウントし、いずれかが閾値で oracle への相談を促す。
 * 「相談」と「諦め (giveUp)」は別軸——こちらは pause しない。
 * ================================================================== */

/** 同一ファイル連続編集の純粋遷移。同一 → +1、別 → リセット */
export function nextEditStreak(
  prev: { file: string | null; streak: number },
  file: string,
): { file: string; streak: number } {
  if (prev.file === file) return { file, streak: prev.streak + 1 };
  return { file, streak: 1 };
}

/** edit/write 成功時に同一ファイル streak を更新する */
export function noteEdit(root: string, filePath: string): LoopState {
  const state = readState(root);
  const next = nextEditStreak(
    { file: state.edit_file, streak: state.edit_streak },
    filePath,
  );
  const updated: LoopState = {
    ...state,
    edit_file: next.file,
    edit_streak: next.streak,
  };
  writeState(root, updated);
  return updated;
}

/** ワーキングコピー差分（親比）の行数を測る。stateless 測定のため
 * baseline 不要。jj → git fallback。両失敗時は null（何もしない）。 */
export async function measureWorkingCopyLines(
  shell: Shell,
  root: string,
): Promise<number | null> {
  try {
    const r = await shell`jj diff --stat`.cwd(root).nothrow().quiet();
    if (r.exitCode === 0) {
      const lines = r.stdout.toString().trim().split("\n");
      const parsed = parseDiffShortstat(lines[lines.length - 1] ?? "");
      if (parsed !== null) return parsed;
      // stat 出力なし（差分ゼロ）の判定: 空出力なら 0
      if (r.stdout.toString().trim() === "") return 0;
    }
  } catch {
    // ignore
  }
  try {
    const r = await shell`git diff --shortstat`.cwd(root).nothrow().quiet();
    if (r.exitCode === 0) {
      const out = r.stdout.toString().trim();
      if (out === "") return 0;
      return parseDiffShortstat(out) ?? 0;
    }
  } catch {
    // ignore
  }
  return null;
}

/** diff 停滞の純粋遷移。同一行数 → +1、変化・測定不能 → リセット */
export function nextDiffStall(
  prev: { lines: number | null; stall: number },
  lines: number | null,
): { lines: number | null; stall: number } {
  if (lines === null) return { lines: prev.lines, stall: 0 };
  if (prev.lines === lines) return { lines, stall: prev.stall + 1 };
  return { lines, stall: 0 };
}

/** diff 停滞を更新する（測定不能時は現状維持） */
export function noteDiffLines(
  root: string,
  lines: number | null,
): LoopState {
  const state = readState(root);
  const next = nextDiffStall(
    { lines: state.last_diff_lines, stall: state.diff_stall },
    lines,
  );
  const updated: LoopState = {
    ...state,
    last_diff_lines: next.lines,
    diff_stall: next.stall,
  };
  writeState(root, updated);
  return updated;
}

export interface StuckStatus {
  escalate: boolean;
  reasons: string[];
}

/** 進捗停滞シグナルの集約判定（読み取り専用。書き込みは note 系に分離）。
 * 同一ファイル再編集・diff 停滞の OR。fail_streak は対象外:
 * 全 caller が r.escalate==false 時のみ参照し、その条件は fail_streak<閾値と
 * 同値のため fail 枝は到達不能（dead につき削除。fail は recordAttempt 側が担う）。
 * 実 history でも stuck_hint 発火は edit/diff 系のみ想定。 */
export function checkStuck(root: string): StuckStatus {
  const cfg = readConfig(root);
  const state = readState(root);
  const reasons: string[] = [];
  if (
    cfg.stuck_edit_repeat > 1 &&
    state.edit_streak >= cfg.stuck_edit_repeat
  ) {
    reasons.push(`edit_repeat(${state.edit_file}×${state.edit_streak})`);
  }
  if (
    cfg.stuck_diff_stall > 1 &&
    state.diff_stall >= cfg.stuck_diff_stall
  ) {
    reasons.push(`diff_stall×${state.diff_stall}`);
  }
  return { escalate: reasons.length > 0, reasons };
}

/** stuck 通知した理由集合を記録する。同一理由なら stuck_hint を出さず
 * false を返す（通知スキップ）。理由変化で true＋イベント記録。 */
export function noteStuckNotified(root: string, reasons: string[]): boolean {
  const state = readState(root);
  const prev = state.last_stuck_reasons;
  const same =
    prev.length === reasons.length && prev.every((r, i) => r === reasons[i]);
  if (same) return false;
  writeState(root, { ...state, last_stuck_reasons: [...reasons] });
  if (state.goal_id) {
    recordEvent(root, {
      type: "stuck_hint",
      goal: state.goal_id,
      reasons: [...reasons],
    });
  }
  return true;
}

/* ================================================================== *
 * design gate（C-2不変条件）: designing フェーズで edit/write を許可パス以外に通さない
 * tool.execute.before hook から呼ばれる純関数（副作用なし）
 * ================================================================== */

import { isAbsolute, normalize, relative, sep } from "node:path";

/** gate判定用に filePath を root 相対・正規化する（`..` 解消・区切り統一）。
 * root 外の絶対パスは `..` 始まりになり、許可prefixに一致しない（fail-closed）。 */
function normalizeForGate(root: string, filePath: string): string {
  const rel = isAbsolute(filePath) ? relative(root, filePath) : filePath;
  return normalize(rel).split(sep).join("/");
}

function matchesAllowed(normalized: string, prefix: string): boolean {
  const p = normalize(prefix).split(sep).join("/").replace(/\/+$/, "");
  return normalized === p || normalized.startsWith(`${p}/`);
}

export function isDesignGateBlocked(
  root: string,
  cfg: GraphhopperConfig,
  phase: Phase,
  filePath: string,
): boolean {
  if (phase !== "designing") return false;
  const n = normalizeForGate(root, filePath);
  return !cfg.design_gate_allow.some((prefix) => matchesAllowed(n, prefix));
}

/** design doc不変化ゲート: designing終了後は該当goalのdesign docへの書き込みを常にブロックする
 * （graphhopper本体 hooks/design-gate.sh の事後編集ブロックと同じ思想）。verifierのdrift検出
 * アンカーとして読むため、実装に合わせて書き直せると「driftをdesign doc側の書き換えで消せる」
 * Goodhart's Lawの穴になる。決定の経緯・進捗は planLogPath（追記専用・ハードゲート無し）へ。
 * design_gate_allow とは独立（designing中はこの関数は常にfalseを返す）。 */
export function isDesignDocLocked(
  root: string,
  phase: Phase,
  goalId: string,
  filePath: string,
): boolean {
  if (phase === "designing") return false;
  // 正規化後の完全一致。`.log.md`（`${goalId}.log.md`）は対象外のまま。
  return (
    normalizeForGate(root, filePath) === `.graphhopper/plans/${goalId}.md`
  );
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
  /** 紐付く goal（開始時点の active。無ければ null）。lineage が載せる */
  goal_id: string | null;
}

function discoverPath(root: string): string {
  return join(dir(root), "discover.json");
}

export function startDiscover(
  root: string,
  target: string,
  scope: string,
  goalId: string | null = null,
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
    goal_id: goalId,
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

/* ================================================================== *
 * lineage（作業グラフの第一歩）: goals.json + history.jsonl から
 * goal ごとの系譜を導出する。MCP の lineage.json resource が読む。
 * graft（コードの構造）に対する「作業の構造」側の edge 素材。
 * ================================================================== */

/** history.jsonl の1行（recordEvent が付与する ts 付き） */
export type HistoryRecord = HistoryEvent & { ts?: string };

export function readHistory(root: string): HistoryRecord[] {
  const p = historyPath(root);
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as HistoryRecord);
  } catch {
    return [];
  }
}

export interface GoalLineage {
  id: string;
  title: string;
  status: GoalStatus;
  /** 訪れた phase（順序保持・重複なし。先頭は常に designing） */
  phases: Phase[];
  /** polish → implementing の巻き戻し回数（verifier drift の機械証跡） */
  rewinds: number;
  verifier: { level: VerdictLevel; target: DriftTarget | null; lens: VerifierLens[] }[];
  critic: VerdictLevel | null;
  evalRuns: { pass: number; fail: number };
  maxFailStreak: number;
  gateBlocks: number;
  editedFiles: string[];
  routerChecks: { diff_lines: number; route: RouterRoute }[];
}

export function buildLineage(root: string): {
  goals: GoalLineage[];
  discover: DiscoverState | null;
} {
  const stored = readGoals(root);
  const byId = new Map<string, GoalLineage>();
  for (const g of stored.goals) {
    byId.set(g.id, {
      id: g.id,
      title: g.title,
      status: g.status,
      phases: ["designing"],
      rewinds: 0,
      verifier: [],
      critic: null,
      evalRuns: { pass: 0, fail: 0 },
      maxFailStreak: 0,
      gateBlocks: 0,
      editedFiles: [],
      routerChecks: [],
    });
  }
  const get = (goalId: string): GoalLineage | null => {
    let l = byId.get(goalId);
    if (!l) {
      // goals.json に無い（clear 済み等）が history に残る分は title 不明で計上
      l = {
        id: goalId,
        title: "(unknown)",
        status: "done",
        phases: ["designing"],
        rewinds: 0,
        verifier: [],
        critic: null,
        evalRuns: { pass: 0, fail: 0 },
        maxFailStreak: 0,
        gateBlocks: 0,
        editedFiles: [],
        routerChecks: [],
      };
      byId.set(goalId, l);
    }
    return l;
  };
  for (const h of readHistory(root)) {
    const goalId = (h as { goal?: unknown }).goal;
    if (typeof goalId !== "string") continue;
    const l = get(goalId);
    if (!l) continue;
    switch (h.type) {
      case "phase":
        if (!l.phases.includes(h.to)) l.phases.push(h.to);
        if (h.from === "polish" && h.to === "implementing") l.rewinds += 1;
        break;
      case "verifier_verdict":
        l.verifier.push({ level: h.level, target: h.target, lens: h.lens });
        break;
      case "critic_review_set":
        l.critic = h.level;
        break;
      case "eval_run":
        if (h.ok) l.evalRuns.pass += 1;
        else l.evalRuns.fail += 1;
        break;
      case "attempt":
        if (h.fail_streak > l.maxFailStreak) l.maxFailStreak = h.fail_streak;
        break;
      case "design_gate_block":
      case "design_doc_locked_block":
        l.gateBlocks += 1;
        break;
      case "hash_edit_applied":
        if (!l.editedFiles.includes(h.path)) l.editedFiles.push(h.path);
        break;
      case "router_check":
        l.routerChecks.push({ diff_lines: h.diff_lines, route: h.route });
        break;
      default:
        break;
    }
  }
  return { goals: [...byId.values()], discover: readDiscover(root) };
}
