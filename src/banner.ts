import * as fs from "fs";
import * as path from "path";

function getVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

let _bannerCleanup: (() => void) | null = null;

/** Stop listening for terminal resize (call before prompts / further output). */
export function stopBannerResize(): void {
  if (_bannerCleanup) {
    _bannerCleanup();
    _bannerCleanup = null;
  }
}

export function printBanner(contentLines?: string[]): void {
  stopBannerResize();

  const version = getVersion();
  const tty = process.stdout.isTTY;
  const c = tty ? "\x1b[36m" : "";
  const r = tty ? "\x1b[0m" : "";
  const d = tty ? "\x1b[2m" : "";
  const bo = tty ? "\x1b[1m" : "";

  function render(cols: number): string[] {
    const inner = cols - 2;

    const dw = (s: string): number => {
      let n = 0;
      for (const ch of s) {
        const cp = ch.codePointAt(0) || 0;
        n += (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x33BF) ||
          (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0xA4CF) ||
          (cp >= 0xAC00 && cp <= 0xD7FF) || (cp >= 0xF900 && cp <= 0xFAFF) ||
          (cp >= 0xFE30 && cp <= 0xFE6F) || (cp >= 0xFF01 && cp <= 0xFF60) ||
          (cp >= 0x20000 && cp <= 0x2FA1F) ? 2 : 1;
      }
      return n;
    };

    const fit = (s: string, w: number): string => {
      const sw = dw(s);
      if (sw <= w) return s + " ".repeat(w - sw);
      let out = "", ow = 0;
      for (const ch of s) {
        const cw = dw(ch);
        if (ow + cw > w - 1) break;
        out += ch; ow += cw;
      }
      return out + "\u2026" + " ".repeat(Math.max(0, w - ow - 1));
    };

    const row = (content: string) => c + "\u2502" + r + content + c + "\u2502" + r;
    const empty = () => c + "\u2502" + " ".repeat(inner) + "\u2502" + r;

    const titlePlain = `RemoteCode v${version}`;
    const topFill = Math.max(0, inner - titlePlain.length - 3);

    const out: string[] = [
      "",
      c + "\u256D\u2500 " + bo + "RemoteCode" + r + c + " v" + version + " " + "\u2500".repeat(topFill) + "\u256E" + r,
      empty(),
    ];

    if (contentLines && contentLines.length > 0) {
      for (const cl of contentLines) {
        if (cl.startsWith("---")) {
          const label = cl.slice(3).trim();
          out.push(empty());
          if (label) {
            const text = "-- " + label + " ---";
            const pad = Math.max(0, inner - text.length - 2);
            out.push(c + "\u2502" + r + d + "  " + text + r + " ".repeat(pad) + c + "\u2502" + r);
          }
        } else {
          out.push(row(fit("  " + cl, inner)));
        }
      }
      out.push(empty());
    }

    out.push(c + "\u2570" + "\u2500".repeat(inner) + "\u256F" + r);
    out.push("");
    return out;
  }

  // Track visible width of each line from previous render
  // so we can calculate how many visual rows they occupy after wrapping
  let prevWidths: number[] = [];

  function draw(): void {
    const cols = Math.max(24, process.stdout.columns || 80);

    // Erase previous render, accounting for line wrapping
    if (prevWidths.length > 0 && tty) {
      let up = 0;
      for (const w of prevWidths) {
        up += w === 0 ? 1 : Math.ceil(w / cols);
      }
      process.stdout.write(`\x1b[${up}A\x1b[0J`);
    }

    const lines = render(cols);
    // Store visible widths (ANSI stripped) for next redraw
    prevWidths = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").length);
    process.stdout.write(lines.join("\n") + "\n");
  }

  draw();

  // Listen for terminal resize and redraw
  if (tty) {
    let active = true;
    const onResize = () => { if (active) draw(); };
    process.stdout.on("resize", onResize);
    _bannerCleanup = () => {
      active = false;
      process.stdout.removeListener("resize", onResize);
    };
  }
}
