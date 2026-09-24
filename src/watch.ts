/**
 * graphhopper-watch — outbox監視（takt watchの発想の最小版）。
 *
 * .graphhopper/outbox/*.json の出現を監視し、イベントごと設定コマンドを実行する。
 * 会話上の「終わったよ」ではなくプログラムが受け取るための受け口。
 *
 * 使い方:
 *   bun src/watch.ts <root> -- <command...>   # 任意コマンド実行
 *   bun src/watch.ts <root> --notify           # macOS通知プリセット
 *   bun src/watch.ts <root> --notify -- <command...>  # 両方
 * 例: bun src/watch.ts . -- 'echo "$GH_EVENT $GH_GOAL" >> /tmp/gh-events.log'
 * 環境変数: GH_EVENT（種別） GH_GOAL GH_FILE（jsonパス） GH_ROOT
 *
 * 注意: outbox書き込みは非atomicのためparse失敗時は100ms後に1回再読する。
 * 常駐運用（launchd等）は各自で。終了はSIGINT。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";

export interface OutboxEvent {
  event: string;
  goal: string;
  file: string;
}

/** ファイル名 `<ts>-<type>-<goal>.json` のパース。純粋関数 */
export function parseOutboxFileName(name: string): Omit<OutboxEvent, "file"> | null {
  if (!name.endsWith(".json")) return null;
  const body = name.slice(0, -".json".length);
  // ts部に `-` を含む（ISO変形）ため後ろ2分割で復元する
  const parts = body.split("-");
  if (parts.length < 3) return null;
  const goal = parts[parts.length - 1] ?? "";
  const type = parts[parts.length - 2] ?? "";
  const ts = parts.slice(0, -2).join("-");
  if (!type || !goal) return null;
  void ts;
  return { event: type, goal };
}

export function buildEnv(
  root: string,
  file: string,
  parsed: Omit<OutboxEvent, "file">,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GH_ROOT: root,
    GH_FILE: file,
    GH_EVENT: parsed.event,
    GH_GOAL: parsed.goal,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/* 通知対象種別（human push）。driftは正常フロー内のため対象外（chatty防止） */
const NOTIFY_EVENTS: Record<string, string> = {
  goal_complete: "完了",
  eval_gave_up: "paused・要修正（連続失敗上限）",
  loop_stopped: "paused（無限ループ検知）",
};

export interface NotifyContent {
  title: string;
  body: string;
}

/** macOS通知文の組み立て。対象外種別は null。純粋関数 */
export function notifyMessage(
  event: string,
  goal: string,
  extra: { score?: unknown; title?: unknown },
): NotifyContent | null {
  const label = NOTIFY_EVENTS[event];
  if (!label) return null;
  const title = typeof extra.title === "string" && extra.title ? extra.title : goal;
  let body = `${label}: ${goal}`;
  if (event === "goal_complete" && typeof extra.score === "number") {
    body += ` (score ${extra.score})`;
  }
  return { title: `graphhopper: ${title}`, body };
}

/** goal titleの解決（best-effort。読めなければgoal id） */
export function resolveGoalTitle(root: string, goalId: string): string {
  try {
    const p = join(root, ".graphhopper", "goals.json");
    if (!existsSync(p)) return goalId;
    const data = JSON.parse(readFileSync(p, "utf8")) as {
      goals?: { id?: unknown; title?: unknown }[];
    };
    for (const g of data.goals ?? []) {
      if (g.id === goalId && typeof g.title === "string" && g.title) return g.title;
    }
  } catch {
    // best-effort
  }
  return goalId;
}

function sendMacNotify(title: string, body: string): void {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    execFileSync("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {
    // 通知失敗は無視（本線ではない）
  }
}

async function handleFile(
  root: string,
  dir: string,
  name: string,
  command: string,
  notify: boolean,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(name)) return;
  const parsed = parseOutboxFileName(name);
  if (!parsed) return;
  const file = join(dir, name);
  for (let i = 0; i < 2; i++) {
    try {
      const raw = readFileSync(file, "utf8");
      const data = JSON.parse(raw) as Record<string, unknown>;
      seen.add(name);
      if (notify) {
        const msg = notifyMessage(parsed.event, parsed.goal, {
          score: data["score"],
          title: resolveGoalTitle(root, parsed.goal),
        });
        if (msg) sendMacNotify(msg.title, msg.body);
      }
      if (command) {
        const child = spawn("sh", ["-c", command], {
          cwd: root,
          env: buildEnv(root, file, parsed),
          stdio: "inherit",
        });
        await new Promise<void>((resolvePromise) => {
          child.on("exit", () => resolvePromise());
          child.on("error", () => resolvePromise());
        });
      }
      return;
    } catch {
      await sleep(100);
    }
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const notify = argv.includes("--notify");
  const rest = argv.filter((a) => a !== "--notify");
  const sepIdx = rest.indexOf("--");
  const head = sepIdx < 0 ? rest : rest.slice(0, sepIdx);
  const root = head[0] ?? process.cwd();
  const command = sepIdx < 0 ? "" : rest.slice(sepIdx + 1).join(" ");
  if (!notify && !command) {
    console.error("usage: bun src/watch.ts <root> [--notify] [-- <command...>]");
    process.exit(1);
  }
  const dir = join(root, ".graphhopper", "outbox");
  mkdirSync(dir, { recursive: true });
  const seen = new Set<string>();
  console.log(`[watch] ${dir} を監視中（notify=${notify ? "on" : "off"}、Ctrl-Cで終了）`);
  watch(dir, (ev, name) => {
    if (ev !== "rename" || typeof name !== "string") return;
    void handleFile(root, dir, name, command, notify, seen);
  });
  process.on("SIGINT", () => {
    console.log("\n[watch] 終了");
    process.exit(0);
  });
}
