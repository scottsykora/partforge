// Where `partforge pick-serve` leaves the session token so that `partforge pick`,
// which runs in a *different* process, can authenticate without the agent copying it
// by hand. Node-only — never imported by the browser client.
//
// The file is the token's only at-rest home: 0600 inside a 0700 directory under the
// user's home, not a world-readable temp dir, and removed when the server stops.
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = () => join(homedir(), ".partforge");
export const pickTokenPath = (port) => join(dir(), `pick-${port}.token`);

export function savePickToken(port, token) {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  writeFileSync(pickTokenPath(port), token, { mode: 0o600 });
  return pickTokenPath(port);
}

export function loadPickToken(port) {
  try {
    const t = readFileSync(pickTokenPath(port), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

export function clearPickToken(port) {
  try { rmSync(pickTokenPath(port)); } catch { /* already gone — nothing to clean */ }
}
