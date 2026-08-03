// The session token is the only thing keeping other local processes/pages out of the
// pick-server, so its at-rest file must be owner-only and must not outlive the server.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home;
vi.mock("node:os", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, homedir: () => globalThis.__pfTestHome };
});

const store = await import("../src/framework/pick-request/token-store.js");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pf-token-"));
  globalThis.__pfTestHome = home;
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete globalThis.__pfTestHome; });

test("the token round-trips through a 0600 file under ~/.partforge", () => {
  const path = store.savePickToken(4518, "s3cret");
  expect(path).toBe(join(home, ".partforge", "pick-4518.token"));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(store.loadPickToken(4518)).toBe("s3cret");
});

test("a missing token file reads as null rather than throwing", () => {
  expect(store.loadPickToken(4518)).toBe(null);
});

test("clearing removes the file and is safe to repeat", () => {
  store.savePickToken(4518, "s3cret");
  store.clearPickToken(4518);
  expect(existsSync(store.pickTokenPath(4518))).toBe(false);
  expect(() => store.clearPickToken(4518)).not.toThrow();
});
