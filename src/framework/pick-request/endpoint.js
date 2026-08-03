// Shared constants + loopback checks for request-a-pick. Deliberately free of both
// node: imports and DOM access: the browser client, mount.js, the Node server, and
// the CLI all need these, and the browser side must never pull in node:http.
//
// Why loopback matters: the pick-server streams the agent's prompts and receives the
// user's selection (including live parameter values). Both ends must be pinned to the
// local machine — an arbitrary `?pickserver=https://evil.example` would ship every
// click off-box, and an arbitrary reflected CORS origin would let any page the user
// visits read the stream.
export const PICK_SERVER_DEFAULT_PORT = 4518;
export const PICK_SERVER_DEFAULT_TIMEOUT_MS = 120000;
export const PICK_SERVER_DEFAULT_HOST = "127.0.0.1";
export const PICK_SERVER_DEFAULT_URL = `http://${PICK_SERVER_DEFAULT_HOST}:${PICK_SERVER_DEFAULT_PORT}`;

// The whole 127/8 block plus the IPv6 loopback and the `localhost` name. Anything
// else (including 0.0.0.0 and names that merely resolve to 127.0.0.1) is rejected —
// a DNS name is exactly the DNS-rebinding vector we are guarding against.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "::1", "[::1]"]);
const isLoopbackHostname = (h) =>
  LOOPBACK_HOSTNAMES.has(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);

// `origin` is an HTTP Origin header value: scheme://host[:port], no path.
export function isLoopbackOrigin(origin) {
  if (typeof origin !== "string" || origin === "") return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return isLoopbackHostname(u.hostname);
}

// `host` is an HTTP Host header value: host[:port], no scheme. A Host that names
// anything but loopback means the request arrived through a rebound DNS name.
export function isLoopbackHost(host, port) {
  if (typeof host !== "string" || host === "") return false;
  let u;
  try { u = new URL(`http://${host}`); } catch { return false; }
  if (!isLoopbackHostname(u.hostname)) return false;
  // An explicit port must be ours; a bare host means port 80, which we never bind.
  return u.port !== "" && Number(u.port) === Number(port);
}

export function isLoopbackUrl(url) {
  if (typeof url !== "string" || url === "") return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return isLoopbackHostname(u.hostname);
}

// Normalise a user-supplied `?pickserver=` value to an origin we are willing to talk
// to. Anything non-loopback falls back to the default and reports why, so a tampered
// URL degrades to "talks to the local server" rather than "exfiltrates every click".
export function resolvePickServerUrl(raw, { onReject } = {}) {
  if (typeof raw !== "string" || raw === "") return PICK_SERVER_DEFAULT_URL;
  if (!isLoopbackUrl(raw)) {
    onReject?.(raw);
    return PICK_SERVER_DEFAULT_URL;
  }
  return raw.replace(/\/+$/, ""); // paths are appended verbatim; no double slash
}
