import { describe, it, expect } from "vitest";
import { escapeHtml, mdToTelegramHtml, tryMdToHtml, truncateMessage } from "../format";

describe("escapeHtml", () => {
  it("escapes &, <, >", () => {
    expect(escapeHtml("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("mdToTelegramHtml", () => {
  it("converts bold **text**", () => {
    expect(mdToTelegramHtml("**hello**")).toBe("<b>hello</b>");
  });

  it("converts bold __text__", () => {
    expect(mdToTelegramHtml("__hello__")).toBe("<b>hello</b>");
  });

  it("converts italic *text*", () => {
    expect(mdToTelegramHtml("*hello*")).toBe("<i>hello</i>");
  });

  it("converts inline code", () => {
    expect(mdToTelegramHtml("`code`")).toBe("<code>code</code>");
  });

  it("converts code blocks", () => {
    const result = mdToTelegramHtml("```js\nconsole.log(1)\n```");
    expect(result).toBe("<pre>console.log(1)</pre>");
  });

  it("converts headings to bold", () => {
    expect(mdToTelegramHtml("## Title")).toBe("<b>Title</b>");
  });

  it("converts strikethrough", () => {
    expect(mdToTelegramHtml("~~removed~~")).toBe("<s>removed</s>");
  });

  it("escapes HTML in plain text", () => {
    expect(mdToTelegramHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("preserves HTML inside code blocks", () => {
    const result = mdToTelegramHtml("```\n<div>hi</div>\n```");
    expect(result).toContain("&lt;div&gt;hi&lt;/div&gt;");
  });

  it("converts markdown table to box-drawing in <pre>", () => {
    const table = [
      "| Command | Description |",
      "|---|---|",
      "| /cancel | Cancel task |",
      "| /model | Switch model |",
    ].join("\n");
    const result = mdToTelegramHtml(table);
    expect(result).toContain("<pre>");
    expect(result).toContain("┌");
    expect(result).toContain("│ Command");
    expect(result).toContain("│ /cancel");
    expect(result).toContain("│ /model");
    expect(result).toContain("└");
  });

  it("converts table with surrounding text", () => {
    const md = "Here is a table:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nDone.";
    const result = mdToTelegramHtml(md);
    expect(result).toContain("Here is a table:");
    expect(result).toContain("<pre>");
    expect(result).toContain("│ A │ B │");
    expect(result).toContain("│ 1 │ 2 │");
    expect(result).toContain("Done.");
  });

  it("pads columns to equal width", () => {
    const table = "| A | Long Header |\n|---|---|\n| short | x |";
    const result = mdToTelegramHtml(table);
    // "Long Header" is 11 chars, "x" should be padded
    expect(result).toContain("Long Header");
    expect(result).toContain("x ");
  });

  it("leaves non-table pipe text alone", () => {
    const result = mdToTelegramHtml("a | b | c");
    expect(result).toBe("a | b | c");
  });
});

describe("tryMdToHtml", () => {
  it("returns HTML with parseMode", () => {
    const result = tryMdToHtml("**bold**");
    expect(result.text).toBe("<b>bold</b>");
    expect(result.parseMode).toBe("HTML");
  });
});

describe("truncateMessage", () => {
  it("returns short text unchanged", () => {
    expect(truncateMessage("hello", 10)).toBe("hello");
  });

  it("truncates long text", () => {
    const long = "a".repeat(100);
    const result = truncateMessage(long, 50);
    expect(result.length).toBeLessThanOrEqual(70); // 50 + truncation marker
    expect(result).toContain("[truncated]");
  });
});
