/**
 * graphhopper-mcp — graphhopper state 操作の MCP (stdio) ブリッジ。
 *
 * 背景: opencode plugin tool（graphhopper_goal 等）は opencode ランタイム内の
 * セッションにしか配膳されず、API 経由のセッション（default.* toolset）には
 * 届かない。MCP server だけが両方に届くことが実証済みの道のため、
 * state.ts / gate.ts と同一ロジックを MCP tool として公開する。
 * 応答文・遷移ルールは src/index.ts（plugin）と合わせる。
 * 指示文の単一源泉は ./gate.ts の PHASE_ACTION / PHASE_ACTION_SHORT。
 *
 * - root: 対象プロジェクトのディレクトリ（規定: プロセス cwd）。
 *   state は <root>/.graphhopper/ に保存される。
 * - session_id: plugin の ctx.sessionID 相当を明示指定する。
 *   goal に bind した session だけが継続注入・stuck 計数の対象になる。
 *   省略時 ("") は未バインド扱い（status/phase 等の session 非依存操作は可）。
 *
 * handoff は opencode SDK client が必要なため対象外（plugin 側で使う）。
 *
 * 起動: bun src/mcp.ts（stdio）
 */
import { $ } from "bun";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PHASE_ACTION } from "./gate";
import { designDocLockedRefusal, designGateRefusal } from "./gate";
import { readGraphhopperHash, runGraphhopperEdit } from "./gate";
import * as state from "./state";
import { invoke } from "./invoke";

const ROOT_DESC = "対象プロジェクトのディレクトリ（.graphhopper/ の親。省略時 cwd）";
const SESSION_DESC =
  "呼び出し元セッションID（plugin の ctx.sessionID 相当。goal の bind・graphhopper_edit の判定に使う。省略可）";

function rootOf(root?: string): string {
  return root && root.length > 0 ? root : process.cwd();
}

function sessionOf(session_id?: string): string {
  return session_id ?? "";
}

function statusText(root: string): string {
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
}

function goalAction(
  root: string,
  sessionID: string,
  action: "start" | "pause" | "resume" | "complete" | "clear",
  title?: string,
  force?: boolean,
): string {
  switch (action) {
    case "start": {
      if (!title) return "error: title is required for start";
      const active = state.getActive(root);
      if (active && active.goal.status === "active") {
        return `error: goal "${active.goal.title}" is already active. complete or pause it first.`;
      }
      const a = state.startGoal(root, title, sessionID);
      const unbound =
        !sessionID &&
        "\n(note: session_id 未指定のため未バインド。継続注入・stuck計数を有効にするには session_id を指定して resume で bind せよ)";
      return `goal started: "${a.goal.title}" (${a.goal.id})\nphase: designing\n次: ${PHASE_ACTION.designing}${unbound ?? ""}`;
    }
    case "pause": {
      const a = state.pauseGoal(root);
      return a ? `paused: "${a.goal.title}"` : "no active goal";
    }
    case "resume": {
      if (state.isResumeBlocked(root) && !force) {
        const s = state.getActive(root);
        const max = state.readConfig(root).loop_stop_max;
        const count = s?.state.loop_stop_count ?? 0;
        return (
          `error: このgoalはループ検知による自動停止が loop_stop_max（${max}）回に達したため resume がブロックされています（現在 ${count}回）。` +
          "人間が原因を確認して graphhopper_goal(action: 'clear') でリセットするか、明示的に resume を続行する場合のみ force: true を使ってください（監査ログに loop_resume_forced が記録されます）。"
        );
      }
      const a = state.resumeGoal(root, sessionID, force);
      const unbound =
        !sessionID &&
        "\n(note: session_id 未指定のため未バインドのまま。継続注入・stuck計数を有効にするには session_id を指定せよ)";
      return a
        ? `resumed: "${a.goal.title}" | phase: ${a.state.phase}${force ? " (forced)" : ""}${unbound ?? ""}`
        : "no active goal";
    }
    case "complete": {
      const a = state.getActive(root);
      if (!a) return "no active goal";
      // self-graded done 禁止: 直近の verifier clean を機械要求する（drift残りの完了を防ぐ）
      if (!force && a.state.last_verifier?.level !== "clean") {
        return (
          "error: complete には直近の graphhopper_verifier_set（集約 clean）が必要です（self-graded 完了は禁止）。" +
          "小diffで verifier fan-out が不要なら、人間の明示的な判断がある場合のみ force: true を使ってください。"
        );
      }
      const done = state.completeGoal(root);
      return done
        ? `completed: "${done.goal.title}"${force ? " (forced)" : ""}`
        : "no active goal";
    }
    case "clear": {
      state.clearActiveGoal(root);
      state.unbindSession(root, sessionID);
      return "cleared";
    }
  }
}

function attemptRecord(root: string, ok: boolean, note: string): string {
  const active = state.getActive(root);
  if (!active) return "error: no active goal";
  const r = state.recordAttempt(root, ok, note);
  if (ok) return "attempt recorded: ok (fail_streak reset to 0)";
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
  const stuck = state.checkStuck(root);
  if (stuck.escalate && state.noteStuckNotified(root, stuck.reasons)) {
    return [
      `attempt recorded: fail (fail_streak=${r.fail_streak})`,
      `escalate: true (stuck: ${stuck.reasons.join(", ")})`,
      "次: task(subagent_type: 'graphhopper-oracle') に相談せよ。これまでの失敗試行・編集履歴を渡すこと。",
    ].join("\n");
  }
  return `attempt recorded: fail (fail_streak=${r.fail_streak})\nescalate: false`;
}

/** plugin の session.idle 内 eval 経路と同型の遷移（promptAsync・loop検知・
 * continuation dedupe を除く。MCP には idle 駆動が無いため明示実行する）。 */
async function evalOnce(root: string): Promise<string> {
  const active = state.getActive(root);
  if (!active) return "error: no active goal";
  if (active.state.phase !== "implementing" || !active.state.eval_cmd) {
    return "skip: eval は implementing 中かつ eval_cmd 設定時のみ実行する（graphhopper_set_eval で設定せよ）";
  }
  const cmd = active.state.eval_cmd;
  const result = await state.runEval($, root, cmd);
  const tail = result.output.split("\n").slice(-20).join("\n");
  state.noteEvalFingerprint(root, `${result.ok}:${state.fnv1a(tail)}`);
  const r = state.recordAttempt(
    root,
    result.ok,
    result.ok ? "" : `eval failed: ${cmd}`,
  );
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
      state.recordRouterCheck(root, baseline, 0, "advisor");
      state.setPhase(root, "polish");
      return `eval_cmd passed but baseline not captured — polishへ進む（simplifyはスキップ、verifierで検証）: ${cmd}\n${tail}`;
    } else if (diffLines > 0) {
      const cfg = state.readConfig(root);
      const route: state.RouterRoute =
        diffLines > cfg.router_threshold_lines ? "polish" : "advisor";
      state.recordRouterCheck(root, baseline, diffLines, route);
      state.setPhase(root, "polish");
      return `eval_cmd passed (diff ${diffLines} lines since baseline): ${cmd}\n${tail}`;
    } else {
      state.recordRouterCheck(root, baseline, 0, "advisor");
      return `eval_cmd passed but diff_lines=0 since baseline — まだ何も実装していない。polishへは進めない。実装を進めよ: ${cmd}\n${tail}`;
    }
  }
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
      tail,
    ].join("\n");
  }
  let stuckLine = "";
  if (r.escalate) {
    stuckLine = "escalate: task(subagent_type: 'graphhopper-oracle') に相談せよ。";
  } else {
    const stuck = state.checkStuck(root);
    if (stuck.escalate && state.noteStuckNotified(root, stuck.reasons)) {
      stuckLine = `stuck: ${stuck.reasons.join(", ")} — task(subagent_type: 'graphhopper-oracle') に相談せよ。これまでの失敗試行・編集履歴を渡すこと。`;
    }
  }
  return [
    `eval_cmd FAILED (fail_streak=${r.fail_streak}): ${cmd}`,
    tail,
    stuckLine,
  ]
    .filter(Boolean)
    .join("\n");
}

async function routerCheck(root: string): Promise<string> {
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
}

function verifierSet(
  root: string,
  results: state.VerifierResult[],
  reason: string,
): string {
  const rejected = state.checkVerifierResults(results);
  if (rejected) return rejected;
  const decided = state.aggregateVerdicts(results);
  const result = state.setVerifierVerdict(root, {
    level: decided.level,
    reason,
    target: decided.target,
    lens: results.map((r) => r.lens),
  });
  if (result.last_verifier?.level === "clean") {
    return "verifier verdict: clean\ngraphhopper_phase(phase: 'done') で完了に進める。";
  }
  return [
    `verifier verdict: drift -> ${decided.target}`,
    `reason: ${reason}`,
    `lens: ${results.map((r) => `${r.lens}=${r.level}`).join(",")}`,
    decided.target === "implementing"
      ? "次: graphhopper_phase(phase: 'implementing') で巻き戻し"
      : "次: 人間の hand-back を待つ（design/requirementsは自動で戻らない）",
  ].join("\n");
}

/* MCP tool 定義表。inputSchema（JSON Schema・手書き）と検証用 zod schema、
 * 実行関数を隣接させて二重管理の漂流を抑える。
 * 高レベル McpServer.tool は overload の型推論が TS2589 で爆発するため
 * 低レベル Server + setRequestHandler を使う。 */
interface ToolDef {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  schema: z.ZodTypeAny;
  run: (args: any) => Promise<string> | string;
}

const ROOT_PROP = { type: "string", description: ROOT_DESC } as const;
const SESSION_PROP = { type: "string", description: SESSION_DESC } as const;
const rootZ = z.string().optional();
const sessionZ = z.string().optional();

const TOOL_DEFS: ToolDef[] = [
  {
    name: "graphhopper_goal",
    description:
      "graphhopper の goal を管理する。start=新規 goal でループ開始、pause/resume=一時停止/再開、complete=完了（要直近 verifier clean）、clear=状態リセット",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "pause", "resume", "complete", "clear"] },
        title: { type: "string", description: "action=start のとき必須。goal の題名" },
        force: { type: "boolean" },
        root: ROOT_PROP,
        session_id: SESSION_PROP,
      },
      required: ["action"],
    },
    schema: z.object({
      action: z.enum(["start", "pause", "resume", "complete", "clear"]),
      title: z.string().optional(),
      force: z.boolean().optional(),
      root: rootZ,
      session_id: sessionZ,
    }),
    run: (a) =>
      goalAction(rootOf(a.root), sessionOf(a.session_id), a.action, a.title, a.force),
  },
  {
    name: "graphhopper_status",
    description:
      "graphhopper の現在状態（goal・フェーズ・router・verifier・critic_review）を表示する",
    inputSchema: { type: "object", properties: { root: ROOT_PROP } },
    schema: z.object({ root: rootZ }),
    run: (a) => statusText(rootOf(a.root)),
  },
  {
    name: "graphhopper_phase",
    description:
      "graphhopper のフェーズを遷移させる。遷移前にそのフェーズの exit 条件を満たしていること",
    inputSchema: {
      type: "object",
      properties: {
        phase: { type: "string", enum: [...state.PHASES] },
        notes: { type: "string", description: "中断・再開用メモ（どこまでやったか）" },
        root: ROOT_PROP,
      },
      required: ["phase"],
    },
    schema: z.object({
      phase: z.enum(state.PHASES),
      notes: z.string().optional(),
      root: rootZ,
    }),
    run: (a) => {
      const r = state.setPhase(rootOf(a.root), a.phase, a.notes);
      if (!r) return "error: no active goal or invalid phase";
      return `phase -> ${r.state.phase}\n次: ${PHASE_ACTION[r.state.phase]}`;
    },
  },
  {
    name: "graphhopper_set_eval",
    description:
      "implementingの合否を機械判定するコマンド（テスト/lint/typecheck等）を設定する",
    inputSchema: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "実行するシェルコマンド。空文字で解除" },
        root: ROOT_PROP,
      },
      required: ["cmd"],
    },
    schema: z.object({ cmd: z.string(), root: rootZ }),
    run: (a) => {
      const root = rootOf(a.root);
      const active = state.getActive(root);
      if (!active) return "error: no active goal";
      state.setEvalCmd(root, a.cmd);
      return a.cmd
        ? `eval_cmd set: ${a.cmd}\ngraphhopper_eval で明示実行する（MCP には idle 自動駆動が無い）。`
        : "eval_cmd cleared. graphhopper_attemptの自己申告にフォールバックする。";
    },
  },
  {
    name: "graphhopper_eval",
    description:
      "eval_cmd を実行し plugin の idle eval 経路と同型の遷移（pass→polish / fail→fail_streak / giveUp→pause）を適用する",
    inputSchema: { type: "object", properties: { root: ROOT_PROP } },
    schema: z.object({ root: rootZ }),
    run: (a) => evalOnce(rootOf(a.root)),
  },
  {
    name: "graphhopper_attempt",
    description:
      "implementingでの実装試行の成否を記録する（eval_cmd未設定時の自己申告フォールバック。連続失敗が閾値で escalate）",
    inputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        note: { type: "string" },
        root: ROOT_PROP,
      },
      required: ["ok", "note"],
    },
    schema: z.object({ ok: z.boolean(), note: z.string(), root: rootZ }),
    run: (a) => attemptRecord(rootOf(a.root), a.ok, a.note),
  },
  {
    name: "graphhopper_router_check",
    description:
      "diffサイズを機械測定してrouteを決める（advisor=小diff・verifier1回 / polish=大diff・3charter fan-out）",
    inputSchema: { type: "object", properties: { root: ROOT_PROP } },
    schema: z.object({ root: rootZ }),
    run: (a) => routerCheck(rootOf(a.root)),
  },
  {
    name: "graphhopper_verifier_set",
    description:
      "polish/advisorのverifier結果を記録する。results空（verifier未実行）はエラー",
    inputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              lens: { type: "string", enum: ["requirement", "behavior", "progress", "general"] },
              level: { type: "string", enum: ["clean", "drift"] },
              target: { type: "string", enum: ["implementing", "design", "requirements"] },
            },
            required: ["lens", "level"],
          },
        },
        reason: { type: "string" },
        root: ROOT_PROP,
      },
      required: ["results", "reason"],
    },
    schema: z.object({
      results: z.array(
        z.object({
          lens: z.enum(["requirement", "behavior", "progress", "general"]),
          level: z.enum(["clean", "drift"]),
          target: z.enum(["implementing", "design", "requirements"]).optional(),
        }),
      ),
      reason: z.string(),
      root: rootZ,
    }),
    run: (a) => verifierSet(rootOf(a.root), a.results as state.VerifierResult[], a.reason),
  },
  {
    name: "graphhopper_critic_set",
    description:
      "designing終了前のdesign.md質レビュー結果（clean/drift）を記録する（opt-in）",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["clean", "drift"] },
        reason: { type: "string" },
        root: ROOT_PROP,
      },
      required: ["level", "reason"],
    },
    schema: z.object({
      level: z.enum(["clean", "drift"]),
      reason: z.string(),
      root: rootZ,
    }),
    run: (a) => {
      const result = state.setCriticVerdict(rootOf(a.root), {
        level: a.level,
        reason: a.reason,
      });
      return `critic review recorded: ${a.level}. phase: ${result.phase}`;
    },
  },
  {
    name: "graphhopper_discover_start",
    description:
      "loop-until-dry探索を開始する（バグ探し・監査・レビュー用。phase graphには影響しない）",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        scope: { type: "string" },
        root: ROOT_PROP,
      },
      required: ["target", "scope"],
    },
    schema: z.object({ target: z.string(), scope: z.string(), root: rootZ }),
    run: (a) => {
      const s = state.startDiscover(rootOf(a.root), a.target, a.scope);
      return [
        `discover started: target="${s.target}" scope="${s.scope}"`,
        "次: 3charterで探索し、結果を graphhopper_discover_tick に渡す。stopped_reasonがnullの間、繰り返す。",
      ].join("\n");
    },
  },
  {
    name: "graphhopper_discover_tick",
    description:
      "1ラウンド分のfindingsを渡しdedupeする（round cap・dry判定は機械強制）",
    inputSchema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
              confidence: { type: "number" },
              quote: { type: "string" },
            },
            required: ["title", "severity", "confidence", "quote"],
          },
        },
        root: ROOT_PROP,
      },
      required: ["findings"],
    },
    schema: z.object({
      findings: z.array(
        z.object({
          title: z.string(),
          severity: z.enum(["critical", "high", "medium", "low"]),
          confidence: z.number(),
          quote: z.string(),
        }),
      ),
      root: rootZ,
    }),
    run: (a) => {
      const s = state.tickDiscover(rootOf(a.root), a.findings);
      if (s.stopped_reason) {
        return [
          `stopped: ${s.stopped_reason} (round ${s.round})`,
          `confirmed: ${s.confirmed.length}件`,
          JSON.stringify(s.confirmed, null, 2),
        ].join("\n");
      }
      return `round ${s.round} 完了。dry_streak=${s.dry_streak}, seen=${s.seen.length}件。次のラウンドへ`;
    },
  },
  {
    name: "graphhopper_discover_clear",
    description: "discoverセッションをクリアする",
    inputSchema: { type: "object", properties: { root: ROOT_PROP } },
    schema: z.object({ root: rootZ }),
    run: (a) => {
      state.clearDiscover(rootOf(a.root));
      return "cleared";
    },
  },
  {
    name: "graphhopper_hash",
    description:
      "ファイルのsha1 + size + mtimeを返すread-only tool（graphhopper_editのexpectedHash取得用）",
    inputSchema: {
      type: "object",
      properties: { filePath: { type: "string" }, root: ROOT_PROP },
      required: ["filePath"],
    },
    schema: z.object({ filePath: z.string(), root: rootZ }),
    run: (a) => readGraphhopperHash(rootOf(a.root), a.filePath),
  },
  {
    name: "graphhopper_edit",
    description:
      "hash検証付きedit（goal中のsource編集用）。不一致・複数一致・subagentは拒否（error文字列で返却）",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        expectedHash: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
        root: ROOT_PROP,
        session_id: SESSION_PROP,
      },
      required: ["filePath", "expectedHash", "oldString", "newString"],
    },
    schema: z.object({
      filePath: z.string(),
      expectedHash: z.string(),
      oldString: z.string(),
      newString: z.string(),
      root: rootZ,
      session_id: sessionZ,
    }),
    run: (a) => {
      const root = rootOf(a.root);
      // design gate（plugin の tool.execute.before と同型。MCP には hook が無いため
      // ここで塞ぐ。塞がないと designing 中の source 編集が MCP 経由で素通りする）
      const gateActive = state.getActive(root);
      if (gateActive) {
        const cfg = state.readConfig(root);
        if (state.isDesignGateBlocked(root, cfg, gateActive.state.phase, a.filePath)) {
          state.recordEvent(root, {
            type: "design_gate_block",
            goal: gateActive.goal.id,
            tool: "graphhopper_edit",
            path: a.filePath,
          });
          return `error: ${designGateRefusal("graphhopper_edit", a.filePath, cfg.design_gate_allow)}`;
        }
        if (
          state.isDesignDocLocked(root, gateActive.state.phase, gateActive.goal.id, a.filePath)
        ) {
          state.recordEvent(root, {
            type: "design_doc_locked_block",
            goal: gateActive.goal.id,
            tool: "graphhopper_edit",
            path: a.filePath,
          });
          return `error: ${designDocLockedRefusal("graphhopper_edit", a.filePath, gateActive.goal.id)}`;
        }
      }
      try {
        const out = runGraphhopperEdit(root, sessionOf(a.session_id), {
          filePath: a.filePath,
          expectedHash: a.expectedHash,
          oldString: a.oldString,
          newString: a.newString,
        });
        // 信号A（plugin の tool.execute.after と同型。成功 edit のみ数える。
        // MCP には after hook が無いためここで数える）
        const counted = state.getActive(root);
        if (
          counted &&
          counted.goal.status === "active" &&
          counted.state.phase === "implementing" &&
          sessionOf(a.session_id) &&
          sessionOf(a.session_id) === counted.state.session_id
        ) {
          state.noteEdit(root, a.filePath);
        }
        return out;
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    name: "graphhopper_invoke",
    description:
      "別モデルでsubagent相当を実行する（design g-mu5d6avj）。opencode run をspawnし stdout を返す。入れ子禁止・prompt上限12000文字・timeout既定120s",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "graphhopper-* agent名（例: graphhopper-critic）" },
        model: { type: "string", description: "provider/model形式。省略時はconfig既定" },
        prompt: { type: "string", description: "charter＋渡し物全文（12000文字まで）" },
        timeoutMs: { type: "number", description: "タイムアウトms（既定120000・上限300000）" },
        root: ROOT_PROP,
      },
      required: ["agent", "prompt"],
    },
    schema: z.object({
      agent: z.string(),
      model: z.string().optional(),
      prompt: z.string(),
      timeoutMs: z.number().optional(),
      root: rootZ,
    }),
    run: (a) =>
      invoke({
        agent: a.agent,
        model: a.model,
        prompt: a.prompt,
        root: rootOf(a.root),
        timeoutMs: a.timeoutMs,
      }),
  },
];

/** テストから in-process で tool 呼び出しを検証できるよう server 構築を分離する */
export function createServer(): Server {
  const server = new Server(
    { name: "graphhopper", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const def = TOOL_DEFS.find((d) => d.name === req.params.name);
    if (!def) {
      return {
        content: [{ type: "text", text: `error: unknown tool ${req.params.name}` }],
        isError: true,
      };
    }
    const parsed = def.schema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return {
        content: [{ type: "text", text: `error: invalid args: ${parsed.error.message}` }],
        isError: true,
      };
    }
    try {
      return { content: [{ type: "text", text: String(await def.run(parsed.data)) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  });
  return server;
}

if (import.meta.main) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
