export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- markdown table → bullet list conversion ----------
function convertTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Detect table: header row with |, separator row with |---
    if (
      i + 1 < lines.length &&
      /^\|(.+\|)+\s*$/.test(lines[i]) &&
      /^\|[\s:]*-+/.test(lines[i + 1])
    ) {
      const headers = lines[i].split("|").map(c => c.trim()).filter(Boolean);
      const rows: string[][] = [];
      i += 2; // skip header + separator

      while (i < lines.length && /^\|(.+\|)+\s*$/.test(lines[i])) {
        rows.push(lines[i].split("|").map(c => c.trim()).filter(Boolean));
        i++;
      }

      const bulletLines: string[] = [];
      for (const row of rows) {
        bulletLines.push(`• ${headers[0]}: ${row[0] || ""}`);
        for (let c = 1; c < headers.length; c++) {
          bulletLines.push(`  ${headers[c]}: ${row[c] || ""}`);
        }
        bulletLines.push("");
      }
      // Remove trailing empty line
      if (bulletLines.length > 0 && bulletLines[bulletLines.length - 1] === "") {
        bulletLines.pop();
      }

      result.push(...bulletLines);
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

export function mdToTelegramHtml(md: string): string {
  let text = md;

  // Extract code blocks first to protect them
  const codeBlocks: string[] = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre>${escapeHtml(code.trimEnd())}</pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Extract inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // Convert markdown tables to bullet lists
  text = convertTables(text);

  // Escape remaining HTML
  text = escapeHtml(text);

  // Bold **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic *text* or _text_
  text = text.replace(/\*(.+?)\*/g, "<i>$1</i>");
  text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");

  // Headings -> bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Strikethrough ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Restore code blocks and inline codes
  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx) => codeBlocks[Number(idx)]);
  text = text.replace(/\x00INLINE(\d+)\x00/g, (_match, idx) => inlineCodes[Number(idx)]);

  return text;
}

export function tryMdToHtml(text: string): { text: string; parseMode?: string } {
  try {
    const html = mdToTelegramHtml(text);
    return { text: html, parseMode: "HTML" };
  } catch {
    return { text };
  }
}

export function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "").trim();
}

export function truncateMessage(text: string, limit: number = 3500): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n...[truncated]";
}

// ---------- tool description formatting ----------

function formatToolDetail(toolName: string, input: Record<string, unknown>): string {
  const e = escapeHtml;
  switch (toolName) {
    case "Bash":
      return `${e(String(input.command || "").slice(0, 200))}`;
    case "Edit":
    case "Write":
    case "Read":
      return `${e(String(input.file_path || ""))}`;
    case "Glob":
    case "Grep":
      return `${e(String(input.pattern || ""))}`;
    case "Task":
      return `${e(String(input.description || ""))}`;
    case "WebSearch":
      return `${e(String(input.query || "").slice(0, 200))}`;
    case "WebFetch":
      return `${e(String(input.url || "").slice(0, 200))}`;
    case "NotebookEdit":
      return `${e(String(input.notebook_path || ""))}`;
    case "Skill":
      return `${e(String(input.skill || ""))}`;
    default:
      return "";
  }
}

export function detectBashLang(command: string): string {
  const cmd = command.trimStart();
  if (/^python[23]?\s/.test(cmd)) return "python";
  if (/^node\s/.test(cmd)) return "javascript";
  if (/^ruby\s/.test(cmd)) return "ruby";
  if (/^go\s/.test(cmd)) return "go";
  if (/^cargo\s|^rustc\s/.test(cmd)) return "rust";
  if (/^swift\s|^swiftc\s/.test(cmd)) return "swift";
  if (/^java\s|^javac\s|^gradle\s|^mvn\s/.test(cmd)) return "java";
  return "bash";
}

function toolLanguage(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash": return detectBashLang(String(input.command || ""));
    case "Edit":
    case "Write":
    case "Read":
    case "Glob":
    case "Grep": return "bash";
    case "WebSearch":
    case "WebFetch": return "bash";
    case "Task": return "bash";
    default: return "bash";
  }
}

export function formatToolDescription(toolName: string, input: Record<string, unknown>): string {
  const lang = toolLanguage(toolName, input);
  const detail = formatToolDetail(toolName, input);
  if (detail) {
    return `<pre><code class="language-${lang}">${escapeHtml(toolName)}: ${detail}</code></pre>`;
  }
  return `<pre><code class="language-${lang}">${escapeHtml(toolName)}</code></pre>`;
}
