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
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { PHASE_ACTION } from "./gate";
import {
  checkPhaseMove,
  designDocLockedRefusal,
  designGateRefusal,
  EVAL_MANAGED_NOTE,
  effectivePhaseAction,
  ESCALATE_NEXT,
  autoEscalateOnStuck,
  buildJevPrompt,
  buildSelectorPrompt,
  extractTasks,
  foreignBoundNote,
  parseEntryRoute,
} from "./gate";
import { readGraphhopperHash, runGraphhopperEdit } from "./gate";
import * as state from "./state";
import { invokeStructured } from "./invoke";
import { PROMPT_DEFS } from "./prompts";

const ROOT_DESC =
  "対象プロジェクトのディレクトリ（.graphhopper/ の親。省略時は client roots の先頭→プロセス cwd）";
const SESSION_DESC =
  "呼び出し元セッションID（plugin の ctx.sessionID 相当。goal の bind・graphhopper_edit の判定に使う。省略可）";

function sessionOf(session_id?: string): string {
  return session_id ?? "";
}

/* root 解決: 明示指定 → client roots の先頭（file://）→ プロセス cwd。
 * client 未対応・取得失敗時は黙って cwd に倒す。 */
export async function resolveRoot(
  server: Pick<Server, "listRoots">,
  root?: string,
): Promise<string> {
  if (root && root.length > 0) return root;
  try {
    const r = await server.listRoots();
    for (const entry of r.roots ?? []) {
      if (typeof entry.uri === "string" && entry.uri.startsWith("file://")) {
        const p = decodeURIComponent(new URL(entry.uri).pathname);
        if (p.startsWith("/")) return p;
      }
    }
  } catch {
    // 未対応 client では cwd に倒す
  }
  return process.cwd();
}

/** force 系の構造化承認（elicitation）。client 未対応・拒否・失敗時は
 * false に倒して従来の error 文運用にフォールバックする。 */
async function confirmForce(server: Server, message: string): Promise<boolean> {
  try {
    const r = await server.elicitInput({
      message,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean", title: "承認", description: message },
        },
        required: ["confirm"],
      },
    });
    return r.action === "accept" && (r.content as { confirm?: unknown } | undefined)?.confirm === true;
  } catch {
    return false;
  }
}

function goalData(
  root: string,
  action: string,
  text: string,
): Record<string, unknown> {
  if (text.startsWith("error") || text === "no active goal") {
    return { action, ok: false };
  }
  const a = state.getActive(root);
  if (!a) return { action, ok: false };
  return {
    action,
    ok: true,
    goalId: a.goal.id,
    title: a.goal.title,
    status: a.goal.status,
    phase: a.state.phase,
    bound: !!a.state.session_id,
  };
}

function statusData(root: string): Record<string, unknown> {
  const a = state.getActive(root);
  if (!a) return { active: false };
  return {
    active: true,
    goalId: a.goal.id,
    title: a.goal.title,
    status: a.goal.status,
    phase: a.state.phase,
    // client が outputSchema で自動検証するため null は落とす（undefined は省略される）
    route: a.state.router.route ?? undefined,
    failStreak: a.state.fail_streak,
  };
}

function statusText(root: string): string {
  const a = state.getActive(root);
  if (!a) return "no active goal";
  return [
    `goal: "${a.goal.title}" (${a.goal.id}) [${a.goal.status}]`,
    `phase: ${a.state.phase}`,
    `session: ${a.state.session_id ?? "unbound"}`,
    `entry_route: ${a.state.entry_route ?? "full（未判定・legacy）"}${a.state.escalated_at ? `（${a.state.escalated_at}にlight/advised→full昇格）` : ""}`,
    a.state.router.route
      ? `router: route=${a.state.router.route} diff_lines=${a.state.router.diff_lines} checked_at=${a.state.router.checked_at}`
      : "router: (not checked)",
    a.state.initial_diff_lines !== null &&
    a.state.initial_diff_lines !== undefined
      ? `initial_dirt: ${a.state.initial_diff_lines} lines（goal start時の未コミット分。実効diffから除外）`
      : null,
    a.state.last_verifier
      ? `last_verifier: level=${a.state.last_verifier.level} target=${a.state.last_verifier.target ?? "-"} lens=${a.state.last_verifier.lens.join(",") || "-"} reason=${a.state.last_verifier.reason}`
      : "last_verifier: (none)",
    a.state.critic_review
      ? `critic_review: level=${a.state.critic_review.level} reason=${a.state.critic_review.reason}`
      : "critic_review: (none, opt-in)",
    `fail_streak: ${a.state.fail_streak}`,
    a.goal.score ? `score: ${a.goal.score.value} ${JSON.stringify(a.goal.score.breakdown)}` : null,
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

async function goalAction(
  root: string,
  sessionID: string,
  action: "start" | "pause" | "resume" | "complete" | "clear",
  opts: { title?: string; force?: boolean; server?: Server },
): Promise<string> {
  const { title, force, server } = opts;
  // 単一driver警告は操作前に判定する（pause等でbindが変わる前の値を読む）
  const drv = driverNote(root, sessionID);
  switch (action) {
    case "start": {
      if (!title) return "error: title is required for start";
      const active = state.getActive(root);
      if (active && active.goal.status === "active") {
        return `error: goal "${active.goal.title}" is already active. complete or pause it first.`;
      }
      const a = state.startGoal(root, title, sessionID);
      try {
        const rev = await state.captureBaselineRev($, root);
        if (rev) {
          state.snapshotInitialDirt(
            root,
            await state.measureDiffLines($, root, rev),
          );
        }
      } catch {
        // 測定不能は無視（initial null＝旧挙動）
      }
      const started = state.getActive(root) ?? a;
      const unbound =
        !sessionID &&
        "\n(note: session_id 未指定のため未バインド。継続注入・stuck計数を有効にするには session_id を指定して resume で bind せよ)";
      return `goal started: "${started.goal.title}" (${started.goal.id})\nphase: designing\n次: ${effectivePhaseAction("designing", started.state.entry_route)}${unbound ?? ""}`;
    }
    case "pause": {
      const a = state.pauseGoal(root);
      return a ? `paused: "${a.goal.title}"${drv}` : "no active goal";
    }
    case "resume": {
      if (state.isResumeBlocked(root) && !force) {
        // elicitation: client が承認すれば force 扱いで続行。未対応・拒否は従来文へ
        if (server) {
          const s0 = state.getActive(root);
          const max = state.readConfig(root).loop_stop_max;
          const approved = await confirmForce(
            server,
            `goal "${s0?.goal.title}" はループ検知の自動停止が loop_stop_max（${max}）回に達し resume がブロック中です。原因を確認済みで明示的に続行しますか？（監査ログに loop_resume_forced が記録されます）`,
          );
          if (approved) {
            const a2 = state.resumeGoal(root, sessionID, true);
            return a2
              ? `resumed: "${a2.goal.title}" | phase: ${a2.state.phase} (forced via elicitation)`
              : "no active goal";
          }
        }
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
        if (server) {
          const approved = await confirmForce(
            server,
            `goal "${a.goal.title}" は直近 verifier clean がありません。このまま完了すると self-graded 完了になりますが、人間の明示判断として強制完了しますか？`,
          );
          if (approved) {
            const done2 = state.completeGoal(root);
            return done2
              ? `completed: "${done2.goal.title}" (forced via elicitation)`
              : "no active goal";
          }
        }
        return (
          "error: complete には直近の graphhopper_verifier_set（集約 clean）が必要です（self-graded 完了は禁止）。" +
          "小diffで verifier fan-out が不要なら、人間の明示的な判断がある場合のみ force: true を使ってください。"
        );
      }
      const done = state.completeGoal(root);
      return done
        ? `completed: "${done.goal.title}"${force ? " (forced)" : ""}${drv}`
        : "no active goal";
    }
    case "clear": {
      state.clearActiveGoal(root);
      state.unbindSession(root, sessionID);
      return `cleared${drv}`;
    }
  }
}

/* 単一driver警告: bind済みgoalへの別session操作。拒否ではなく警告に留める
 * （handoff等の正規フローがあるため）。変異系toolの応答に付与する */
function driverNote(root: string, sessionID: string): string {
  const a = state.getActive(root);
  const bound = a?.state.session_id;
  if (bound && sessionID && sessionID !== bound) return `\n${foreignBoundNote(bound)}`;
  return "";
}

function attemptRecord(root: string, ok: boolean, note: string): ToolOut {
  const active = state.getActive(root);
  if (!active) return { text: "error: no active goal" };
  const r = state.recordAttempt(root, ok, note);
  const managed = !ok && active.state.eval_cmd ? `\n${EVAL_MANAGED_NOTE}` : "";
  if (ok)
    return {
      text: "attempt recorded: ok (fail_streak reset to 0)",
      data: { ok: true, failStreak: 0, escalate: false, giveUp: false },
    };
  if (r.giveUp) {
    const paused = state.pauseGoal(root);
    if (paused) {
      state.recordEvent(root, {
        type: "eval_gave_up",
        goal: paused.goal.id,
        fail_streak: r.fail_streak,
      });
    }
    return {
      text: [
        `attempt recorded: fail (fail_streak=${r.fail_streak})`,
        `giveUp: true — 連続失敗が上限に達したため goal を pause した。修正して graphhopper_goal(action: 'resume') で再開せよ（fail_streak は 0 に戻る）。`,
        managed,
      ]
        .filter(Boolean)
        .join("\n"),
      data: { ok: false, failStreak: r.fail_streak, escalate: false, giveUp: true },
    };
  }
  if (r.escalate) {
    return {
      text: [
        `attempt recorded: fail (fail_streak=${r.fail_streak})`,
        "escalate: true",
        "次: task(subagent_type: 'graphhopper-oracle') に相談せよ。これまでの失敗試行（何を試して何が起きたか）を渡すこと。",
        managed,
      ]
        .filter(Boolean)
        .join("\n"),
      data: { ok: false, failStreak: r.fail_streak, escalate: true, giveUp: false },
    };
  }
  const stuck = state.checkStuck(root);
  if (stuck.escalate && state.noteStuckNotified(root, stuck.reasons)) {
    const esc = autoEscalateOnStuck(root);
    if (esc) {
      return {
        text: [
          `attempt recorded: fail (fail_streak=${r.fail_streak})`,
          `stuck: ${stuck.reasons.join(", ")} → light/advised→full自動昇格（designingに巻き戻し）。`,
          ESCALATE_NEXT,
          managed,
        ]
          .filter(Boolean)
          .join("\n"),
        data: { ok: false, failStreak: r.fail_streak, escalate: true, giveUp: false },
      };
    }
    return {
      text: [
        `attempt recorded: fail (fail_streak=${r.fail_streak})`,
        `escalate: true (stuck: ${stuck.reasons.join(", ")})`,
        "次: task(subagent_type: 'graphhopper-oracle') に相談せよ。これまでの失敗試行・編集履歴を渡すこと。",
        managed,
      ]
        .filter(Boolean)
        .join("\n"),
      data: { ok: false, failStreak: r.fail_streak, escalate: true, giveUp: false },
    };
  }
  return {
    text: `attempt recorded: fail (fail_streak=${r.fail_streak})\nescalate: false${managed}`,
    data: { ok: false, failStreak: r.fail_streak, escalate: false, giveUp: false },
  };
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
    const measured = await state.measureDiffLines($, root, baseline);
    const diffLines = state.effectiveDiffLines(
      measured,
      state.getActive(root)?.state.initial_diff_lines,
    );
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
      return `eval_cmd passed but effective diff_lines=0 since baseline — 実装なしか前goal残骸との相殺のいずれか。実装を進めるか、router_check で手動確認せよ: ${cmd}\n${tail}`;
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
      const esc = autoEscalateOnStuck(root);
      stuckLine = esc
        ? `stuck: ${stuck.reasons.join(", ")} → light/advised→full自動昇格（designingに巻き戻し）。${ESCALATE_NEXT}`
        : `stuck: ${stuck.reasons.join(", ")} — task(subagent_type: 'graphhopper-oracle') に相談せよ。これまでの失敗試行・編集履歴を渡すこと。`;
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

async function routerCheck(root: string): Promise<ToolOut> {
  const active = state.getActive(root);
  if (!active) return { text: "error: no active goal" };
  const cfg = state.readConfig(root);
  const baseline =
    active.state.router.baseline_rev ??
    (await state.captureBaselineRev($, root));
  const measured = await state.measureDiffLines($, root, baseline);
  const diffLines = state.effectiveDiffLines(
    measured,
    active.state.initial_diff_lines,
  );
  const route: state.RouterRoute =
    diffLines > cfg.router_threshold_lines ? "polish" : "advisor";
  state.recordRouterCheck(root, baseline, diffLines, route);
  const pre = state.getActive(root);
  if (
    (pre?.state.entry_route === "light" ||
      pre?.state.entry_route === "advised") &&
    route === "polish"
  ) {
    state.escalateEntryRoute(root);
    return {
      text: [
        `diff_lines: ${diffLines} (threshold: ${cfg.router_threshold_lines})`,
        "route: polish + light/advised→full自動昇格（designingに巻き戻し）。",
        ESCALATE_NEXT,
      ].join("\n"),
      data: { diffLines, route, threshold: cfg.router_threshold_lines, escalated: true },
    };
  }
  return {
    text: [
      `diff_lines: ${diffLines} (threshold: ${cfg.router_threshold_lines})`,
      `route: ${route}`,
      route === "polish"
        ? "次: task(subagent_type: 'graphhopper-verifier') をrequirement/behavior/progressの3charterで呼び、graphhopper_verifier_setで記録する"
        : "次: task(subagent_type: 'graphhopper-verifier') を1回、'general'charter（3観点を統合したレビュー）で呼び、graphhopper_verifier_set(results: [{lens: 'general', level}])で記録する（自己レビューだけでの完了は不可）",
    ].join("\n"),
    data: { diffLines, route, threshold: cfg.router_threshold_lines },
  };
}

function verifierSet(
  root: string,
  results: state.VerifierResult[],
  reason: string,
  model?: string,
): ToolOut {
  const active = state.getActive(root);
  const rejected = state.checkVerifierResults(results, {
    entryRoute: active?.state.entry_route ?? null,
    escalated: !!active?.state.escalated_at,
  });
  if (rejected) return { text: rejected };
  const decided = state.aggregateVerdicts(results);
  const result = state.setVerifierVerdict(root, {
    level: decided.level,
    reason,
    target: decided.target,
    lens: results.map((r) => r.lens),
    model,
  });
  const data = {
    level: decided.level,
    target: decided.target ?? undefined,
    lens: results.map((r) => r.lens),
    model: result.last_verifier?.model ?? undefined,
  };
  if (result.last_verifier?.level === "clean") {
    return {
      text: "verifier verdict: clean\ngraphhopper_phase(phase: 'done') で完了に進める。",
      data,
    };
  }
  return {
    text: [
      `verifier verdict: drift -> ${decided.target}`,
      `reason: ${reason}`,
      `lens: ${results.map((r) => `${r.lens}=${r.level}`).join(",")}`,
      decided.target === "implementing"
        ? "次: graphhopper_phase(phase: 'implementing') で巻き戻し"
        : "次: 人間の hand-back を待つ（design/requirementsは自動で戻らない）",
    ].join("\n"),
    data,
  };
}

/* MCP tool 定義表。inputSchema（JSON Schema・手書き）と検証用 zod schema、
 * 実行関数を隣接させて二重管理の漂流を抑える。
 * 高レベル McpServer.tool は overload の型推論が TS2589 で爆発するため
 * 低レベル Server + setRequestHandler を使う。 */
interface ToolCtx {
  server: Server;
  /** CallTool ハンドラで解決済みの root（resolveRoot 済み） */
  root: string;
  /** client中断（MCP extra.signal）。invoke等に伝播させる */
  signal?: AbortSignal;
}

interface ToolOut {
  text: string;
  /** structuredContent 用。付けた tool は outputSchema も宣言する */
  data?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
  outputSchema?: Tool["outputSchema"];
  schema: z.ZodTypeAny;
  run: (args: any, ctx: ToolCtx) => Promise<ToolOut> | ToolOut;
}

/* tool annotations（hint）。client 側の確認フロー用。
 * readOnly: status/hash。destructive: edit（利用者ファイルを変更）。
 * openWorld: shell/spawn するもの（eval/invoke/router_check）。 */
const ANNOTATIONS: Record<string, Tool["annotations"]> = {
  graphhopper_status: { readOnlyHint: true },
  graphhopper_scoreboard: { readOnlyHint: true },
  graphhopper_hash: { readOnlyHint: true },
  graphhopper_edit: { destructiveHint: true },
  graphhopper_eval: { openWorldHint: true },
  graphhopper_invoke: { openWorldHint: true },
  graphhopper_router_check: { openWorldHint: true },
};

/* logging 転送で info に上げる tool（state 遷移系）。他は debug。 */
const LOG_TOOLS = new Set([
  "graphhopper_goal",
  "graphhopper_phase",
  "graphhopper_verifier_set",
  "graphhopper_critic_set",
  "graphhopper_eval",
  "graphhopper_attempt",
  "graphhopper_router_check",
  "graphhopper_route_set",
  "graphhopper_escalate",
]);

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
    outputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        ok: { type: "boolean" },
        goalId: { type: "string" },
        title: { type: "string" },
        status: { type: "string" },
        phase: { type: "string" },
        bound: { type: "boolean" },
      },
      required: ["action", "ok"],
    },
    run: async (a, ctx) => {
      const root = ctx.root;
      const text = await goalAction(root, sessionOf(a.session_id), a.action, {
        title: a.title,
        force: a.force,
        server: ctx.server,
      });
      return { text, data: goalData(root, a.action, text) };
    },
  },
  {
    name: "graphhopper_status",
    description:
      "graphhopper の現在状態（goal・フェーズ・router・verifier・critic_review）を表示する",
    inputSchema: { type: "object", properties: { root: ROOT_PROP } },
    schema: z.object({ root: rootZ }),
    outputSchema: {
      type: "object",
      properties: {
        active: { type: "boolean" },
        goalId: { type: "string" },
        title: { type: "string" },
        status: { type: "string" },
        phase: { type: "string" },
        route: { type: "string" },
        failStreak: { type: "number" },
      },
      required: ["active"],
    },
    run: (a, ctx) => {
      const root = ctx.root;
      return { text: statusText(root), data: statusData(root) };
    },
  },
  {
    name: "graphhopper_scoreboard",
    description:
      "評価機能A: モデル×役割の成績表（verdict集計）とgoal転帰（巻き戻し・eval・採点）。マッピング判断の素材",
    inputSchema: { type: "object", properties: { root: ROOT_PROP } },
    schema: z.object({ root: rootZ }),
    outputSchema: {
      type: "object",
      properties: {
        models: {
          type: "array",
          items: {
            type: "object",
            properties: {
              model: { type: "string" },
              role: { type: "string" },
              verdicts: { type: "number" },
              clean: { type: "number" },
              drift: { type: "number" },
            },
            required: ["model", "role", "verdicts", "clean", "drift"],
          },
        },
        goals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              status: { type: "string" },
              rewinds: { type: "number" },
              evalPass: { type: "number" },
              evalFail: { type: "number" },
              score: { type: "number" },
            },
            required: ["id", "title", "status", "rewinds", "evalPass", "evalFail"],
          },
        },
        hints: { type: "array", items: { type: "string" } },
      },
      required: ["models", "goals", "hints"],
    },
    run: (a, ctx) => {
      const sb = state.buildScoreboard(ctx.root);
      const lines = [
        "## models",
        ...sb.models.map(
          (m) => `- ${m.role} ${m.model}: ${m.verdicts}件 (clean ${m.clean} / drift ${m.drift})`,
        ),
        "## goals",
        ...sb.goals.map(
          (g) =>
            `- ${g.id} "${g.title}" [${g.status}] rewinds=${g.rewinds} eval=${g.evalPass}/${g.evalFail} score=${g.score ?? "-"}`,
        ),
        "## hints",
        ...sb.hints.map((h) => `- ${h}`),
      ];
      return {
        text: lines.join("\n"),
        data: {
          models: sb.models,
          goals: sb.goals.map((g) => ({ ...g, score: g.score ?? undefined })),
          hints: sb.hints,
        },
      };
    },
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
        session_id: SESSION_PROP,
      },
      required: ["phase"],
    },
    schema: z.object({
      phase: z.enum(state.PHASES),
      notes: z.string().optional(),
      root: rootZ,
      session_id: sessionZ,
    }),
    outputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" }, phase: { type: "string" } },
      required: ["ok"],
    },
    run: (a, ctx) => {
      const rejected = checkPhaseMove(ctx.root, a.phase);
      // 拒否時もdataを返す（欠くとMCP -32600で真因がマスクされる）
      if (rejected) return { text: rejected, data: { ok: false } };
      const r = state.setPhase(ctx.root, a.phase, a.notes);
      if (!r)
        return { text: "error: no active goal or invalid phase", data: { ok: false } };
      return {
        text: `phase -> ${r.state.phase}\n次: ${effectivePhaseAction(r.state.phase, r.state.entry_route)}${driverNote(ctx.root, sessionOf(a.session_id))}`,
        data: { ok: true, phase: r.state.phase },
      };
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
    outputSchema: {
      type: "object",
      properties: { cmd: { type: "string" }, cleared: { type: "boolean" } },
      required: ["cmd", "cleared"],
    },
    run: (a, ctx) => {
      const root = ctx.root;
      const active = state.getActive(root);
      if (!active) return { text: "error: no active goal" };
      state.setEvalCmd(root, a.cmd);
      return {
        text: a.cmd
          ? `eval_cmd set: ${a.cmd}\ngraphhopper_eval で明示実行する（MCP には idle 自動駆動が無い）。`
          : "eval_cmd cleared. graphhopper_attemptの自己申告にフォールバックする。",
        data: { cmd: a.cmd, cleared: !a.cmd },
      };
    },
  },
  {
    name: "graphhopper_eval",
    description:
      "eval_cmd を実行し plugin の idle eval 経路と同型の遷移（pass→polish / fail→fail_streak / giveUp→pause）を適用する",
    inputSchema: { type: "object", properties: { root: ROOT_PROP } },
    schema: z.object({ root: rootZ }),
    outputSchema: {
      type: "object",
      properties: {
        ran: { type: "boolean" },
        ok: { type: "boolean" },
        failStreak: { type: "number" },
        phase: { type: "string" },
        route: { type: "string" },
        diffLines: { type: "number" },
      },
      required: ["ran"],
    },
    run: async (a, ctx) => {
      const root = ctx.root;
      const text = await evalOnce(root);
      if (text.startsWith("skip:") || text.startsWith("error:")) {
        return { text, data: { ran: false } };
      }
      const s = state.getActive(root);
      const fp = s?.state.last_eval_fingerprint ?? "";
      return {
        text,
        data: {
          ran: true,
          ok: fp.startsWith("true:"),
          failStreak: s?.state.fail_streak ?? 0,
          phase: s?.state.phase,
          route: s?.state.router.route ?? undefined,
          diffLines: s?.state.router.diff_lines ?? undefined,
        },
      };
    },
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
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        failStreak: { type: "number" },
        escalate: { type: "boolean" },
        giveUp: { type: "boolean" },
      },
      required: ["ok", "failStreak", "escalate", "giveUp"],
    },
    run: (a, ctx) => attemptRecord(ctx.root, a.ok, a.note),
  },
  {
    name: "graphhopper_router_check",
    description:
      "diffサイズを機械測定してrouteを決める（advisor=小diff・verifier1回 / polish=大diff・3charter fan-out）",
    inputSchema: { type: "object", properties: { root: ROOT_PROP } },
    schema: z.object({ root: rootZ }),
    outputSchema: {
      type: "object",
      properties: {
        diffLines: { type: "number" },
        route: { type: "string" },
        threshold: { type: "number" },
      },
      required: ["diffLines", "route", "threshold"],
    },
    run: (a, ctx) => routerCheck(ctx.root),
  },
  {
    name: "graphhopper_diff_stash",
    description:
      "verifier fan-out用のdiff退避。baselineからの全文diffを.graphhopper/tmpに1回だけ置きpathを返す（3 lensへのinline 3重展開防止）",
    inputSchema: { type: "object", properties: { root: ROOT_PROP } },
    schema: z.object({ root: rootZ }),
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        lines: { type: "number" },
        baseline: { type: "string" },
      },
      required: ["path", "lines", "baseline"],
    },
    run: async (a, ctx) => {
      const active = state.getActive(ctx.root);
      if (!active) return { text: "error: no active goal" };
      const baseline =
        active.state.router.baseline_rev ??
        (await state.captureBaselineRev($, ctx.root));
      const stashed = await state.stashDiff($, ctx.root, baseline, active.goal.id);
      if (!stashed) return { text: "error: diff取得失敗（VCS不在またはbaseline不正）" };
      return {
        text: [
          `diff stashed: ${stashed.path} (${stashed.lines} lines)`,
          "各lensにはpathを渡し、inline展開禁止。読むのは差分範囲＋疑義点のみに留めよ。",
        ].join("\n"),
        data: { path: stashed.path, lines: stashed.lines, baseline: stashed.baseline },
      };
    },
  },
  {
    name: "graphhopper_route",
    description:
      "jev入口トリアージの判定promptを発行する。LLM呼び出しはtool外: graphhopper_invoke(agent: 'graphhopper-jev')で判定しgraphhopper_route_setで記録せよ",
    inputSchema: {
      type: "object",
      properties: {
        root: ROOT_PROP,
        request: { type: "string", description: "これからやる内容のテキスト" },
      },
      required: ["request"],
    },
    schema: z.object({ root: rootZ, request: z.string() }),
    outputSchema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
    run: (a) => {
      const prompt = buildJevPrompt(a.request as string);
      return {
        text: [
          prompt,
          "",
          "次: graphhopper_invoke(agent: 'graphhopper-jev') に上記を渡し、返却JSONを graphhopper_route_set で記録せよ。",
        ].join("\n"),
        data: { prompt },
      };
    },
  },
  {
    name: "graphhopper_route_set",
    description:
      "jev判定の記録。不正値はfullに倒す。full/light/advised/oracleは次回goal start時に消費。directはhistoryに1行残すのみ",
    inputSchema: {
      type: "object",
      properties: {
        root: ROOT_PROP,
        route: { type: "string", description: "jev返却のroute（full/light/direct/advised/oracle。旧A/B/Cも受理。不正値はfullに倒す）" },
        reason: { type: "string", description: "判定理由の要旨（任意）" },
      },
      required: ["route"],
    },
    schema: z.object({ root: rootZ, route: z.string(), reason: z.string().optional() }),
    outputSchema: {
      type: "object",
      properties: {
        route: { type: "string" },
        bound: { type: "boolean" },
      },
      required: ["route", "bound"],
    },
    run: (a, ctx) => {
      const parsed = parseEntryRoute(a.route as string);
      const reason = (a.reason as string | undefined) ?? parsed.reason;
      if (parsed.route === "direct") {
        const active = state.getActive(ctx.root);
        state.recordEvent(ctx.root, {
          type: "entry_route",
          ...(active?.goal.id ? { goal: active.goal.id } : {}),
          route: "direct",
          reason,
        });
        return {
          text: "entry_route=direct を記録（historyのみ）。loopなしで直接対応せよ。",
          data: { route: "direct", bound: false },
        };
      }
      state.writePendingRoute(ctx.root, parsed.route, reason);
      const bound = state.bindEntryRoute(ctx.root, parsed.route, reason);
      if (bound) state.clearPendingRoute(ctx.root);
      return {
        text: bound
          ? `pending entry_route=${parsed.route} を記録しactive goalにbindした（pendingは消去）。`
          : `pending entry_route=${parsed.route} を記録。graphhopper_goal(start) で消費される。`,
        data: { route: parsed.route, bound: !!bound },
      };
    },
  },
  {
    name: "graphhopper_selector",
    description:
      "verifier編成selectorの判定promptを発行する（advisory-only）。LLM呼び出しはtool外: task(subagent_type: 'graphhopper-advisor')／graphhopper_invoke(agent: 'graphhopper-advisor')で判定し、出力はparseSelectorOutput相当で検証せよ。不正時は従来routerを継続（general倒しはしない）",
    inputSchema: {
      type: "object",
      properties: {
        root: ROOT_PROP,
        design_excerpt: { type: "string", description: "design.mdの抜粋（goal理解＋受け入れ条件）" },
        diff_stat: { type: "string", description: "diff統計（ファイル数・行数・対象領域）" },
      },
      required: ["design_excerpt", "diff_stat"],
    },
    schema: z.object({ root: rootZ, design_excerpt: z.string(), diff_stat: z.string() }),
    outputSchema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
    run: (a) => {
      const prompt = buildSelectorPrompt(
        a.design_excerpt as string,
        a.diff_stat as string,
      );
      return {
        text: [
          prompt,
          "",
          "次: task(subagent_type: 'graphhopper-advisor')／graphhopper_invoke(agent: 'graphhopper-advisor')に上記を渡し、返却JSONのlenses（1-3件・既知IDのみ採用）を参考にverifier編成を決めよ。不正・空の場合は従来router（advisor/polish）を継続せよ。",
        ].join("\n"),
        data: { prompt },
      };
    },
  },
  {
    name: "graphhopper_escalate",
    description:
      "light/advised→full昇格。designingに巻き戻しdesign肉付け＋critic1回＋fan-outに格上げ。full→light・未設定・direct/oracleは拒否",
    inputSchema: { type: "object", properties: { root: ROOT_PROP } },
    schema: z.object({ root: rootZ }),
    outputSchema: {
      type: "object",
      properties: { escalated: { type: "boolean" } },
      required: ["escalated"],
    },
    run: (a, ctx) => {
      const from = state.getActive(ctx.root)?.state.entry_route;
      const r = state.escalateEntryRoute(ctx.root);
      if (!r)
        return {
          text: "error: 昇格不可（active goalなし、または entry_route=light/advised ではない）",
          data: { escalated: false },
        };
      return {
        text: `escalated: ${from} -> full（designingに巻き戻し）。design肉付け＋critic1回＋fan-out×3が必須。`,
        data: { escalated: true },
      };
    },
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
        model: { type: "string", description: "判定を実行したモデル（省略時はconfig既定で補完）" },
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
      model: z.string().optional(),
      root: rootZ,
    }),
    outputSchema: {
      type: "object",
      properties: {
        level: { type: "string" },
        target: { type: "string" },
        lens: { type: "array", items: { type: "string" } },
        model: { type: "string" },
      },
      required: ["level"],
    },
    run: (a, ctx) => verifierSet(ctx.root, a.results as state.VerifierResult[], a.reason, a.model),
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
        model: { type: "string", description: "レビューを実行したモデル（省略時はconfig既定で補完）" },
        root: ROOT_PROP,
      },
      required: ["level", "reason"],
    },
    schema: z.object({
      level: z.enum(["clean", "drift"]),
      reason: z.string(),
      model: z.string().optional(),
      root: rootZ,
    }),
    outputSchema: {
      type: "object",
      properties: {
        level: { type: "string" },
        phase: { type: "string" },
        model: { type: "string" },
      },
      required: ["level", "phase"],
    },
    run: (a, ctx) => {
      const result = state.setCriticVerdict(ctx.root, {
        level: a.level,
        reason: a.reason,
        model: a.model,
      });
      return {
        text: `critic review recorded: ${a.level}. phase: ${result.phase}`,
        data: {
          level: a.level,
          phase: result.phase,
          model: result.critic_review?.model ?? undefined,
        },
      };
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
    outputSchema: {
      type: "object",
      properties: {
        target: { type: "string" },
        scope: { type: "string" },
        round: { type: "number" },
      },
      required: ["target", "scope", "round"],
    },
    run: (a, ctx) => {
      const active = state.getActive(ctx.root);
      const s = state.startDiscover(ctx.root, a.target, a.scope, active?.goal.id ?? null);
      return {
        text: [
          `discover started: target="${s.target}" scope="${s.scope}"`,
          "次: 3charterで探索し、結果を graphhopper_discover_tick に渡す。stopped_reasonがnullの間、繰り返す。",
        ].join("\n"),
        data: { target: s.target, scope: s.scope, round: s.round },
      };
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
    outputSchema: {
      type: "object",
      properties: {
        round: { type: "number" },
        dryStreak: { type: "number" },
        seen: { type: "number" },
        stopped: { type: "string" },
        confirmed: { type: "number" },
      },
      required: ["round", "dryStreak", "seen", "confirmed"],
    },
    run: (a, ctx) => {
      const s = state.tickDiscover(ctx.root, a.findings);
      const data = {
        round: s.round,
        dryStreak: s.dry_streak,
        seen: s.seen.length,
        stopped: s.stopped_reason ?? undefined,
        confirmed: s.confirmed.length,
      };
      if (s.stopped_reason) {
        return {
          text: [
            `stopped: ${s.stopped_reason} (round ${s.round})`,
            `confirmed: ${s.confirmed.length}件`,
            JSON.stringify(s.confirmed, null, 2),
          ].join("\n"),
          data,
        };
      }
      return {
        text: `round ${s.round} 完了。dry_streak=${s.dry_streak}, seen=${s.seen.length}件。次のラウンドへ`,
        data,
      };
    },
  },
  {
    name: "graphhopper_discover_clear",
    description: "discoverセッションをクリアする",
    inputSchema: { type: "object", properties: { root: ROOT_PROP } },
    schema: z.object({ root: rootZ }),
    outputSchema: {
      type: "object",
      properties: { cleared: { type: "boolean" } },
      required: ["cleared"],
    },
    run: (a, ctx) => {
      state.clearDiscover(ctx.root);
      return { text: "cleared", data: { cleared: true } };
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
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        sha1: { type: "string" },
        size: { type: "number" },
      },
      required: ["path", "sha1", "size"],
    },
    run: (a, ctx) => {
      const text = readGraphhopperHash(ctx.root, a.filePath);
      const parsed = JSON.parse(text) as { path: string; sha1: string; size: number };
      return {
        text,
        data: { path: parsed.path, sha1: parsed.sha1, size: parsed.size },
      };
    },
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
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        path: { type: "string" },
        sha1: { type: "string" },
        size: { type: "number" },
      },
      required: ["ok"],
    },
    run: (a, ctx) => {
      const root = ctx.root;
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
          return { text: `error: ${designGateRefusal("graphhopper_edit", a.filePath, cfg.design_gate_allow)}`, data: { ok: false } };
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
          return {
            text: `error: ${designDocLockedRefusal("graphhopper_edit", a.filePath, gateActive.goal.id)}`,
            data: { ok: false },
          };
        }
      }
      try {
        const out = runGraphhopperEdit(root, sessionOf(a.session_id), {
          filePath: a.filePath,
          expectedHash: a.expectedHash,
          oldString: a.oldString,
          newString: a.newString,
        });
        // 軟質return（"error: no active goal ..."）はそのまま返却する。
        // そのままJSON.parseするとJSCが "JSON Parse error: Unexpected identifier"
        // を投げ真因がマスクされる（g-mulmgje9で実証済み）
        if (out.startsWith("error:")) {
          return { text: out, data: { ok: false } };
        }
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
        const parsed = JSON.parse(out) as { path: string; sha1: string; size: number };
        return {
          text: `${out}${driverNote(root, sessionOf(a.session_id))}`,
          data: { ok: true, path: parsed.path, sha1: parsed.sha1, size: parsed.size },
        };
      } catch (e) {
        return { text: `error: ${e instanceof Error ? e.message : String(e)}`, data: { ok: false } };
      }
    },
  },
  {
    name: "graphhopper_invoke",
    description:
      "別モデルでsubagent相当を実行する（design g-mu5d6avj）。opencode run をspawnし stdout を返す。入れ子禁止・prompt上限12000文字・timeout既定120s。並列fan-out可（中断伝播・heartbeat付き）。delayMsで起動ずらし可",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "graphhopper-* agent名（例: graphhopper-critic）" },
        model: { type: "string", description: "provider/model形式。省略時はconfig既定" },
        prompt: { type: "string", description: "charter＋渡し物全文（12000文字まで）" },
        timeoutMs: { type: "number", description: "タイムアウトms（既定120000・上限300000）" },
        delayMs: { type: "number", description: "起動前の待機ms（並列herd回避用。既定0・上限60000）" },
        root: ROOT_PROP,
      },
      required: ["agent", "prompt"],
    },
    schema: z.object({
      agent: z.string(),
      model: z.string().optional(),
      prompt: z.string(),
      timeoutMs: z.number().optional(),
      delayMs: z.number().optional(),
      root: rootZ,
    }),
    outputSchema: {
      type: "object",
      properties: {
        timedOut: { type: "boolean" },
        fallbackWarning: { type: "boolean" },
        cancelled: { type: "boolean" },
      },
      required: ["timedOut", "fallbackWarning", "cancelled"],
    },
    run: async (a, ctx) => {
      const r = await invokeStructured(
        {
          agent: a.agent,
          model: a.model,
          prompt: a.prompt,
          root: ctx.root,
          timeoutMs: a.timeoutMs,
          delayMs: a.delayMs,
        },
        undefined,
        {
          signal: ctx.signal,
          onTick: (elapsed) => {
            // heartbeat: 長時間実行の固まり知覚を防ぐ（best-effort）
            try {
              void ctx.server.sendLoggingMessage({
                level: "info",
                logger: "graphhopper",
                data: {
                  tool: "graphhopper_invoke",
                  agent: a.agent,
                  runningSec: Math.round(elapsed / 1000),
                },
              });
            } catch {
              // 未対応 client では黙って捨てる
            }
          },
        },
      );
      return {
        text: r.output,
        data: { timedOut: r.timedOut, fallbackWarning: r.fallbackWarning, cancelled: r.cancelled },
      };
    },
  },
];

/* MCP resources: state参照系。tool呼び出しより安い読み取り用。
 * URI形式: graphhopper://graphhopper/<encodeURIComponent(root)>/<rel>
 * rel は state.json | goals.json | history.jsonl | plans/<name>.md のみ
 * （traversal防止のためallowlist＋解決後の containment 検査）。
 * ListResources は空（rootが呼出側依存で列挙不能）。templates で発見可能にする。
 * history.jsonl は末尾200行に丸める（肥大化対策。丸めた旨を先頭に明記）。 */
const HISTORY_TAIL_LINES = 200;

function parseResourceUri(uri: string): { root: string; rel: string } {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new McpError(-32002, `invalid resource uri: ${uri}`);
  }
  if (u.protocol !== "graphhopper:" || u.host !== "graphhopper") {
    throw new McpError(-32002, `unsupported resource uri: ${uri}`);
  }
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length < 2) {
    throw new McpError(-32002, `invalid resource uri (need root + name): ${uri}`);
  }
  const root = decodeURIComponent(segs[0] ?? "");
  const rel = segs.slice(1).join("/");
  if (!root.startsWith("/") || !existsSync(root)) {
    throw new McpError(-32002, `unknown project root: ${root}`);
  }
  if (!/^(state|goals|lineage)\.json$|^history\.jsonl$|^plans\/[A-Za-z0-9_.-]+\.md$/.test(rel)) {
    throw new McpError(-32002, `unsupported resource name: ${rel}`);
  }
  if (rel === "lineage.json") return { root, rel };
  const resolved = resolve(root, ".graphhopper", rel);
  if (resolved !== join(root, ".graphhopper", rel) || !resolved.startsWith(root + sep)) {
    throw new McpError(-32002, `path escape blocked: ${rel}`);
  }
  return { root, rel };
}

function readResourceContent(
  root: string,
  rel: string,
): { text: string; mimeType: string } | Promise<{ text: string; mimeType: string }> {
  // lineage.json は仮想 resource（goals + history から導出＋graft enrich）
  if (rel === "lineage.json") {
    return lineageEnriched(root).then((lin) => ({
      text: JSON.stringify(lin, null, 2),
      mimeType: "application/json",
    }));
  }
  const p = join(root, ".graphhopper", rel);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    throw new McpError(-32002, `not found: ${rel} (root: ${root})`);
  }
  if (rel.endsWith(".md")) return { text: raw, mimeType: "text/markdown" };
  if (rel === "history.jsonl") {
    const lines = raw.split("\n");
    if (lines.length > HISTORY_TAIL_LINES) {
      return {
        text: [
          `(note: 直近${HISTORY_TAIL_LINES}行のみ。全${lines.length}行)`,
          ...lines.slice(-HISTORY_TAIL_LINES),
        ].join("\n"),
        mimeType: "application/json",
      };
    }
    return { text: raw, mimeType: "application/json" };
  }
  return { text: raw, mimeType: "application/json" };
}

/* graft連携（作業グラフ × コードグラフ）: lineage の editedFiles に
 * graft skeleton の symbol 一覧を付与する。「どの goal がどの symbol に
 * 触ったか」が引ける。edit 経路は触らない（latency・故障点を増やさない）。
 * 読み取り時 lazy enrich・best-effort（graft不在・timeout・staleでも空配列に倒す）。
 * state.ts は stdlib-only 維持のため graft 呼び出しは MCP 層に置く。 */
export interface FileSymbols {
  file: string;
  symbols: { name: string; kind: string; lines: string }[];
}

const GRAFT_TIMEOUT_MS = 10000;
const MAX_SYMBOL_FILES = 20;
const MAX_SYMBOLS_PER_FILE = 50;

function graftBinary(): string {
  const shim = join(homedir(), ".local/share/mise/shims/graft");
  return existsSync(shim) ? shim : "graft";
}

/** skeleton 出力（`- L1-L5  function foo  function foo(...)`）のパース。純粋関数 */
export function parseSkeletonSymbols(output: string): FileSymbols["symbols"] {
  const out: FileSymbols["symbols"] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/^- L(\d+)-L(\d+)\s+(\S+)\s+(\S+)/);
    if (!m) continue;
    out.push({ name: m[4] ?? "", kind: m[3] ?? "", lines: `L${m[1]}-L${m[2]}` });
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
  }
  return out;
}

export type SkeletonRunner = (root: string, file: string) => Promise<FileSymbols["symbols"]>;

const realSkeletonRunner: SkeletonRunner = (root, file) =>
  new Promise((resolvePromise) => {
    const target = isAbsolute(file) ? file : join(root, file);
    if (!existsSync(target)) {
      resolvePromise([]);
      return;
    }
    execFile(
      graftBinary(),
      ["skeleton", isAbsolute(file) ? file : file],
      { cwd: root, timeout: GRAFT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolvePromise([]);
          return;
        }
        try {
          resolvePromise(parseSkeletonSymbols(stdout.toString()));
        } catch {
          resolvePromise([]);
        }
      },
    );
  });

/** buildLineage に editedSymbols を付与する。run 注入可（テスト用） */
export interface EnrichedGoalLineage extends state.GoalLineage {
  editedSymbols: FileSymbols[];
  /** design.md タスク列の進捗（progress lens 素材） */
  tasks: { total: number; done: number; items: { text: string; done: boolean }[] };
}

export async function lineageEnriched(
  root: string,
  run: SkeletonRunner = realSkeletonRunner,
): Promise<{ goals: EnrichedGoalLineage[]; discover: state.DiscoverState | null }> {
  const lin = state.buildLineage(root);
  const files: string[] = [];
  for (const g of lin.goals) {
    for (const f of g.editedFiles) {
      if (!files.includes(f)) files.push(f);
    }
  }
  const table = new Map<string, FileSymbols["symbols"]>();
  for (const f of files.slice(0, MAX_SYMBOL_FILES)) {
    try {
      table.set(f, await run(root, f));
    } catch {
      table.set(f, []);
    }
  }
  return {
    goals: lin.goals.map((g) => ({
      ...g,
      editedSymbols: g.editedFiles.map((f) => ({
        file: f,
        symbols: table.get(f) ?? [],
      })),
      tasks: extractTasks(root, g.id),
    })),
    discover: lin.discover,
  };
}
const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "graphhopper://graphhopper/{root}/state.json",
    name: "loop state",
    description: "現在のループ状態（goal/phase/router/verifier）。{root} は encodeURIComponent したプロジェクトパス",
    mimeType: "application/json",
  },
  {
    uriTemplate: "graphhopper://graphhopper/{root}/goals.json",
    name: "goal queue",
    description: "目標キュー＋active指定",
    mimeType: "application/json",
  },
  {
    uriTemplate: "graphhopper://graphhopper/{root}/history.jsonl",
    name: "audit log",
    description: "監査ログ（末尾200行に丸め）",
    mimeType: "application/json",
  },
  {
    uriTemplate: "graphhopper://graphhopper/{root}/plans/{name}",
    name: "design doc / log",
    description: "design ドキュメント・log（{name} は <goalId>.md / <goalId>.log.md）",
    mimeType: "text/markdown",
  },
  {
    uriTemplate: "graphhopper://graphhopper/{root}/lineage.json",
    name: "goal lineage",
    description: "goalごとの系譜（phase遷移・verifier・巻き戻し・編集ファイル＋graft symbol。作業グラフのedge素材）",
    mimeType: "application/json",
  },
];

/** テストから in-process で tool 呼び出しを検証できるよう server 構築を分離する */
export function createServer(): Server {
  const server = new Server(
    { name: "graphhopper", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} } },
  );
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { root, rel } = parseResourceUri(req.params.uri);
    const { text, mimeType } = await readResourceContent(root, rel);
    return { contents: [{ uri: req.params.uri, mimeType, text }] };
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPT_DEFS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments.map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required ?? false,
      })),
    })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const def = PROMPT_DEFS.find((p) => p.name === req.params.name);
    if (!def) throw new McpError(-32602, `unknown prompt ${req.params.name}`);
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    for (const a of def.arguments) {
      if (a.required && !args[a.name]) {
        throw new McpError(-32602, `missing required argument: ${a.name}`);
      }
    }
    const root = await resolveRoot(server, args["root"]);
    try {
      const text = def.render(args, root);
      return {
        messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
      };
    } catch (e) {
      throw new McpError(-32002, e instanceof Error ? e.message : String(e));
    }
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({    tools: TOOL_DEFS.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
      ...(d.outputSchema ? { outputSchema: d.outputSchema } : {}),
      ...(ANNOTATIONS[d.name] ? { annotations: ANNOTATIONS[d.name] } : {}),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
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
    const root = await resolveRoot(server, (parsed.data as { root?: string }).root);
    const ctx: ToolCtx = { server, root, signal: extra?.signal };
    try {
      const out = await def.run(parsed.data, ctx);
      const res: {
        content: { type: "text"; text: string }[];
        structuredContent?: Record<string, unknown>;
      } = { content: [{ type: "text", text: out.text }] };
      if (out.data !== undefined) res.structuredContent = out.data;
      // logging 転送（watchdog 系 client が state 遷移をリアルタイムに追える）。
      // client 未対応でも例外で tool 結果を壊さない。
      try {
        await server.sendLoggingMessage({
          level: LOG_TOOLS.has(def.name) ? "info" : "debug",
          logger: "graphhopper",
          data: {
            tool: def.name,
            root,
            summary: out.text.split("\n")[0]?.slice(0, 200) ?? "",
          },
        });
      } catch {
        // 未対応 client では黙って捨てる
      }
      return res;
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
