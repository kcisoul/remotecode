export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

export function truncateMessage(text: string, limit: number = 3500): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n...[truncated]";
}
