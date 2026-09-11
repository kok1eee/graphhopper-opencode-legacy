/**
 * graphhopper — designing/implementing/polish state machine plugin for opencode
 *
 * graphhopper本体（Claude Code版）の3相グラフをopencodeに移植する。
 * flywheel-opencodeとの最大の違い: C-2不変条件（designing中はsource編集を物理ブロック）を
 * `tool.execute.before` hookで実装している点（flywheel-opencodeにはこの層が無い）。
 *
 * 対応関係（Claude Code → opencode）:
 *   PreToolUse (hooks/design-gate.sh) → tool.execute.before
 *   Stop       (hooks/loop-driver.sh) → event: session.idle
 *
 * 構成:
 * - tools:
 *   - graphhopper_goal          : goal の start/pause/resume/complete/clear
 *   - graphhopper_status        : 現在の goal + フェーズ表示
 *   - graphhopper_phase         : フェーズ遷移（designing → implementing → polish → done）
 *   - graphhopper_router_check  : diff サイズを機械測定し advisor/polish に分岐（loop-driver.sh相当）
 *   - graphhopper_verifier_set  : polish の verifier fan-out 結果（clean/drift）を記録
 *   - graphhopper_critic_set    : designing終了前のdesign.md質レビュー結果を記録（opt-in、ハードゲート無し）
 *   - graphhopper_handoff       : goal状態を別セッションへ引き継ぎ送信（promptAsync）
 * - hook:
 *   - tool.execute.before : designing フェーズで edit/write を許可パス（plans/ 配下）以外に通さない
 * - event:
 *   - session.idle    : active goal があれば継続プロンプトを注入（ループの心臓）。
 *                        会話サイズが handoff_nudge_chars を超えたら一度だけ handoff を促す
 *   - session.deleted : セッション紐付けを解除
 *
 * state は `.graphhopper/` に保存される（state.ts 参照）。
 */
import { tool, type Plugin } from "@opencode-ai/plugin";
import { injectAgents } from "./agents";
import { PONYTAIL_RULES } from "./ponytail-rules";
import * as state from "./state";

const SYSTEM_GUIDE = `## graphhopper（designing/implementing/polishループ）の存在

この環境には graphhopper プラグインが常駐している。複数ファイルにまたがる変更・設計判断を含む実装を依頼されたら、手を付ける前に graphhopper_goal(action: "start", title: ...) でループを開始せよ。

designing フェーズでは source ファイルの edit/write は物理的にブロックされる（許可されるのは .graphhopper/plans/ 配下の design ドキュメントのみ）。まず design ドキュメントを書き、graphhopper-critic で1回敵対レビューしてから implementing フェーズに遷移して実装せよ。

使わない場面: 単一ファイルの小修正・質問への回答・一回きりのコマンド実行程度の単純作業。その場合は直接やれ。

active な goal が既にあるなら graphhopper_status で状態を確認し、ループの継続として振る舞え。`;

const PHASE_ACTION: Record<state.Phase, string> = {
  designing:
    "goalを理解し、設計判断・実装タスク列を .graphhopper/plans/<goal-id>.md に書く。source編集はここではブロックされる。書けたら task(subagent_type: 'graphhopper-critic') で設計を1回敵対レビューし、指摘を design.md に反映してから graphhopper_phase(phase: 'implementing') へ（任意で graphhopper_critic_set に結果を記録できる。opt-inでphase遷移の前提条件ではない）。design.md はこのフェーズを抜けた後は不変になる（verifierのdrift検出アンカーのため）——決定の経緯・棄却した代替案・進捗はここで固めず、実装中は .graphhopper/plans/<goal-id>.log.md に追記すること",
  implementing:
    "design.md のタスクを実装する。まず graphhopper_set_eval(cmd) で合否を機械判定できるコマンド（テスト/lint/typecheck）を1度設定せよ。設定後はターン終了ごとに自動実行され、passならpolishへ自動遷移、failならfail_streakが機械カウントされ、escalateが返ったら task(subagent_type: 'graphhopper-oracle') に相談する。eval_cmdが無い（機械判定できない）場合のみ graphhopper_attempt(ok, note) の自己申告にフォールバックする",
  polish:
    "graphhopper_router_check の route に従う。route=polish（大diff）ならまず simplify を実行する: メインが router.baseline_rev から diff を /tmp/gh-simplify-diff.txt に退避し、task(subagent_type: 'graphhopper-simplify') を1回呼んで提案を集める（3レンズ統合）。適用はメインが行う: 各 finding を Read で裏付け、critical は挙動不変・局所的なものだけ自動適用、high は人間確認、medium/note は報告のみ。適用後は eval_cmd を再実行して機械確認。route=advisor（小diff）なら simplify はスキップ。その後 verifier: route=polish なら requirement/behavior/progress の3charterで、route=advisor なら general charter で task(subagent_type: 'graphhopper-verifier') を呼び、結果を graphhopper_verifier_set で記録。集約 clean で graphhopper_phase(phase: 'done') へ。集約 drift かつ target=implementing なら implementing に戻る。advisor でも第三者チェック（verifier）は省略不可",
  done: "完了済み。graphhopper_goal(action: 'complete') を確認",
};

/* continuation（session.idle → promptAsync）のuser向け表示用の1行要約。
 * LLM向けの詳細指示は PHASE_ACTION のまま chat.system.transform 側で注入する
 * （design g-mtwhdb4t）。done は continuation 自体が発火しない（idle ハンドラが
 * phase==="done" で早期return）ため実質未使用だが、Record の型完全性のために残す。 */
const PHASE_ACTION_SHORT: Record<state.Phase, string> = {
  designing: "設計ドキュメントを書き、criticレビュー後にimplementingへ",
  implementing: "design.mdのタスクを実装し、eval_cmdを設定",
  polish: "router_checkのrouteに従いsimplify/verifierを実行",
  done: "goalをcompleteする",
};

/* idle 取得の窓と上限（design g-mtl7l8j3 T1/T2）。
 * TAIL_LIMIT: loop検知窓 (loop_tool_window=8) + echo 用履歴 + margin。
 * TAIL_STALE_MS: idle 直後なのに窓内最新がこれより古ければ、limit が末尾窓を
 *   返していないとみなす self-check 閾値。
 * MAX_FETCH_CHARS: 全件フォールバック時の上限。これ超は検知・dedupe スキップ。
 * NUDGE_EVERY: nudge 用の全文測定はこの idle 間隔に1回（間引き）。
 * oversizeSticky / idleTick はモジュール変数（state 汚染回避。プロセス共有の
 * ため混在時は厳しい判定が勝つ。compact 後は測定で回復する）。 */
const TAIL_LIMIT = 50;
const TAIL_STALE_MS = 10 * 60 * 1000;
const MAX_FETCH_CHARS = 2_000_000;
const NUDGE_EVERY = 10;
let oversizeSticky = false;
let idleTick = 0;

/** メッセージの生成時刻（欠損時は 0）。取得順の正規化用 */
function msgTime(m: state.SessionMessageLike): number {
  const t: unknown = (m.info as { time?: { created?: unknown } }).time
    ?.created;
  return typeof t === "number" ? t : 0;
}

function continuationText(goal: state.Goal, s: state.LoopState): string {
  return [
    `[graphhopper] Goal: "${goal.title}" | phase: ${s.phase}`,
    s.notes ? `notes: ${s.notes}` : null,
    s.eval_cmd ? `eval_cmd: ${s.eval_cmd}` : null,
    s.router.route
      ? `router: route=${s.router.route} diff_lines=${s.router.diff_lines}`
      : null,
    s.last_verifier
      ? `last_verifier: ${s.last_verifier.level} (${s.last_verifier.reason})`
      : null,
    s.fail_streak > 0 ? `fail_streak: ${s.fail_streak}` : null,
    `Next: ${PHASE_ACTION_SHORT[s.phase]}`,
    "フェーズのexit条件を満たしたら graphhopper_phase で遷移する。",
    "ブロックしたら回らずに理由を述べて停止。完了したら graphhopper_goal(complete)。無駄な空転は禁止。",
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveFilePath(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args))
    return undefined;
  const a = args as Record<string, unknown>;
  const raw = a["filePath"] ?? a["path"] ?? a["file_path"];
  return typeof raw === "string" ? raw : undefined;
}

export const Graphhopper: Plugin = async ({ client, $, directory }) => {
  const root = directory;

  return {
    config: async (input) => {
      injectAgents(input, root);
    },

    /* compact 連携（design g-mtl7l8j3 T3）: 要約に goal の意図を残す。
     * state は disk のためループ自体は compact を生き残るが、モデル側文脈の
     * goal 意図が要約落ちするのを防ぐ。prompt は置換しない。 */
    "experimental.session.compacting": async (_input, output) => {
      try {
        const active = state.getActive(root);
        if (!active || active.goal.status !== "active") return;
        output.context.push(
          [
            `[graphhopper] active goal: "${active.goal.title}" (${active.goal.id})`,
            `phase: ${active.state.phase}`,
            active.state.notes ? `notes: ${active.state.notes}` : null,
            active.state.eval_cmd ? `eval_cmd: ${active.state.eval_cmd}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch {
        // 要約を壊さないため例外は握りつぶす
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      output.system.push(SYSTEM_GUIDE);

      // ponytail ルールは implementing 中のみ・メインセッションのみに注入する。
      // 全ターン常時注入（ponytail のグローバルプラグイン挙動）は graphhopper の
      // 「必要な時だけ最小注入」思想と衝突するため、フェーズ + sessionID でゲートする。
      // 注記: graphhopper_phase(implementing) を呼ぶターン自体はプロンプト組み立て済みで
      // 注入されない。注入は次ターンから（session.idle → continuation → 新ターン）。
      const active = state.getActive(root);

      // continuation（user向け表示）はSHORT要約のみ。LLM向けの詳細指示は
      // ここで system prompt に注入する（design g-mtwhdb4t）。PONYTAILゲートと
      // 同型の4条件 + phase!=="done"（done後はcontinuation自体が発火しないため不要）。
      if (
        active &&
        active.goal.status === "active" &&
        active.state.phase !== "done" &&
        input.sessionID &&
        input.sessionID === active.state.session_id
      ) {
        output.system.push(
          `## graphhopper 次のアクション（詳細）\n\n${PHASE_ACTION[active.state.phase]}`,
        );
      }

      if (
        active &&
        active.goal.status === "active" &&
        active.state.phase === "implementing" &&
        input.sessionID &&
        input.sessionID === active.state.session_id
      ) {
        output.system.push(PONYTAIL_RULES);
      }
    },

    /* ================================================================ *
     * C-2不変条件: designing フェーズで source 編集を物理ブロックする
     * Claude Code の hooks/design-gate.sh (PreToolUse) 相当
     * ================================================================ */
    "tool.execute.before": async (input, output) => {
      const toolName = input.tool?.toLowerCase();
      if (toolName !== "write" && toolName !== "edit") return;

      const active = state.getActive(root);
      if (!active) return;
      const cfg = state.readConfig(root);
      const filePath = resolveFilePath(
        (output as { args?: unknown } | undefined)?.args,
      );
      if (!filePath) return;

      if (state.isDesignGateBlocked(root, cfg, active.state.phase, filePath)) {
        state.recordEvent(root, {
          type: "design_gate_block",
          goal: active.goal.id,
          tool: toolName,
          path: filePath,
        });
        throw new Error(
          `Refused: ${toolName} to ${filePath} is blocked because the goal is in the "designing" phase. ` +
            `Only paths under ${cfg.design_gate_allow.join(", ")} may be written while designing. ` +
            `Write the design doc first, then graphhopper_phase(phase: "implementing") before editing source.`,
        );
      }

      /* design doc不変化: designing終了後はdesign doc自体への書き込みも常にブロックする
       * （verifierのdrift検出アンカーを守るため。graphhopper本体との対応関係を参照） */
      if (
        state.isDesignDocLocked(root, active.state.phase, active.goal.id, filePath)
      ) {
        state.recordEvent(root, {
          type: "design_doc_locked_block",
          goal: active.goal.id,
          tool: toolName,
          path: filePath,
        });
        throw new Error(
          `Refused: ${toolName} to ${filePath} is blocked because the design doc is immutable once the "designing" phase ends ` +
            `(it anchors verifier drift detection — rewriting it to match the implementation would let drift be erased by editing the doc instead of fixing the code). ` +
            `Record decisions/rejected alternatives/progress in .graphhopper/plans/${active.goal.id}.log.md instead (no gate on that path).`,
        );
      }
    },

    /* 信号A: 同一ファイル再編集の計数。成功した edit/write のみ数えるため
     * after フックを使う（before は design gate のブロック判定専用）。
     * args は input 側にある点に注意（before と非対称）。 */
    "tool.execute.after": async (input) => {
      try {
        const toolName = input.tool?.toLowerCase();
        if (toolName !== "write" && toolName !== "edit") return;

        const active = state.getActive(root);
        if (!active || active.goal.status !== "active") return;
        if (active.state.phase !== "implementing") return;
        if (!input.sessionID || input.sessionID !== active.state.session_id)
          return;
        const filePath = resolveFilePath(input.args);
        if (!filePath) return;
        state.noteEdit(root, filePath);
      } catch {
        // 計数失敗で編集自体を壊さない
      }
    },

    tool: {
      graphhopper_goal: tool({
        description:
          "graphhopper の goal を管理する。start=新規 goal でループ開始、pause/resume=一時停止/再開、complete=完了（要直近 verifier clean）、clear=状態リセット",
        args: {
          action: tool.schema.enum([
            "start",
            "pause",
            "resume",
            "complete",
            "clear",
          ]),
          title: tool.schema
            .string()
            .optional()
            .describe("action=start のとき必須。goal の題名"),
          force: tool.schema
            .boolean()
            .optional()
            .describe(
              "complete 時に verifier 未clearでも強制完了する、または resume 時に loop_stop_max のブロックを明示的に無視する（人間の判断が見える場合のみ。監査ログに loop_resume_forced が記録される）",
            ),
        },
        async execute(args, ctx) {
          switch (args.action) {
            case "start": {
              if (!args.title) return "error: title is required for start";
              const active = state.getActive(root);
              if (active && active.goal.status === "active") {
                return `error: goal "${active.goal.title}" is already active. complete or pause it first.`;
              }
              const a = state.startGoal(root, args.title, ctx.sessionID);
              return `goal started: "${a.goal.title}" (${a.goal.id})\nphase: designing\n次: ${PHASE_ACTION.designing}`;
            }
            case "pause": {
              const a = state.pauseGoal(root);
              return a ? `paused: "${a.goal.title}"` : "no active goal";
            }
            case "resume": {
              if (state.isResumeBlocked(root) && !args.force) {
                const s = state.getActive(root);
                const max = state.readConfig(root).loop_stop_max;
                const count = s?.state.loop_stop_count ?? 0;
                return (
                  `error: このgoalはループ検知による自動停止が loop_stop_max（${max}）回に達したため resume がブロックされています（現在 ${count}回）。` +
                  "人間が原因を確認して graphhopper_goal(action: 'clear') でリセットするか、明示的に resume を続行する場合のみ force: true を使ってください（監査ログに loop_resume_forced が記録されます）。"
                );
              }
              const a = state.resumeGoal(root, ctx.sessionID, args.force);
              return a
                ? `resumed: "${a.goal.title}" | phase: ${a.state.phase}${args.force ? " (forced)" : ""}`
                : "no active goal";
            }
            case "complete": {
              const a = state.getActive(root);
              if (!a) return "no active goal";
              // self-graded done 禁止: 直近の verifier clean を機械要求する（drift残りの完了を防ぐ）
              if (!args.force && a.state.last_verifier?.level !== "clean") {
                return (
                  "error: complete には直近の graphhopper_verifier_set（集約 clean）が必要です（self-graded 完了は禁止）。" +
                  "小diffで verifier fan-out が不要なら、人間の明示的な判断がある場合のみ force: true を使ってください。"
                );
              }
              const done = state.completeGoal(root);
              return done
                ? `completed: "${done.goal.title}"${args.force ? " (forced)" : ""}`
                : "no active goal";
            }
            case "clear": {
              // clear は完了ではないため completeGoal を使わない
              // （goal_complete イベントを監査ログに残さない。state.clearActiveGoal）
              state.clearActiveGoal(root);
              state.unbindSession(root, ctx.sessionID);
              return "cleared";
            }
          }
        },
      }),

      graphhopper_status: tool({
        description:
          "graphhopper の現在状態（goal・フェーズ・router・verifier・critic_review）を表示する",
        args: {},
        async execute() {
          const a = state.getActive(root);
          if (!a) return "no active goal";
          return [
            `goal: "${a.goal.title}" (${a.goal.id}) [${a.goal.status}]`,
            `phase: ${a.state.phase}`,
            `session: ${a.state.session_id ?? "unbound"}`,
            a.state.router.route
              ? `router: route=${a.state.router.route} diff_lines=${a.state.router.diff_lines} checked_at=${a.state.router.checked_at}`
              : "router: (not checked)",
            a.state.last_verifier
              ? `last_verifier: level=${a.state.last_verifier.level} target=${a.state.last_verifier.target ?? "-"} lens=${a.state.last_verifier.lens.join(",") || "-"} reason=${a.state.last_verifier.reason}`
              : "last_verifier: (none)",
            a.state.critic_review
              ? `critic_review: level=${a.state.critic_review.level} reason=${a.state.critic_review.reason}`
              : "critic_review: (none, opt-in)",
            `fail_streak: ${a.state.fail_streak}`,
            `loop: stop_count=${a.state.loop_stop_count}/${state.readConfig(root).loop_stop_max} resume_blocked=${state.isResumeBlocked(root)} streak=${a.state.loop_streak}`,
            a.state.notes ? `notes: ${a.state.notes}` : null,
            state.planLogExists(root, a.goal.id)
              ? `log: .graphhopper/plans/${a.goal.id}.log.md`
              : null,
            `updated: ${a.state.updated_at}`,
          ]
            .filter(Boolean)
            .join("\n");
        },
      }),

      graphhopper_phase: tool({
        description:
          "graphhopper のフェーズを遷移させる。遷移前にそのフェーズの exit 条件を満たしていること",
        args: {
          phase: tool.schema.enum(state.PHASES),
          notes: tool.schema
            .string()
            .optional()
            .describe("中断・再開用メモ（どこまでやったか）"),
        },
        async execute(args) {
          const a = state.setPhase(root, args.phase, args.notes);
          if (!a) return "error: no active goal or invalid phase";
          return `phase -> ${a.state.phase}\n次: ${PHASE_ACTION[a.state.phase]}`;
        },
      }),

      /* ============================================================ *
       * eval_cmd（graphhopper本体のeval_cmd相当）: implementingの合否を
       * 自己申告ではなくコマンド実行のexit codeで機械判定する。
       * ============================================================ */
      graphhopper_set_eval: tool({
        description:
          "implementingの合否を機械判定するコマンド（テスト/lint/typecheck等）を設定する。設定後はsession.idle（ターン終了）ごとに自動実行され、pass=polishへ自動遷移・fail=fail_streak機械カウントになる。graphhopper_attemptの自己申告より優先される",
        args: {
          cmd: tool.schema
            .string()
            .describe(
              "実行するシェルコマンド（例: 'npx tsc --noEmit && npm test'）。空文字で解除",
            ),
        },
        async execute(args) {
          const active = state.getActive(root);
          if (!active) return "error: no active goal";
          state.setEvalCmd(root, args.cmd);
          return args.cmd
            ? `eval_cmd set: ${args.cmd}\n次のターン終了時から自動実行される。`
            : "eval_cmd cleared. graphhopper_attemptの自己申告にフォールバックする。";
        },
      }),

      /* ============================================================ *
       * stuck escalation: diffサイズ（router gate）とは別軸のタイミング判断。
       * 「詰まった回数」を機械カウントし、閾値超で上位モデル(oracle)を促す
       * ============================================================ */
      graphhopper_attempt: tool({
        description:
          "implementingでの実装試行の成否を記録する（graphhopper_set_evalでeval_cmdを設定していない場合の自己申告フォールバック。eval_cmd設定済みなら自動実行されるのでこのツールは不要）。連続失敗がstuck_threshold（既定3）に達したら escalate=true を返し、graphhopper-oracleへの相談を促す。okな試行やphase遷移でfail_streakはリセットされる",
        args: {
          ok: tool.schema
            .boolean()
            .describe(
              "この試行は成功したか（テストが通った・目的の変更が完了した等）",
            ),
          note: tool.schema
            .string()
            .describe(
              "何を試して何が起きたか（失敗時はoracleに渡る文脈になる）",
            ),
        },
        async execute(args) {
          const active = state.getActive(root);
          if (!active) return "error: no active goal";
          const r = state.recordAttempt(root, args.ok, args.note);
          if (args.ok) return "attempt recorded: ok (fail_streak reset to 0)";
          // attempt 経路の giveUp も eval 経路と同型に pause + イベントまで
          // 配線する（通知 promptAsync は不要＝戻り値テキストで伝わる）。
          if (r.giveUp) {
            const paused = state.pauseGoal(root);
            if (paused) {
              state.recordEvent(root, {
                type: "eval_gave_up",
                goal: paused.goal.id,
                fail_streak: r.fail_streak,
              });
            }
            return [
              `attempt recorded: fail (fail_streak=${r.fail_streak})`,
              `giveUp: true — 連続失敗が上限に達したため goal を pause した。修正して graphhopper_goal(action: 'resume') で再開せよ（fail_streak は 0 に戻る）。`,
            ].join("\n");
          }
          if (r.escalate) {
            return [
              `attempt recorded: fail (fail_streak=${r.fail_streak})`,
              "escalate: true",
              "次: task(subagent_type: 'graphhopper-oracle') に相談せよ。これまでの失敗試行（何を試して何が起きたか）を渡すこと。",
            ].join("\n");
          }
          // 新信号でも同じ提案を出す（r.escalate 優先の else-if で重複回避）。
          // fail 時のみ。pause 等はしない提案文だけ。
          const stuck = state.checkStuck(root);
          if (stuck.escalate && state.noteStuckNotified(root, stuck.reasons)) {
            return [
              `attempt recorded: fail (fail_streak=${r.fail_streak})`,
              `escalate: true (stuck: ${stuck.reasons.join(", ")})`,
              "次: task(subagent_type: 'graphhopper-oracle') に相談せよ。これまでの失敗試行・編集履歴を渡すこと。",
            ].join("\n");
          }
          return `attempt recorded: fail (fail_streak=${r.fail_streak})\nescalate: false`;
        },
      }),

      /* ============================================================ *
       * router gate（loop-driver.sh相当）: diffサイズでadvisor/polishに分岐
       * ============================================================ */
      graphhopper_router_check: tool({
        description:
          "diffサイズを機械測定してrouteを決める。route=advisor（小diff・graphhopper-verifierを1回だけ呼ぶ）/ route=polish（大diff・3charterでverifier fan-out）。implementing完了時、polishフェーズに入る前に呼ぶ。self-graded完了防止のため、advisorでも第三者チェック（verifier呼び出し）は省略できない",
        args: {},
        async execute() {
          const active = state.getActive(root);
          if (!active) return "error: no active goal";
          const cfg = state.readConfig(root);
          const baseline =
            active.state.router.baseline_rev ??
            (await state.captureBaselineRev($, root));
          const diffLines = await state.measureDiffLines($, root, baseline);
          const route: state.RouterRoute =
            diffLines > cfg.router_threshold_lines ? "polish" : "advisor";
          state.recordRouterCheck(root, baseline, diffLines, route);
          return [
            `diff_lines: ${diffLines} (threshold: ${cfg.router_threshold_lines})`,
            `route: ${route}`,
            route === "polish"
              ? "次: task(subagent_type: 'graphhopper-verifier') をrequirement/behavior/progressの3charterで呼び、graphhopper_verifier_setで記録する"
              : "次: task(subagent_type: 'graphhopper-verifier') を1回、'general'charter（3観点を統合したレビュー）で呼び、graphhopper_verifier_set(results: [{lens: 'general', level}])で記録する（自己レビューだけでの完了は不可）",
          ].join("\n");
        },
      }),

      graphhopper_verifier_set: tool({
        description:
          "polish/advisorのverifier結果を記録する。各charterの結果をresultsに詰めるとlevel/targetは機械集約される（drift かつ target=implementing なら implementing に巻き戻し可能。target=design/requirementsは人間のhand-back待ち）。self-graded完了防止のため、resultsが空（=task(graphhopper-verifier)を一度も呼んでいない）場合はエラーになる",
        args: {
          results: tool.schema
            .array(
              tool.schema.object({
                lens: tool.schema.enum([
                  "requirement",
                  "behavior",
                  "progress",
                  "general",
                ]),
                level: tool.schema.enum(["clean", "drift"]),
                target: tool.schema
                  .enum(["implementing", "design", "requirements"])
                  .optional()
                  .describe(
                    "drift時の巻き戻し先（level=drift なら必須）。clean時は不要",
                  ),
              }),
            )
            .describe(
              "実際にtask(graphhopper-verifier)を呼んで得た各charterの結果。route=advisorならgeneral 1件、route=polishならrequirement/behavior/progressの3件。level/targetの最終決定は機械集約（state.aggregateVerdicts）で行う",
            ),
          reason: tool.schema
            .string()
            .describe(
              "集約結果の要約（1〜3文。監査証跡のため必須）。採用基準自体は機械集約される",
            ),
        },
        async execute(args) {
          const results = (args.results ?? []) as state.VerifierResult[];
          const rejected = state.checkVerifierResults(results);
          if (rejected) return rejected;
          const decided = state.aggregateVerdicts(results);
          const result = state.setVerifierVerdict(root, {
            level: decided.level,
            reason: args.reason,
            target: decided.target,
            lens: results.map((r) => r.lens),
          });
          if (result.last_verifier?.level === "clean") {
            return "verifier verdict: clean\ngraphhopper_phase(phase: 'done') で完了に進める。";
          }
          return [
            `verifier verdict: drift -> ${decided.target}`,
            `reason: ${args.reason}`,
            `lens: ${results.map((r) => `${r.lens}=${r.level}`).join(",")}`,
            decided.target === "implementing"
              ? "次: graphhopper_phase(phase: 'implementing') で巻き戻し"
              : "次: 人間の hand-back を待つ（design/requirementsは自動で戻らない）",
          ].join("\n");
        },
      }),

      /* ============================================================ *
       * design.md質レビュー（graphhopper-critic）の記録。opt-in・ハードゲート無し。
       * verifier_setのようなresults空拒否（self-graded防止）は付けない——design時点では
       * 客観的な閾値が存在せず、ゲート化すると「薄く書いて回避する」自己判断エロージョンを
       * 再生産するだけのため。呼ぶかどうかはメインエージェントの裁量（graphhopper本体の
       * design-set / ROADMAP.md の判断を参照）。
       * ============================================================ */
      graphhopper_critic_set: tool({
        description:
          "designing終了前のdesign.md質レビュー結果（clean/drift）を記録する（opt-in、graphhopper_phaseの前提条件にはしない）。graphhopper-criticを呼んだかどうかに関わらず記録できる——self-graded防止は行わない",
        args: {
          level: tool.schema.enum(["clean", "drift"]),
          reason: tool.schema
            .string()
            .describe(
              "critic reviewの結果の根拠、またはcriticを呼ばなかった判断理由を1〜3文で",
            ),
        },
        async execute(args) {
          const result = state.setCriticVerdict(root, {
            level: args.level,
            reason: args.reason,
          });
          return `critic review recorded: ${args.level}. phase: ${result.phase}`;
        },
      }),

      /* ============================================================ *
       * discover（loop-until-dry）: phase graphの外にあるオンデマンド探索。
       * round cap / dedupeはtool側（state.tickDiscover）が機械的に強制する。
       * ============================================================ */
      graphhopper_discover_start: tool({
        description:
          "loop-until-dry探索を開始する。件数が事前に分からない探索タスク（バグ探し・セキュリティ監査・網羅的レビュー）に使う。phase graphには影響しない",
        args: {
          target: tool.schema
            .string()
            .describe(
              "何を探すか（例: 認証チェック漏れ、エラー握り潰し、境界値バグ）",
            ),
          scope: tool.schema
            .string()
            .describe("どこを探すか（パスglob、モジュール名）"),
        },
        async execute(args) {
          const s = state.startDiscover(root, args.target, args.scope);
          return [
            `discover started: target="${s.target}" scope="${s.scope}"`,
            "次: task(subagent_type: 'graphhopper-researcher') を broad-scan/semantic-read/edge-case の3charterで並列に呼び、",
            "結果を graphhopper_discover_tick に渡す。stopped_reasonがnullの間、繰り返す。",
          ].join("\n");
        },
      }),

      graphhopper_discover_tick: tool({
        description:
          "1ラウンド分のfindingsを渡し、既見全体（reject/未採用も含む）に対してdedupeする。round cap（既定8）とdry判定（2連続新規0で停止）をここで機械的に強制する",
        args: {
          findings: tool.schema
            .array(
              tool.schema.object({
                title: tool.schema.string(),
                severity: tool.schema.enum([
                  "critical",
                  "high",
                  "medium",
                  "low",
                ]),
                confidence: tool.schema.number(),
                quote: tool.schema.string(),
              }),
            )
            .describe(
              "このラウンドで見つかった全件（新規・既知問わず。tool側でdedupeする）",
            ),
        },
        async execute(args) {
          const s = state.tickDiscover(root, args.findings);
          if (s.stopped_reason) {
            return [
              `stopped: ${s.stopped_reason} (round ${s.round}, ${s.stopped_reason === "max_rounds" ? "上限で打ち切り" : "自然に尽きた"})`,
              `confirmed: ${s.confirmed.length}件`,
              JSON.stringify(s.confirmed, null, 2),
            ].join("\n");
          }
          return `round ${s.round} 完了。dry_streak=${s.dry_streak}, seen=${s.seen.length}件。次のラウンドへ`;
        },
      }),

      graphhopper_discover_clear: tool({
        description: "discoverセッションをクリアする",
        args: {},
        async execute() {
          state.clearDiscover(root);
          return "cleared";
        },
      }),

      /* ============================================================ *
       * handoff: 別セッションへ goal 状態を引き継ぎ送信する
       * ============================================================ */
      graphhopper_handoff: tool({
        description:
          "現在の active goal の状態を要約して、別の opencode セッションへ引き継ぎとして送信する（Claude Code の cross-session messaging / SendMessage 相当）。送信後は送信側が goal から解放される（pause + unbind）。session_id 未指定なら候補セッションを列挙する（送信しない）。受け手は内容を読んで graphhopper_resume で引き継ぐ運用",
        args: {
          session_id: tool.schema
            .string()
            .optional()
            .describe(
              "送信先セッションID。送信時は必須。省略時は候補一覧のみ返す",
            ),
          note: tool.schema
            .string()
            .optional()
            .describe("送信メッセージに追記する任意の補足"),
        },
        async execute(args, ctx) {
          const active = state.getActive(root);
          if (!active) return "error: no active goal";

          if (!args.session_id) {
            // 候補列挙のみ（送信しない）
            const sessions = await client.session.list({
              query: { directory: root },
            });
            const candidates = (sessions.data ?? [])
              .filter(
                (s) =>
                  s.id !== ctx.sessionID && s.directory === root && !s.parentID,
              )
              .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
            if (candidates.length === 0) {
              return "error: 候補セッションなし（同じディレクトリのメインセッションで自分以外が無い）";
            }
            return [
              "handoff 候補セッション（同じディレクトリ・メインセッション・自分以外、updated 降順）:",
              "※ 一覧には exit 済み（TUI を閉じた）セッションも含まれる。受け手が「開いている」ものへ送ること。",
              "",
              ...candidates.map(
                (s) =>
                  `- ${s.id} | ${s.title || "(untitled)"} | updated: ${
                    s.time?.updated
                      ? new Date(s.time.updated).toISOString()
                      : "?"
                  }`,
              ),
              "",
              "送信するには graphhopper_handoff(session_id: '<ID>') を呼べ。送信後はこのセッションの goal が解放される（pause + unbind）。",
            ].join("\n");
          }

          // 送信時
          if (args.session_id === ctx.sessionID) {
            return "error: 自分自身への handoff は禁止（ループ防止）";
          }
          let target;
          try {
            target = await client.session.get({
              path: { id: args.session_id },
            });
          } catch (e) {
            return `error: session get failed: ${
              e instanceof Error ? e.message : String(e)
            }`;
          }
          if (!target.data) {
            return `error: session ${args.session_id} not found`;
          }
          if (target.data.parentID) {
            return `error: session ${args.session_id} は subagent なので handoff 先にできない`;
          }

          const s = active.state;
          const text = [
            "## graphhopper handoff",
            "",
            `受け取った goal を引き継いで続行せよ。`,
            `これは1回限りの handoff であり、さらに他セッションへ転送しないこと。`,
            `続行には graphhopper_resume で goal を再バインドしてから実施せよ。`,
            "",
            `- goal: "${active.goal.title}" (${active.goal.id}) [${active.goal.status}]`,
            `- phase: ${s.phase}`,
            `- notes: ${s.notes || "(none)"}`,
            `- fail_streak: ${s.fail_streak}`,
            `- loop: stop_count=${s.loop_stop_count}/${state.readConfig(root).loop_stop_max} resume_blocked=${state.isResumeBlocked(root)}`,
            `- eval_cmd: ${s.eval_cmd || "(none)"}`,
            s.router.route
              ? `- router: route=${s.router.route} diff_lines=${s.router.diff_lines}`
              : null,
            s.last_verifier
              ? `- last_verifier: ${s.last_verifier.level} (${s.last_verifier.reason})`
              : null,
            s.critic_review
              ? `- critic_review: ${s.critic_review.level} (${s.critic_review.reason})`
              : "- critic_review: (none, opt-in)",
            `- design doc: .graphhopper/plans/${active.goal.id}.md（designing終了後は不変）`,
            state.planLogExists(root, active.goal.id)
              ? `- log: .graphhopper/plans/${active.goal.id}.log.md（決定の経緯・棄却した代替案・進捗）`
              : null,
            `- 送信元 session: ${ctx.sessionID} | state updated: ${s.updated_at}`,
            `- 次のアクション: ${PHASE_ACTION[s.phase]}`,
            args.note ? `- 補足: ${args.note}` : null,
            "",
            `引き継いだら「handoff received: ${active.goal.id}」と返信せよ。`,
          ]
            .filter(Boolean)
            .join("\n");

          await client.session.promptAsync({
            path: { id: args.session_id },
            body: {
              parts: [{ type: "text", text }],
            },
          });

          // 送信成功後、送信側を goal から解放する（二重駆動レース防止）
          state.pauseGoal(root);
          state.unbindSession(root, ctx.sessionID);
          return [
            `handoff sent to ${args.session_id}: "${active.goal.title}" (${active.goal.id})`,
            "送信側の goal は解放された（pause + unbind）。受け手が graphhopper_resume で引き継ぐ。",
          ].join("\n");
        },
      }),
    },

    event: async ({ event }) => {
      try {
        if (event.type === "session.deleted") {
          state.unbindSession(root, event.properties.info.id);
          return;
        }
        if (event.type !== "session.idle") return;

        const sessionID = event.properties.sessionID;
        let active = state.getActive(root);
        if (!active) return;
        if (active.goal.status !== "active") return;
        if (active.state.phase === "done") return;
        if (active.state.session_id !== sessionID) return;

        /* session.messages の取得戦略（design g-mtl7l8j3 T1/T2）。
         * - 通常: 末尾 TAIL_LIMIT 件のみ（time.created 昇順に正規化）。
         * - サンプリング turn（NUDGE_EVERY に1回）: 全文1本のみ。nudge 測定と
         *   sticky からの回復確認を兼ね、検知にもそのまま使う。
         * - self-check: idle 直後なのに窓内最新が古ければ limit が末尾窓を
         *   返していないとみなし、全件にフォールバック（上限付き）。
         * - 全件が MAX_FETCH_CHARS 超なら oversizeSticky を立て、検知・dedupe
         *   をスキップして注入継続（駆動を止めない）。回復はサンプリングで。
         * いずれも idle あたり fetch は1本（g-mtl65slm T5 の不変条件を維持）。 */
        let idleMsgs: state.SessionMessageLike[] | null = null;
        let measuredSize: number | null = null;
        const orderMsgs = (arr: state.SessionMessageLike[]) =>
          [...arr].sort((a, b) => msgTime(a) - msgTime(b));
        const classifyFull = (all: state.SessionMessageLike[]) => {
          const size = JSON.stringify(all).length;
          measuredSize = size;
          if (size > MAX_FETCH_CHARS) {
            oversizeSticky = true;
            return null;
          }
          oversizeSticky = false;
          return orderMsgs(all);
        };
        try {
          // nudge 済み・非 sticky なら測定不要のためサンプリング自体を省く
          const needMeasure =
            !active.state.handoff_nudged || oversizeSticky;
          const sampling =
            needMeasure && idleTick % NUDGE_EVERY === 0;
          if (oversizeSticky && !sampling) {
            // 巨大確定中は取得自体を省く（eval・注入は継続）
            idleMsgs = null;
          } else if (sampling || oversizeSticky) {
            const res = await client.session.messages({
              path: { id: sessionID },
            });
            idleMsgs = classifyFull(
              (res.data ?? []) as state.SessionMessageLike[],
            );
          } else {
            const res = await client.session.messages({
              path: { id: sessionID },
              query: { limit: TAIL_LIMIT },
            });
            const msgs = orderMsgs(
              (res.data ?? []) as state.SessionMessageLike[],
            );
            const newest =
              msgs.length > 0 ? msgTime(msgs[msgs.length - 1]!) : 0;
            if (
              msgs.length >= TAIL_LIMIT &&
              Date.now() - newest > TAIL_STALE_MS
            ) {
              // limit が先頭N等、末尾窓になっていない → 全件で取り直す
              const full = await client.session.messages({
                path: { id: sessionID },
              });
              idleMsgs = classifyFull(
                (full.data ?? []) as state.SessionMessageLike[],
              );
            } else {
              oversizeSticky = false;
              idleMsgs = msgs;
            }
          }
        } catch {
          // メッセージ取得失敗は検知をスキップ（駆動を止めない）
        }
        idleTick++;

        /* ================================================================ *
         * 無限ループ検知（echoループ + 同一tool call反復）: assistant出力がそのまま
         * 次のuser入力にミラーされる、または同じtool callを繰り返すと session.idle が
         * 連続発火し、自動継続が延々回る。検知して loop_stop_threshold（echo無効時は
         * loop_tool_repeat_threshold）回連続したら goal を pause して自動継続を止める。
         * ================================================================ */
        {
          const cfg = state.readConfig(root);
          const echoEnabled = cfg.loop_stop_threshold > 0;
          const toolEnabled = cfg.loop_tool_repeat_threshold > 1;
          if (idleMsgs !== null && (echoEnabled || toolEnabled)) {
            const { detected, kind } = state.detectLoopKind(idleMsgs, cfg);
            const loop = state.updateLoopDetection(root, detected, kind);
            if (loop.stopped) {
              if (loop.justStopped) {
                state.stopLoopByPause(root);
                console.warn(
                  "graphhopper: infinite loop detected (kind=%s streak=%d). paused goal=%s to stop auto-continuation",
                  kind,
                  loop.streak,
                  active.goal.id,
                );
                // モデルに知らせて同じ応答の折り返しを止めさせる（1回だけ）
                try {
                  await client.session.promptAsync({
                    path: { id: sessionID },
                    body: {
                      parts: [
                        {
                          type: "text",
                          text: "[graphhopper] 無限ループ（echo または同一tool callの反復）を検知したため自動継続を停止しました（goal は pause）。以後、同じ応答・同じtool callの繰り返しには応答せず、新しい実際の作業指示を待ってください。",
                        },
                      ],
                    },
                  });
                } catch {
                  // 通知失敗でも停止は成立している
                }
              }
              return;
            }
          }
        }

        let evalNote: string | null = null;

        /* 継続注入 dedupe（空転ループ対策）: 前回注入以降に進展が無ければ
         * 注入も eval 再実行もスキップして黙って戻る。進展の定義は
         * state.continuationFingerprint（人間入力・tool 実行・phase・
         * eval_cmd・直近 eval 結果）で、assistant の言い換え待機 ack だけでは
         * 進展にならない。そのため「deny → 待機 → 注入 → 待機 …」の空転が
         * echo 検知（文面一致・閾値6回）を待たずに1往復で止まる。
         * 取得失敗時（idleMsgs === null）は注入継続（駆動を止めない）。 */
        if (idleMsgs !== null) {
          const marker = state.continuationFingerprint(
            idleMsgs,
            active.state.phase,
            active.state.eval_cmd,
            active.state.last_eval_fingerprint,
          );
          if (
            active.state.last_continuation_marker !== null &&
            active.state.last_continuation_marker === marker
          ) {
            if (active.goal.id) {
              state.recordEvent(root, {
                type: "continuation_skipped",
                goal: active.goal.id,
                marker,
              });
            }
            return;
          }
        }

        /* eval_cmd（Metric）: implementing中でeval_cmd設定済みなら自己申告に依存せず
         * ターンごとに機械実行する。graphhopper本体のloop-driver.shが毎Stop hookで
         * eval_cmdを実行する挙動と同じ */
        if (active.state.phase === "implementing" && active.state.eval_cmd) {
          const cmd = active.state.eval_cmd;
          const result = await state.runEval($, root, cmd);
          const tail = result.output.split("\n").slice(-20).join("\n");
          // eval 結果のフィンガープリントを記録（同一失敗の再注入を抑止し、
          // 結果変化での注入再開を判定する材料。dedupe 用）
          state.noteEvalFingerprint(root, `${result.ok}:${state.fnv1a(tail)}`);
          // state.notesにはtail済みの短い文字列だけを残す（全文を永続化しない）
          const r = state.recordAttempt(
            root,
            result.ok,
            result.ok ? "" : `eval failed: ${cmd}`,
          );
          // 信号B: ワーキングコピー差分の停滞を測る（eval 成否問わず。
          // ok 時は recordAttempt が stall を 0 にしているため、ここでは
          // 変化比較だけ行う。測定不能時は現状維持）
          const wcLines = await state.measureWorkingCopyLines($, root);
          if (wcLines !== null) state.noteDiffLines(root, wcLines);
          if (active.goal.id)
            state.recordEvent(root, {
              type: "eval_run",
              goal: active.goal.id,
              ok: result.ok,
              fail_streak: r.fail_streak,
            });
          if (result.ok) {
            const baseline =
              active.state.router.baseline_rev ??
              (await state.captureBaselineRev($, root));
            const diffLines = await state.measureDiffLines($, root, baseline);
            if (baseline === null) {
              // baseline 取得失敗（jj/git エラー）: diff 0 として advisor route で polish へ進む。
              // simplify の入力 diff は空になるが整理対象が無いのでスキップ扱いになる
              // （実装未着手の diff=0 とは区別して滞留させない）
              state.recordRouterCheck(root, baseline, 0, "advisor");
              state.setPhase(root, "polish");
              evalNote = `eval_cmd passed but baseline not captured — polishへ進む（simplifyはスキップ、verifierで検証）: ${cmd}`;
            } else if (diffLines > 0) {
              // route を機械決定して baseline_rev + route を記録してから polish へ
              // （simplify が router.baseline_rev を参照するため null のままにしない）
              const cfg = state.readConfig(root);
              const route: state.RouterRoute =
                diffLines > cfg.router_threshold_lines ? "polish" : "advisor";
              state.recordRouterCheck(root, baseline, diffLines, route);
              state.setPhase(root, "polish");
              evalNote = `eval_cmd passed (diff ${diffLines} lines since baseline): ${cmd}`;
            } else {
              state.recordRouterCheck(root, baseline, 0, "advisor");
              evalNote = `eval_cmd passed but diff_lines=0 since baseline — まだ何も実装していない。polishへは進めない。実装を進めよ: ${cmd}`;
            }
          } else if (r.giveUp) {
            // リトライ上限: 無限の eval 失敗駆動を止める。loop 停止と同型の
            // pause + 1回通知。loop_stop_count は消費しない（pauseGoal 直使い。
            // eval 壊れと echo ループの混線を避ける。design g-mtl8vjnc T1）。
            const paused = state.pauseGoal(root);
            if (paused) {
              state.recordEvent(root, {
                type: "eval_gave_up",
                goal: paused.goal.id,
                fail_streak: r.fail_streak,
              });
              console.warn(
                "graphhopper: eval_cmd failed %d times in a row. paused goal=%s to stop auto-continuation",
                r.fail_streak,
                paused.goal.id,
              );
              try {
                await client.session.promptAsync({
                  path: { id: sessionID },
                  body: {
                    parts: [
                      {
                        type: "text",
                        text: `[graphhopper] eval_cmd が ${r.fail_streak} 回連続失敗したため自動継続を停止しました（goal は pause）。eval を修正してから graphhopper_goal(action: 'resume') で再開してください（fail_streak は resume 時に 0 に戻ります）。\n${cmd}\n${tail}`,
                      },
                    ],
                  },
                });
              } catch {
                // 通知失敗でも停止は成立している
              }
            }
            return;
          } else {
            // 新信号 (edit_repeat/diff_stall) でも r.escalate と同じ提案を出す。
            // 重複時は1回のみ（r.escalate 優先の else-if）。giveUp が最優先で
            // 先に処理済みのためここには来ない。
            let stuckLine = "";
            if (r.escalate) {
              stuckLine =
                "escalate: task(subagent_type: 'graphhopper-oracle') に相談せよ。";
            } else {
              const stuck = state.checkStuck(root);
              if (
                stuck.escalate &&
                state.noteStuckNotified(root, stuck.reasons)
              ) {
                stuckLine = `stuck: ${stuck.reasons.join(", ")} — task(subagent_type: 'graphhopper-oracle') に相談せよ。これまでの失敗試行・編集履歴を渡すこと。`;
              }
            }
            evalNote = [
              `eval_cmd FAILED (fail_streak=${r.fail_streak}): ${cmd}`,
              tail,
              stuckLine,
            ]
              .filter(Boolean)
              .join("\n");
          }
          active = state.getActive(root);
          if (!active) return;
        }

        /* handoff一度きり通知: 会話サイズ（session.messagesのJSON文字数、transcriptサイズの
         * 代理指標）が閾値を超えたら知らせる。対応必須ではないため、doneには持ち込まない
         * （dedupで無限ループ化を防ぐ。graphhopper本体 hooks/loop-driver.sh 参照）。
         * サイズはサンプリング turn の全文測定値を使い回す（測定の無い turn・
         * fetch失敗時はスキップ。最大 NUDGE_EVERY-1 idle の遅延）。 */
        let handoffNote: string | null = null;
        if (!active.state.handoff_nudged && measuredSize !== null) {
          const cfg = state.readConfig(root);
          if (measuredSize >= cfg.handoff_nudge_chars) {
            state.setHandoffNudged(root, measuredSize);
            handoffNote = `graphhopper: 会話が大きくなっています（推定サイズ${measuredSize}文字・閾値${cfg.handoff_nudge_chars}文字）。対応必須ではありません。必要なら graphhopper_handoff で別セッションへ引き継げます（このgoalでは1回だけの通知）。`;
          }
        }

        active = state.getActive(root);
        if (!active) return;

        await client.session.promptAsync({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: "text",
                text: [
                  // 先頭マーカーで人間入力と区別する（tool 反復検知の
                  // ウィンドウが自前注入でリセットされるのを防ぐ）
                  state.CONTINUATION_MARKER,
                  evalNote,
                  handoffNote,
                  continuationText(active.goal, active.state),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
          },
        });
        // 注入時点の進展を記録する（次回 idle の skip 判定材料）。
        // eval 実行済みなら active は refresh 済みで fingerprint も最新。
        // fetch失敗時は記録しない（次回は必ず注入する従来動作を保つ）。
        if (idleMsgs !== null) {
          state.noteContinuation(
            root,
            state.continuationFingerprint(
              idleMsgs,
              active.state.phase,
              active.state.eval_cmd,
              active.state.last_eval_fingerprint,
            ),
          );
        }
      } catch {
        // ループを止めないためイベントハンドラ内の例外は握りつぶす
      }
    },
  };
};
