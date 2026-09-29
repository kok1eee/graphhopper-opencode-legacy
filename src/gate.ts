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
    "graphhopper_router_check の route に従う。route=polish（大diff）ならまず simplify を実行する: メインが graphhopper_diff_stash で diff を退避し（verifierと同一ファイルを共用）、返却pathを task(subagent_type: 'graphhopper-simplify') に渡して提案を集める（3レンズ統合）。適用はメインが行う: 各 finding を Read で裏付け、critical は挙動不変・局所的なものだけ自動適用、high は人間確認、medium/note は報告のみ。適用後は eval_cmd を再実行して機械確認。route=advisor（小diff）なら simplify はスキップ。verifier 呼び出しの前にメインが型・lint診断を1回実行し .graphhopper/tmp/diag-<goal>.txt に保存してpathを渡す（verifierの個別実行は禁止。添付無しならverifierは「診断未実行」を明記）。その後 verifier: route=polish なら requirement/behavior/progress の3charterで、route=advisor なら general charter で task(subagent_type: 'graphhopper-verifier') を呼び、verifierは添付診断を裏付けに使え（診断クリーン≠driftなし）。周辺探索は graft-first（漁り読み禁止）。結果を graphhopper_verifier_set で記録。集約 clean で graphhopper_phase(phase: 'done') へ。集約 drift かつ target=implementing なら implementing に戻る。advisor でも第三者チェック（verifier）は省略不可",
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

/* system注入の短縮版（2回目以降のターン用）。hard制約のみ残す。
 * 強制力はコード側ゲートが担うため、文面短縮は安全性を下げない。
 * ponytail短縮行と対で使う */
export const PHASE_ACTION_BRIEF: Record<state.Phase, string> = {
  designing: "design.mdを書け。source編集不可（plans/のみ）。詳細は初回指示参照",
  implementing: "実装続行。eval設定済みなら自動判定。詰まったらoracle",
  polish: "router→verifier必須（verifier_set記録）。自己レビュー完結不可",
  done: "goalをcompleteする",
};

/** ponytail短縮行（implementing 2ターン目以降用） */
export const PONYTAIL_BRIEF =
  "ponytail継続適用: YAGNI・怠惰原則（詳細は初回注入参照）。interface変更はhigh扱いで人間に提示";

/* jev入口判定のprompt定数（ollayaのbaked質問セット相当。指示文の単一源泉則で
 * gate.tsに置く）。出力は1行JSONのみ。light/advised適用はチェックリスト化し複合時はfull */
export const JEV_ROUTE_PROMPT = `あなたは入口トリアージ判定器。やる内容からrouteを1つ選べ。
出力は1行のJSONのみ: {"route":"full|light|direct|advised|oracle"}
- full=フルループ: 設計判断・複数関心・規模不明・曖昧・以下に当てはまらない全て
- light=軽量: 全て満たす時のみ → (1)単一関心 (2)設計判断なし (3)既存パターンの踏襲 (4)テスト容易。1つでも欠けたらfull
- advised=軽量＋第二意見: light条件を満たす＋影響範囲の読みに迷いがある／第二意見が欲しい軽微変更
- oracle=多角: full相当＋最初から多角的視点が必要（アーキテクチャ判断・複雑デバッグ・不慣れパターン）
- direct=直行: 単一ファイルの小修正・質問への回答・一回きりのコマンド実行
複合・曖昧はfull。理由文・確信度は不要。JSON以外の文字を出すな`;

/* jev出力の厳密parse。未知値・非JSON・空はfullに倒す（fail-safe＝重い側）。
 * 旧A/B/C（bare・JSON内）も受理しfull/light/directに写像する。
 * 未呼び出し（null）はstate側でnull＝fullとして扱う */
export function parseEntryRoute(text: string | null | undefined): {
  route: state.EntryRoute;
  reason: string;
} {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { route: "full", reason: "jev未呼び出し→full" };
  }
  // bare入力（route_setのschemaが素の値を受け付けるため先に照合。旧A/B/C互換）
  const normalized = state.normalizeEntryRoute(text);
  if (normalized) {
    return { route: normalized, reason: "jev判定（bare）" };
  }
  const m = text.match(/\{[^{}]*"route"\s*:\s*"([A-Za-z]+)"[^{}]*\}/);
  const parsed = state.normalizeEntryRoute(m?.[1]);
  if (parsed) {
    return { route: parsed, reason: "jev判定" };
  }
  return { route: "full", reason: "parse失敗→full" };
}

/* light/advised用thin design gate: task列の存在のみ（goal理解・設計判断・棄却は問わない）。
 * 薄いspecで回す代わり、昇格時にdesigningへ戻って肉付けする */
export function checkDesignDocThin(root: string, goalId: string): string[] {
  let raw: string;
  try {
    raw = decodeUtf8Strict(readFileSync(state.planPath(root, goalId)));
  } catch {
    return ["design doc自体が無い"];
  }
  if (!TASK_LINE.test(raw)) return ["タスク行（- ...）"];
  return [];
}

/* route別phase指示（effective route）。light/advisedはcritic省略・verifier×1の注記を付与。
 * oracleは開始時相談の注記を付与。transform注入・tool応答の単一源泉 */
export function effectivePhaseAction(
  phase: state.Phase,
  entryRoute: state.EntryRoute | null,
): string {
  const base = PHASE_ACTION[phase];
  if (entryRoute === "light" || entryRoute === "advised") {
    const advisor =
      entryRoute === "advised"
        ? "implementing前にtask(graphhopper-advisor)／graphhopper_invoke(agent: 'graphhopper-advisor')で相談1回し、graphhopper_consult_set(kind: 'advisor')で記録（機械ゲート）。"
        : "";
    const note =
      `（entry_route=${entryRoute}軽量: designingはthin doc＋task列のみで可、critic省略、` +
      `polishのverifierはgeneral×1。${advisor}` +
      "詰まったらgraphhopper_escalateでfullへ昇格）";
    // 単一源泉則: light/advised designingもPHASE_ACTION.designingを基にし、差分は例外条項で明示する
    return `${base}${note}`;
  }
  if (entryRoute === "oracle") {
    return (
      `${base}（entry_route=oracle多角: 開始時にtask(graphhopper-oracle)／` +
      "graphhopper_invoke(agent: 'graphhopper-oracle')で相談1回し、graphhopper_consult_set(kind: 'oracle')で記録（機械ゲート）。stuck時は同session継続）"
    );
  }
  return base;
}

/* 昇格後の次アクション定型文（plugin/MCPの昇格系3箇所の単一源泉） */
export const ESCALATE_NEXT =
  "次: design.mdを肉付けし、task(graphhopper-critic)／graphhopper_invoke(agent: 'graphhopper-critic')で1回レビューしてから implementing へ。polishでは verifier fan-out×3（requirement/behavior/progress）が必須。";

/* jev prompt組立（plugin/MCPのroute toolの単一源泉） */
export function buildJevPrompt(request: string): string {
  return [JEV_ROUTE_PROMPT, "", "やる内容:", request].join("\n");
}

/* selector判定のprompt定数（jev同型。指示文の単一源泉則でgate.tsに置く。
 * design.mdにはprompts.tsと書いたが、判定promptはJEV_ROUTE_PROMPTに倣い
 * gate.tsが正しい置き場所。経緯は .log.md）。出力は1行JSONのみ。
 * advisory-only: 結果の利用はmainのprose判断。現行routerは維持 */
export const SELECTOR_PROMPT = `あなたはverifier編成セレクタ。design抜粋とdiff統計から検証に使うlensを1〜3件選べ。
出力は1行のJSONのみ: {"lenses":["requirement","behavior"],"reason":"..."}
- requirement=設計意図・done定義との一致
- behavior=振る舞い・テスト・副作用
- progress=進捗・残件・タスク列との対応
- general=上記を統合した単発（小規模・単一関心向け）
契約変更・migration・互換性が絡む場合はrequirementを含めよ。
reasonは1行まで。JSON以外の文字を出すな。
判断材料は渡されたテキスト（design抜粋＋diff統計）のみ。探索・診断は不要。`;

/* selector prompt組立（plugin/MCPのselector toolの単一源泉）。
 * (1)入力はdesign抜粋＋diff statのみ（blast radiusは(3)の領分） */
export function buildSelectorPrompt(
  designExcerpt: string,
  diffStat: string,
): string {
  return [
    SELECTOR_PROMPT,
    "",
    "design抜粋:",
    designExcerpt,
    "",
    "diff統計:",
    diffStat,
  ].join("\n");
}

/* selector出力の厳密parse。既知lens 1-3件（重複除去）のみ採用。
 * 不正・空・0件はfallback=true（呼び出し側は従来routerを継続せよ。
 * general倒しはしない＝軽い側に倒さない。jevと同極性） */
export function parseSelectorOutput(text: string | null | undefined): {
  lenses: state.VerifierLens[];
  reason: string;
  fallback: boolean;
} {
  const known: state.VerifierLens[] = [
    "requirement",
    "behavior",
    "progress",
    "general",
  ];
  const fail = (reason: string) => ({ lenses: [], reason, fallback: true });
  if (typeof text !== "string" || text.trim().length === 0) {
    return fail("selector未呼び出し→従来router");
  }
  const m = text.match(/\{[^{}]*"lenses"\s*:\s*\[([^\]]*)\][^{}]*\}/);
  if (!m) return fail("parse失敗→従来router");
  const ids = [...m[1].matchAll(/"([A-Za-z]+)"/g)]
    .map((g) => g[1].toLowerCase())
    .filter((id): id is state.VerifierLens =>
      (known as string[]).includes(id),
    );
  const lenses = [...new Set(ids)].slice(0, 3);
  if (lenses.length === 0) return fail("有効lens 0件→従来router");
  const reason =
    text.match(/"reason"\s*:\s*"([^"]{1,200})"/)?.[1] ?? "selector判定";
  return { lenses, reason, fallback: false };
}

/* stuck発火時のlight/advised自動昇格（designの二本立てトリガーの片方。もう片方はrouter_check）。
 * entry light/advised＋未昇格のときのみescalateEntryRouteし結果を返す。full/昇格済み/direct/oracle/nullはnull */
export function autoEscalateOnStuck(root: string): state.ActiveLoop | null {
  const active = state.getActive(root);
  if (
    !active ||
    (active.state.entry_route !== "light" &&
      active.state.entry_route !== "advised") ||
    active.state.escalated_at
  ) {
    return null;
  }
  return state.escalateEntryRoute(root);
}

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

/* eval_cmd運用中のattempt二重計数への注意文（prose→codeの一歩目。
 * 拒否ではなく注意に留める: attempt(ok:true)のリセットには意味があるため） */
export const EVAL_MANAGED_NOTE =
  "（note: eval_cmd設定中のためfail系はeval側でも計数される。evalかattemptのどちらかに寄せ、二重計上に注意せよ）";

/* 単一driver警告（TUI bind中のgoalへの別session操作）。
 * 拒否ではなく警告に留める: handoff等の正規フローがあるため */
export function foreignBoundNote(boundId: string): string {
  return (
    `（note: goal は別session（${boundId}）にbind中。二重駆動に注意。` +
    `意図的な引き継ぎなら session_id を指定して resume で bind し直せ）`
  );
}

/* design doc構造検証（exit gate用）。骨格の有無だけ見て質は見ない。
 * 質の厳格化は「薄く書いて回避する」自己判断エロージョンを再生産するため。
 * 既存docの見出し実態に合わせた寛容マッチ。欠落キー一覧を返す（空=通過） */
const REQUIRED_SECTIONS: { key: string; match: RegExp }[] = [
  { key: "goal理解", match: /goal理解|^##\s*goal\b/i },
  { key: "現状", match: /現状|背景/ },
  { key: "設計判断", match: /設計判断|決定事項/ },
  { key: "タスク列", match: /タスク/ },
  { key: "棄却", match: /棄却|スコープ外|非対象/ },
];

const TASK_LINE = /^\s*-\s*(\[[ x]\])?\s*\S/m;

export interface DesignTask {
  text: string;
  done: boolean;
}

export interface DesignProgress {
  total: number;
  done: number;
  items: DesignTask[];
}

/* design.md のタスク列抽出（progress素材）。チェックボックス行のみ。
 * 素朴な行パースであり、ネスト・改行またぎは対象外。読取専用 */
export function extractTasks(root: string, goalId: string): DesignProgress {
  let raw: string;
  try {
    raw = decodeUtf8Strict(readFileSync(state.planPath(root, goalId)));
  } catch {
    return { total: 0, done: 0, items: [] };
  }
  const items: DesignTask[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*-\s*\[([ x])\]\s*(\S.*)$/);
    if (!m) continue;
    items.push({ text: (m[2] ?? "").slice(0, 200), done: m[1] === "x" });
  }
  return { total: items.length, done: items.filter((i) => i.done).length, items };
}

export function checkDesignDoc(root: string, goalId: string): string[] {
  let raw: string;
  try {
    raw = decodeUtf8Strict(readFileSync(state.planPath(root, goalId)));
  } catch {
    return ["design doc自体が無い"];
  }
  const headers = raw
    .split("\n")
    .filter((l) => l.startsWith("##"))
    .join("\n");
  const missing = REQUIRED_SECTIONS.filter((s) => !s.match.test(headers)).map(
    (s) => s.key,
  );
  if (!TASK_LINE.test(raw)) missing.push("タスク行（- ...）");
  return missing;
}

/* phase遷移前の機械チェック（plugin/MCP両callerで共有）。
 * 通れば null、ダメならそのまま返す error 文。 */
export function checkPhaseMove(
  root: string,
  to: state.Phase,
): string | null {
  const active = state.getActive(root);
  if (!active) return "error: no active goal";
  if (!state.isLegalPhaseTransition(active.state.phase, to)) {
    return (
      `error: 非法遷移 ${active.state.phase} -> ${to}。` +
      `合法遷移: ${state.LEGAL_TRANSITIONS[active.state.phase].join(", ")}。` +
      `doneへは graphhopper_goal(complete) のみ（verifier cleanガード付き）。`
    );
  }
  if (
    to === "implementing" &&
    active.state.phase === "designing" &&
    state.readConfig(root).require_critic &&
    !active.state.critic_review
  ) {
    return (
      "error: require_critic=true のため designing→implementing には critic_review 記録が必要。" +
      "graphhopper_critic_set で記録してから遷移せよ（opt-in運用なら config で require_critic=false）。"
    );
  }
  // light/advisedのdesigning巻き戻しはescalate経路に限定（escalated_at無しの素の巻き戻しだと
  // ratchet（critic1回＋fan-out×3前提）が成立しない。full/oracleの巻き戻しは許可）
  if (
    to === "designing" &&
    (active.state.phase === "implementing" || active.state.phase === "polish") &&
    (active.state.entry_route === "light" ||
      active.state.entry_route === "advised") &&
    !active.state.escalated_at
  ) {
    return (
      "error: entry_route=light/advised の designing巻き戻しは graphhopper_escalate を使え" +
      "（素の phase 遷移では escalated_at が立たず昇格条件が成立しない）。"
    );
  }
  // 昇格後はcritic1回が必須（escalateの実効条件。proseだけだと素通りするため機械化。
  // legacy（escalated_at null）・fullには影響なし）
  if (
    to === "implementing" &&
    active.state.phase === "designing" &&
    active.state.escalated_at &&
    !active.state.critic_review
  ) {
    return (
      "error: light/advised→full昇格後は designing→implementing に critic_review 記録が必要。" +
      "task(graphhopper-critic)／graphhopper_invoke(agent: 'graphhopper-critic')で肉付けdesignを1回レビューし、graphhopper_critic_set で記録してから遷移せよ。"
    );
  }
  // entry相談ゲート（D/E実効化。proseだけだと素通りするため機械化。
  // 昇格済みはfull扱い＝critic gateのみ。legacy（entry_route null）・full/lightには影響なし）
  if (
    to === "implementing" &&
    active.state.phase === "designing" &&
    !active.state.escalated_at &&
    active.state.entry_route === "advised" &&
    !active.state.advisor_consult
  ) {
    return (
      "error: entry_route=advised の designing→implementing には advisor相談の記録が必要。" +
      "task(graphhopper-advisor)／graphhopper_invoke(agent: 'graphhopper-advisor')で相談1回し、graphhopper_consult_set(kind: 'advisor')で記録してから遷移せよ。"
    );
  }
  if (
    to === "implementing" &&
    active.state.phase === "designing" &&
    !active.state.escalated_at &&
    active.state.entry_route === "oracle" &&
    !active.state.oracle_consult
  ) {
    return (
      "error: entry_route=oracle の designing→implementing には oracle相談の記録が必要。" +
      "task(graphhopper-oracle)／graphhopper_invoke(agent: 'graphhopper-oracle')で相談1回し、graphhopper_consult_set(kind: 'oracle')で記録してから遷移せよ。"
    );
  }
  // scaffoldが自動生成するため、失敗するのは骨格を削った場合のみ。
  // entry_route=light/advisedはthin gate（task列のみ。薄いspecで回し昇格時に肉付けする）
  if (to === "implementing" && active.state.phase === "designing") {
    const missing =
      active.state.entry_route === "light" ||
      active.state.entry_route === "advised"
        ? checkDesignDocThin(root, active.goal.id)
        : checkDesignDoc(root, active.goal.id);
    if (missing.length > 0) {
      return (
        `error: design.md の骨格不足（${missing.join("・")}）。` +
        `scaffold（.graphhopper/plans/${active.goal.id}.md）を埋めてから遷移せよ。` +
        `質の指摘はcriticの領分であり、このゲートは骨格の有無だけを見る。`
      );
    }
  }
  return null;
}

/* continuation文面の単一源泉（plugin idle注入用）。長いという指摘に応え、
 * 状態で3段階に変える（hand-back待ち/静穏時/通常）。長いフィールドは丸める。
 * 詳細は graphhopper_status / resources で引けるため、注入文は喚起に徹する */
const TRUNC_EVAL_CMD = 120;
const TRUNC_REASON = 200;

function trunc(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function continuationText(goal: state.Goal, s: state.LoopState): string {
  const head = `[graphhopper] Goal: "${goal.title}" | phase: ${s.phase}`;
  const notes = s.notes ? `notes: ${s.notes}` : null;
  const v = s.last_verifier;
  // hand-back待ち（drift→design/requirements）: 要旨のみ。詳細はstatusで
  if (v && v.level === "drift" && v.target && v.target !== "implementing") {
    return [
      head,
      `→ 人間の hand-back 待ち (drift -> ${v.target})`,
      trunc(v.reason, TRUNC_REASON),
      notes,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const busy = s.fail_streak > 0 || v || s.router.route || s.eval_cmd;
  // 静穏時（進捗も異常もなし）: 最小表示
  if (!busy) {
    return [
      head,
      notes,
      `Next: ${PHASE_ACTION_SHORT[s.phase]}`,
      "フェーズのexit条件を満たしたら graphhopper_phase で遷移する。",
    ]
      .filter(Boolean)
      .join("\n");
  }
  // 通常: 現行項目＋長いフィールドは丸める
  return [
    head,
    notes,
    s.eval_cmd ? `eval_cmd: ${trunc(s.eval_cmd, TRUNC_EVAL_CMD)}` : null,
    s.router.route
      ? `router: route=${s.router.route} diff_lines=${s.router.diff_lines}${s.router.deep ? " deep" : ""}`
      : null,
    v ? `last_verifier: ${v.level} (${trunc(v.reason, TRUNC_REASON)})` : null,
    s.fail_streak > 0 ? `fail_streak: ${s.fail_streak}` : null,
    `Next: ${PHASE_ACTION_SHORT[s.phase]}`,
    "フェーズのexit条件を満たしたら graphhopper_phase で遷移する。",
    "ブロックしたら回らずに理由を述べて停止。完了したら graphhopper_goal(complete)。無駄な空転は禁止。",
  ]
    .filter(Boolean)
    .join("\n");
}
