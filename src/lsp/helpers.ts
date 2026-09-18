/** withLspClient: 拡張子→server解決→root解決→取得→try/finally release。 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { BUILTIN_SERVERS, installHint, mergeServers, mergeServersWithWarnings, notConfigured, resolveServerForFile } from "./config";
import { LSPServerManager, commandExists, resolveRootForFile, type LSPClient } from "./client";
import type { LspServerDef } from "./types";

export function languageIdFor(ext: string): string {
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    default:
      return "plaintext";
  }
}

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i).toLowerCase() : "";
}

export function serversFor(extra: LspServerDef[] | undefined): LspServerDef[] {
  return mergeServers(BUILTIN_SERVERS, extra ?? []);
}

/** 結合＋不正エントリ数の警告情報付き（lsp_servers toolが結果に付記する）。 */
export function serversWithWarnings(extra: LspServerDef[] | undefined): {
  servers: LspServerDef[];
  ignored: number;
} {
  return mergeServersWithWarnings(BUILTIN_SERVERS, extra ?? []);
}

/** 失敗時はthrowでなく文字列返却（tool結果として読める形式）。 */
export async function withLspClient<T>(
  filePath: string,
  extraServers: LspServerDef[] | undefined,
  fn: (client: LSPClient, server: LspServerDef, root: string) => Promise<T>,
): Promise<T | string> {
  const servers = serversFor(extraServers);
  const server = resolveServerForFile(filePath, servers);
  if (!server) return notConfigured(filePath);
  if (!commandExists(server.command)) {
    return `LSP server not installed: ${server.command}. ${installHint(server)}`;
  }
  const root = resolveRootForFile(filePath);
  let client: LSPClient;
  try {
    client = await LSPServerManager.getClient(root, server);
  } catch (e) {
    return `LSP start failed: ${server.command}: ${e instanceof Error ? e.message : String(e)}. ${installHint(server)}`;
  }
  try {
    return await fn(client, server, root);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("initializing") || msg.includes("timeout")) {
      return `LSP initializing, retry later: ${msg}`;
    }
    return `LSP request failed: ${msg}`;
  } finally {
    LSPServerManager.release(client);
  }
}

export function readFileText(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export { dirname };
export { extOf };
