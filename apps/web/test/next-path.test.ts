import { describe, expect, it } from "vitest";
import { safeNextPath } from "../lib/next-path";

const O = "https://self.example";

describe("safeNextPath", () => {
  it("keeps a same-site path with query and hash", () =>
    expect(safeNextPath("/projects/x?a=1#h", O)).toBe("/projects/x?a=1#h"));
  it("defaults when missing", () => expect(safeNextPath(null, O)).toBe("/projects"));
  it.each([
    "//evil.com",
    "/\\evil.com",
    "javascript:alert(1)",
    `${O}//evil.com`,
    `${O}/\\evil.com`,
    "https://evil.com/projects",
    "/login?next=/x",
  ])("rejects %s", (n) => expect(safeNextPath(n, O)).toBe("/projects"));
  // These parse to harmless same-site paths (never protocol-relative).
  it("keeps encoded slashes as a same-site path", () => expect(safeNextPath("%2f%2fevil.com", O)).toBe("/%2f%2fevil.com"));
  it("normalises backslash-userinfo to a same-site path", () => expect(safeNextPath(`${O}\\@evil.com`, O)).toBe("/@evil.com"));
});
