import { logger } from "./logger";

/** Parse a JSONL string, yielding each valid entry. Invalid lines are skipped with debug logging. */
export function* parseJsonlLines(content: string, tag: string = "jsonl"): Generator<Record<string, unknown>> {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as Record<string, unknown>;
    } catch {
      logger.debug(tag, `skipped invalid JSONL line: ${line.slice(0, 80)}`);
    }
  }
}

/** Extract text content from a message content field (string or content-block array). */
export function extractMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return "";
}

/** Clean a user message for display: strip "User said:" prefix, reply directives, and image paths. */
export function cleanUserMessage(text: string): string {
  let msg = text;
  if (msg.startsWith("User said:\n")) msg = msg.slice("User said:\n".length);
  msg = msg.replace(/\n+Reply concisely\.?\s*$/, "");
  msg = msg.replace(/\n+Image file path\(s\):.*/s, "");
  return msg.trim();
}

/** Clean a user message and produce a short preview (for session list). Returns null if unrenderable. */
export function cleanFirstMessage(text: string): string | null {
  const msg = cleanUserMessage(text);
  if (!msg || msg.startsWith("<") || msg.startsWith("#")) return null;
  const firstLine = msg.split("\n", 1)[0].trim();
  if (!firstLine) return null;
  if (firstLine.length > 60) return firstLine.slice(0, 57) + "...";
  return firstLine;
}
