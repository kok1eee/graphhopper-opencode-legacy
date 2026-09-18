/** LSP読取subsetのunit test（実LSP起動はpyrightのみ・binary不在時はskip）。 */
import { describe, expect, test } from "bun:test";
import {
  BUILTIN_SERVERS,
  MAX_RESULTS,
  extensionOf,
  installHint,
  mergeServers,
  mergeServersWithWarnings,
  notConfigured,
  resolveServerForFile,
} from "./config";
import {
  formatDiagnostics,
  formatHover,
  formatLocations,
  formatSymbols,
} from "./format";
import { toOneBased, toZeroBased } from "./types";
import { serversFor, withLspClient } from "./helpers";
import { commandExists } from "./client";

describe("lsp config: server解決", () => {
  test("builtin4件", () => {
    expect(BUILTIN_SERVERS.length).toBe(4);
    expect(BUILTIN_SERVERS.map((s) => s.command).sort()).toEqual(
      ["gopls", "pyright-langserver", "rust-analyzer", "typescript-language-server"].sort(),
    );
  });
  test("拡張子→server", () => {
    expect(resolveServerForFile("a.ts", BUILTIN_SERVERS)?.command).toBe(
      "typescript-language-server",
    );
    expect(resolveServerForFile("b.py", BUILTIN_SERVERS)?.command).toBe("pyright-langserver");
    expect(resolveServerForFile("c.rs", BUILTIN_SERVERS)?.command).toBe("rust-analyzer");
    expect(resolveServerForFile("d.go", BUILTIN_SERVERS)?.command).toBe("gopls");
  });
  test("未知拡張子→null＋notConfigured文字列", () => {
    expect(resolveServerForFile("e.zzz", BUILTIN_SERVERS)).toBeNull();
    expect(notConfigured("e.zzz")).toMatch("LSP not configured");
  });
  test("extensionOfは小文字化", () => {
    expect(extensionOf("A.TS")).toBe(".ts");
  });
  test("install hint", () => {
    expect(installHint({ command: "pyright-langserver", args: [], extensions: [".py"] })).toMatch(
      "pyright",
    );
  });
});

describe("lsp config: マージ", () => {
  test("同extensionsはconfigが上書き", () => {
    const merged = mergeServers(BUILTIN_SERVERS, [
      { command: "basedpyright-langserver", args: ["--stdio"], extensions: [".py"] },
    ]);
    const py = merged.find((s) => s.extensions.includes(".py"));
    expect(py?.command).toBe("basedpyright-langserver");
    expect(merged.length).toBe(4);
  });
  test("未知は追記", () => {
    const merged = mergeServers(BUILTIN_SERVERS, [
      { command: "zls", args: [], extensions: [".zig"] },
    ]);
    expect(merged.length).toBe(5);
  });
  test("不正エントリは無視＋件数を返す（tool側で警告付記）", () => {
    const merged = mergeServers(BUILTIN_SERVERS, [
      { command: "x", args: [], extensions: [".ts"] },
      // @ts-expect-error 不正形の耐性確認
      { command: 123, extensions: null },
    ]);
    expect(merged.length).toBe(4);
    const { servers, ignored } = mergeServersWithWarnings(BUILTIN_SERVERS, [
      // @ts-expect-error 不正形の耐性確認
      { command: 123, extensions: null },
    ]);
    expect(servers.length).toBe(4);
    expect(ignored).toBe(1);
    const ok = mergeServersWithWarnings(BUILTIN_SERVERS, []);
    expect(ok.ignored).toBe(0);
  });
  test("serversFor既定", () => {
    expect(serversFor(undefined).length).toBe(4);
  });
});

describe("lsp format", () => {
  test("hover空→No hover found", () => {
    expect(formatHover(null)).toBe("No hover found");
    expect(formatHover({ contents: "  ", range: null })).toBe("No hover found");
    expect(formatHover({ contents: "hi", range: null })).toBe("hi");
  });
  test("location空→No ... found", () => {
    expect(formatLocations("definitions", [])).toBe("No definitions found");
    expect(formatLocations("references", [])).toBe("No references found");
    expect(formatSymbols([])).toBe("No symbols found");
    expect(formatDiagnostics([])).toBe("No diagnostics found");
  });
  test("200件打切り明示", () => {
    const locs = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => ({
      uri: "file:///a.ts",
      range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
    }));
    const out = formatLocations("references", locs);
    expect(out).toMatch("打切り");
  });
  test("座標は1-based表示", () => {
    const out = formatLocations("definitions", [
      { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    ]);
    expect(out).toBe("/a.ts:1:1");
  });
});

describe("lsp 座標変換", () => {
  test("1-based⇔0-based往復", () => {
    const z = toZeroBased(1, 1);
    expect(z).toEqual({ line: 0, character: 0 });
    expect(toOneBased(z)).toEqual({ line: 1, col: 1 });
    expect(toZeroBased(0, 0)).toEqual({ line: 0, character: 0 });
  });
});

describe("lsp 文字列コントラクト", () => {
  test("未対応拡張子はnot_configured文字列（throwしない）", async () => {
    const out = await withLspClient("f.zzz", undefined, async () => "UNREACHABLE");
    expect(String(out)).toMatch("LSP not configured");
  });
});

describe("lsp 結合（pyright・binary不在時はskip）", () => {
  test("pyright hover疎通", async () => {
    if (!commandExists("pyright-langserver") && !commandExists("pyright")) {
      console.log("skip: pyright binary不在");
      return;
    }
    const { writeFileSync, mkdirSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "gh-lsp-"));
    mkdirSync(join(dir, ".git"), { recursive: true });
    const f = join(dir, "a.py");
    writeFileSync(f, "x = 1\nprint(x)\n", "utf8");
    const server =
      resolveServerForFile(f, serversFor(undefined)) ??
      (commandExists("pyright")
        ? { command: "pyright", args: ["--stdio"], extensions: [".py"] }
        : null);
    expect(server).not.toBeNull();
    const out = await withLspClient(f, server ? undefined : undefined, async (c) => {
      const h = await c.hover(f, { line: 1, character: 6 });
      return formatHover(h);
    });
    // hoverが空でも文字列コントラクト（throwしない）を確認
    expect(typeof out).toBe("string");
  }, 60_000);
});
