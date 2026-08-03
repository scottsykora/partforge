// Loopback gate for request-a-pick. `?pickserver=` is attacker-suppliable (anyone can
// send the developer a link), so anything that is not the local machine must be
// refused rather than dialled.
import { expect, test, vi } from "vitest";
import {
  isLoopbackOrigin, isLoopbackHost, isLoopbackUrl, resolvePickServerUrl,
  PICK_SERVER_DEFAULT_PORT, PICK_SERVER_DEFAULT_URL,
} from "../src/framework/pick-request/endpoint.js";

test("the default port and URL are stated once", () => {
  expect(PICK_SERVER_DEFAULT_PORT).toBe(4518);
  expect(PICK_SERVER_DEFAULT_URL).toBe("http://127.0.0.1:4518");
});

test("loopback origins are accepted on any port", () => {
  for (const o of ["http://localhost:5173", "http://127.0.0.1:4518", "http://[::1]:8080", "https://localhost:5173", "http://127.2.3.4:1"]) {
    expect(isLoopbackOrigin(o), o).toBe(true);
  }
});

test("anything that is not loopback is rejected as an origin", () => {
  for (const o of ["https://evil.example", "http://0.0.0.0:4518", "http://192.168.1.5:4518",
                   "http://localhost.evil.example", "file://", "null", "", undefined, "http://[::2]:4518"]) {
    expect(isLoopbackOrigin(o), String(o)).toBe(false);
  }
});

test("Host must name loopback AND our port", () => {
  expect(isLoopbackHost("127.0.0.1:4518", 4518)).toBe(true);
  expect(isLoopbackHost("localhost:4518", 4518)).toBe(true);
  expect(isLoopbackHost("[::1]:4518", 4518)).toBe(true);
  expect(isLoopbackHost("127.0.0.1:4519", 4518)).toBe(false); // wrong port
  expect(isLoopbackHost("127.0.0.1", 4518)).toBe(false);      // implied port 80
  expect(isLoopbackHost("evil.example:4518", 4518)).toBe(false);
  expect(isLoopbackHost(undefined, 4518)).toBe(false);
});

test("isLoopbackUrl mirrors the origin rule", () => {
  expect(isLoopbackUrl("http://127.0.0.1:4518")).toBe(true);
  expect(isLoopbackUrl("https://evil.example")).toBe(false);
});

test("resolvePickServerUrl falls back to the default for a remote target and says why", () => {
  const onReject = vi.fn();
  expect(resolvePickServerUrl("https://evil.example", { onReject })).toBe(PICK_SERVER_DEFAULT_URL);
  expect(onReject).toHaveBeenCalledWith("https://evil.example");
});

test("resolvePickServerUrl keeps a loopback target and trims a trailing slash", () => {
  expect(resolvePickServerUrl("http://localhost:9999/")).toBe("http://localhost:9999");
  expect(resolvePickServerUrl("")).toBe(PICK_SERVER_DEFAULT_URL);   // bare ?pickserver
  expect(resolvePickServerUrl(null)).toBe(PICK_SERVER_DEFAULT_URL);
});
