/**
 * graphhopper-watch — outbox監視の試作（takt watchの発想の最小版）。
 *
 * .graphhopper/outbox/*.json の出現を監視し、イベントごと設定コマンドを実行する。
 * 会話上の「終わったよ」ではなくプログラムが受け取るための受け口。
 *
 * 使い方: bun src/watch.ts <root> -- <command...>
 * 例: bun src/watch.ts . -- 'echo "$GH_EVENT $GH_GOAL" >> /tmp/gh-events.log'
 * 環境変数: GH_EVENT（種別） GH_GOAL GH_FILE（jsonパス） GH_ROOT
 *
 * 注意: 試作。outbox書き込みは非atomicのためparse失敗時は100ms後に1回再読する。
 * 常駐運用（launchd等）は各自で。終了はSIGINT。
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, watch } from "node:fs";
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

async function handleFile(
  root: string,
  dir: string,
  name: string,
  command: string,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(name)) return;
  const parsed = parseOutboxFileName(name);
  if (!parsed) return;
  const file = join(dir, name);
  for (let i = 0; i < 2; i++) {
    try {
      const raw = readFileSync(file, "utf8");
      JSON.parse(raw); // 読めることの確認（中身は使わない）
      seen.add(name);
      const child = spawn("sh", ["-c", command], {
        cwd: root,
        env: buildEnv(root, file, parsed),
        stdio: "inherit",
      });
      await new Promise<void>((resolvePromise) => {
        child.on("exit", () => resolvePromise());
        child.on("error", () => resolvePromise());
      });
      return;
    } catch {
      await sleep(100);
    }
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const sepIdx = argv.indexOf("--");
  if (sepIdx < 0) {
    console.error("usage: bun src/watch.ts <root> -- <command...>");
    process.exit(1);
  }
  const root = argv[0] ?? process.cwd();
  const command = argv.slice(sepIdx + 1).join(" ");
  if (!command) {
    console.error("usage: bun src/watch.ts <root> -- <command...>");
    process.exit(1);
  }
  const dir = join(root, ".graphhopper", "outbox");
  mkdirSync(dir, { recursive: true });
  const seen = new Set<string>();
  console.log(`[watch] ${dir} を監視中（Ctrl-Cで終了）`);
  watch(dir, (ev, name) => {
    if (ev !== "rename" || typeof name !== "string") return;
    void handleFile(root, dir, name, command, seen);
  });
  process.on("SIGINT", () => {
    console.log("\n[watch] 終了");
    process.exit(0);
  });
}
