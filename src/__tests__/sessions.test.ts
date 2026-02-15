import { describe, it, expect } from "vitest";
import { formatTimeAgo, formatSessionLabel, SessionInfo } from "../sessions";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "00000000-0000-0000-0000-000000000000",
    slug: null,
    project: "/home/user/project",
    projectName: "project",
    lastModified: Date.now() / 1000,
    firstMessage: null,
    lastMessage: null,
    ...overrides,
  };
}

describe("formatTimeAgo", () => {
  it("returns 'just now' for < 60s", () => {
    expect(formatTimeAgo(Date.now() / 1000 - 10)).toBe("just now");
  });

  it("returns minutes ago", () => {
    expect(formatTimeAgo(Date.now() / 1000 - 300)).toBe("5m ago");
  });

  it("returns hours ago", () => {
    expect(formatTimeAgo(Date.now() / 1000 - 7200)).toBe("2h ago");
  });

  it("returns days ago", () => {
    expect(formatTimeAgo(Date.now() / 1000 - 172800)).toBe("2d ago");
  });
});

describe("formatSessionLabel", () => {
  it("shows project + firstMessage", () => {
    const s = makeSession({ firstMessage: "hello world" });
    expect(formatSessionLabel(s)).toBe("project - hello world");
  });

  it("truncates long firstMessage", () => {
    const s = makeSession({ firstMessage: "a".repeat(50) });
    const label = formatSessionLabel(s);
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label).toContain("...");
  });

  it("falls back to slug", () => {
    const s = makeSession({ slug: "my-slug" });
    expect(formatSessionLabel(s)).toBe("project (my-slug)");
  });

  it("falls back to project name only", () => {
    const s = makeSession();
    expect(formatSessionLabel(s)).toBe("project");
  });
});
