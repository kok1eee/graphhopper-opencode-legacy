/**
 * hash検証付きeditの純粋関数（T3）。
 * IO（read/write）は src/index.ts 側。ここは testable な純粋ロジックのみ。
 *
 * hash比較対象は sha1 単独。size/mtime は表示用（mtime比較はtouchで誤拒否するため使わない）。
 */
import { createHash } from "node:crypto";

export function sha1Hex(data: string | Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

/* 厳密UTF-8デコーダ。fatal:true で不正バイトを例外にし、lossy置換（U+FFFD）による
 * 「読込→書戻しで元エンコーディングを恒久喪失」を防ぐ。ignoreBOM:true で BOM は
 * U+FEFF として保持し、書戻し時に BOM が消えないようにする。 */
const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** UTF-8として厳密にデコードする。不正バイトは throw（非UTF-8ファイルは
 * hash/edit の対象外として拒否する）。 */
export function decodeUtf8Strict(buf: Buffer | Uint8Array): string {
  try {
    return utf8Strict.decode(buf);
  } catch {
    throw new Error("file is not valid UTF-8");
  }
}

/** 単一箇所 exact-match を適用する。0件・複数件は throw（呼び出し側で拒否扱い）。 */
export function applySingleEdit(
  content: string,
  oldString: string,
  newString: string,
): string {
  if (!oldString) throw new Error("hash_edit_refused: oldString is empty");
  const first = content.indexOf(oldString);
  if (first === -1) throw new Error("hash_edit_refused: oldString not found");
  if (content.indexOf(oldString, first + 1) !== -1) {
    throw new Error("hash_edit_refused: oldString matches multiple locations");
  }
  return content.slice(0, first) + newString + content.slice(first + oldString.length);
}

/** sha1 検証。mismatch時は期待/現hashを含む Error を throw する。 */
export function verifyHash(actualContent: string | Buffer, expectedHash: string): string {
  const actual = sha1Hex(actualContent);
  if (actual !== expectedHash) {
    throw new Error(
      `hash_edit_refused: hash mismatch (expected=${expectedHash} actual=${actual})`,
    );
  }
  return actual;
}
