/**
 * LSP server解決（自前実装）。OmOのserver表は持ち込まず、v1最小4件のみ。
 */
import type { LspServerDef } from "./types";

export const MAX_RESULTS = 200;

export const BUILTIN_SERVERS: LspServerDef[] = [
  {
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  },
  {
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py"],
  },
  { command: "rust-analyzer", args: [], extensions: [".rs"] },
  { command: "gopls", args: [], extensions: [".go"] },
];

/** pyrightは `pyright` binaryではなく `pyright-langserver` / `basedpyright` でも動く。 */
const PYRIGHT_ALIASES = ["pyright-langserver", "basedpyright-langserver", "pyright"];

export function extensionOf(filePath: string): string {
  const i = filePath.lastIndexOf(".");
  return i >= 0 ? filePath.slice(i).toLowerCase() : "";
}

/** builtin＋config追加分を結合。同extensionsはconfigが上書き、未知は追記。 */
export function mergeServers(
  builtin: LspServerDef[],
  extra: LspServerDef[],
): LspServerDef[] {
  return mergeServersWithWarnings(builtin, extra).servers;
}

function isValidServerDef(e: unknown): e is LspServerDef {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o["command"] === "string" &&
    Array.isArray(o["extensions"]) &&
    (o["args"] === undefined || Array.isArray(o["args"]))
  );
}

/** 結合＋無視した不正エントリ数。不正は無視し、件数はtool結果に警告付記する（throwしない）。 */
export function mergeServersWithWarnings(
  builtin: LspServerDef[],
  extra: LspServerDef[],
): { servers: LspServerDef[]; ignored: number } {
  const out = builtin.map((s) => ({ ...s, extensions: [...s.extensions] }));
  let ignored = 0;
  for (const e of extra ?? []) {
    if (!isValidServerDef(e)) {
      ignored++;
      continue;
    }
    const idx = out.findIndex((b) =>
      b.extensions.some((x) => e.extensions.includes(x)),
    );
    if (idx >= 0) {
      out[idx] = {
        command: e.command,
        args: Array.isArray(e.args) ? [...e.args] : [],
        extensions: [...e.extensions],
      };
    } else {
      out.push({
        command: e.command,
        args: Array.isArray(e.args) ? [...e.args] : [],
        extensions: [...e.extensions],
      });
    }
  }
  return { servers: out, ignored };
}

export function resolveServerForFile(
  filePath: string,
  servers: LspServerDef[],
): LspServerDef | null {
  const ext = extensionOf(filePath);
  if (!ext) return null;
  return servers.find((s) => s.extensions.includes(ext)) ?? null;
}

export function installHint(server: LspServerDef): string {
  const c = server.command;
  if (c === "typescript-language-server")
    return "Hint: npm i -g typescript typescript-language-server";
  if (PYRIGHT_ALIASES.includes(c) || c === "pyright")
    return "Hint: npm i -g pyright または pip install pyright";
  if (c === "rust-analyzer") return "Hint: rustup component add rust-analyzer";
  if (c === "gopls") return "Hint: go install golang.org/x/tools/gopls@latest";
  return `Hint: install "${c}" and ensure it is on PATH`;
}

export function notConfigured(filePath: string): string {
  return `LSP not configured for ${extensionOf(filePath) || "(no extension)"} (${filePath})`;
}
