import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { readKvFile, readEnvLines, writeEnvLines } from "../config";

describe("readKvFile", () => {
  const tmpFile = path.join(os.tmpdir(), `remotecode_test_kv_${Date.now()}.txt`);

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it("returns empty object for non-existent file", () => {
    expect(readKvFile("/tmp/does-not-exist-xyz.txt")).toEqual({});
  });

  it("parses key=value pairs", () => {
    fs.writeFileSync(tmpFile, "FOO=bar\nBAZ=qux\n");
    expect(readKvFile(tmpFile)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips comments and empty lines", () => {
    fs.writeFileSync(tmpFile, "# comment\n\nKEY=val\n");
    expect(readKvFile(tmpFile)).toEqual({ KEY: "val" });
  });

  it("handles values with = sign", () => {
    fs.writeFileSync(tmpFile, "TOKEN=abc=def=ghi\n");
    expect(readKvFile(tmpFile)).toEqual({ TOKEN: "abc=def=ghi" });
  });
});

describe("readEnvLines / writeEnvLines", () => {
  const tmpFile = path.join(os.tmpdir(), `remotecode_test_env_${Date.now()}.txt`);

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  });

  it("returns empty array for non-existent file", () => {
    expect(readEnvLines("/tmp/does-not-exist-xyz.txt")).toEqual([]);
  });

  it("round-trips lines", () => {
    const lines = ["FOO=bar", "BAZ=qux"];
    writeEnvLines(tmpFile, lines);
    const read = readEnvLines(tmpFile);
    expect(read).toContain("FOO=bar");
    expect(read).toContain("BAZ=qux");
  });
});
