// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Stub the picker so we can drive onPick directly without a real raycast.
let captured;
vi.mock("../src/framework/selection/pick.js", () => ({
  attachPicker: (viewer, opts) => { captured = opts; return { setActive: vi.fn(), detach: vi.fn() }; },
}));

// Controllable mock EventSource.
class MockES {
  constructor(url) { this.url = url; this.listeners = {}; MockES.last = this; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, data) { for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) }); }
  emitOpen() { if (this.onopen) this.onopen({}); }
  emitError() { if (this.onerror) this.onerror({}); }
  close() { this.closed = true; }
}

let client;
beforeEach(() => { globalThis.EventSource = MockES; globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => ({}) })); });
afterEach(() => { client?.detach(); document.body.innerHTML = ""; captured = undefined; });

const { createPickRequestClient } = await import("../src/framework/pick-request/client.js");
const { PICK_SERVER_DEFAULT_URL } = await import("../src/framework/pick-request/endpoint.js");

const SERVER = PICK_SERVER_DEFAULT_URL;
const TOKEN = "test-token";

// The pick-server is token-gated. EventSource cannot set headers, so the stream takes
// the token in the query string while POSTs take the header — both must be present or
// every route answers 401.
test("the SSE stream carries the token in the query string", () => {
  client = createPickRequestClient({ serverUrl: SERVER, token: TOKEN, viewer: {}, part: {}, getContext: () => ({}) });
  expect(MockES.last.url).toBe(`${SERVER}/events?token=${TOKEN}`);
});

test("POSTs carry the token in the x-pick-token header", () => {
  client = createPickRequestClient({ serverUrl: SERVER, token: TOKEN, viewer: {}, part: {}, getContext: () => ({}) });
  MockES.last.emit("prompt", { id: "x", index: 0, total: 1, prompt: "click A" });
  captured.onPick({ subPart: "spacer" });
  expect(fetch).toHaveBeenCalledWith(
    `${SERVER}/resolve`,
    expect.objectContaining({ headers: expect.objectContaining({ "x-pick-token": TOKEN }) }),
  );
});

test("a prompt event shows the banner with index/total and arms the picker", () => {
  client = createPickRequestClient({ serverUrl: SERVER, token: TOKEN, viewer: {}, part: {}, getContext: () => ({}) });
  MockES.last.emit("prompt", { id: "x", index: 1, total: 3, prompt: "click the face to fillet" });
  expect(document.body.textContent).toContain("2 of 3");
  expect(document.body.textContent).toContain("click the face to fillet");
  expect(captured.onPick).toBeTypeOf("function");
});

test("a pick POSTs /resolve with the active id+index and the selection", async () => {
  client = createPickRequestClient({ serverUrl: SERVER, token: TOKEN, viewer: {}, part: {}, getContext: () => ({}) });
  MockES.last.emit("prompt", { id: "x", index: 0, total: 1, prompt: "click A" });
  const selection = { subPart: "spacer" };
  captured.onPick(selection);
  expect(fetch).toHaveBeenCalledWith(
    `${SERVER}/resolve`,
    expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "x", index: 0, selection }) }),
  );
});

test("the close (×) button POSTs /cancel for the active id", () => {
  client = createPickRequestClient({ serverUrl: SERVER, token: TOKEN, viewer: {}, part: {}, getContext: () => ({}) });
  MockES.last.emit("prompt", { id: "x", index: 0, total: 1, prompt: "click A" });
  document.querySelector("#pf-pick-close").click();
  expect(fetch).toHaveBeenCalledWith(
    `${SERVER}/cancel`,
    expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "x" }) }),
  );
});

test("a cleared event hides the banner", () => {
  client = createPickRequestClient({ serverUrl: SERVER, token: TOKEN, viewer: {}, part: {}, getContext: () => ({}) });
  MockES.last.emit("prompt", { id: "x", index: 0, total: 1, prompt: "click A" });
  MockES.last.emit("cleared", {});
  expect(document.querySelector("#pf-pick-banner").style.display).toBe("none");
});

test("SSE open event clears the error banner when no prompt is active", () => {
  client = createPickRequestClient({ serverUrl: SERVER, token: TOKEN, viewer: {}, part: {}, getContext: () => ({}) });
  const banner = document.querySelector("#pf-pick-banner");
  // onerror shows the banner
  MockES.last.emitError();
  expect(banner.style.display).toBe("block");
  // onopen (reconnect) with no active prompt should hide it
  MockES.last.emitOpen();
  expect(banner.style.display).toBe("none");
});

test("SSE open event does not hide the banner while a prompt is active", () => {
  client = createPickRequestClient({ serverUrl: SERVER, token: TOKEN, viewer: {}, part: {}, getContext: () => ({}) });
  const banner = document.querySelector("#pf-pick-banner");
  // Arm a prompt, then simulate error then reconnect
  MockES.last.emit("prompt", { id: "x", index: 0, total: 1, prompt: "click A" });
  MockES.last.emitError();
  expect(banner.style.display).toBe("block");
  MockES.last.emitOpen();
  // prompt still active — banner must stay visible
  expect(banner.style.display).toBe("block");
});

// Fix #4: failed /resolve POST surfaces error in banner rather than unhandled rejection
test("a failing /resolve fetch shows error in the banner and does not throw", async () => {
  globalThis.fetch = vi.fn((url) => {
    if (url.includes("/resolve")) return Promise.reject(new Error("network error"));
    return Promise.resolve({ ok: true, json: () => ({}) });
  });
  client = createPickRequestClient({ serverUrl: SERVER, token: TOKEN, viewer: {}, part: {}, getContext: () => ({}) });
  MockES.last.emit("prompt", { id: "x", index: 0, total: 1, prompt: "click A" });
  const banner = document.querySelector("#pf-pick-banner");

  // Drive a pick — the /resolve fetch will reject
  captured.onPick({ subPart: "spacer" });
  // Allow microtasks to settle
  await Promise.resolve();

  expect(banner.style.display).toBe("block");
  expect(banner.textContent).toContain("couldn't reach pick-server");
});

// Click-to-copy button (viewbar): copies the same description an agent gets, locally.
test("the copy button copies the agent description and confirms, without the server", () => {
  const viewbar = document.createElement("div");
  viewbar.id = "viewbar";
  document.body.appendChild(viewbar);
  const writeText = vi.fn();
  Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText }, configurable: true });

  client = createPickRequestClient({ serverUrl: SERVER, token: TOKEN, viewer: {}, part: {}, getContext: () => ({}) });
  const copy = document.querySelector("#copy");
  expect(copy).toBeTruthy();

  copy.click();
  const banner = document.querySelector("#pf-pick-banner");
  expect(banner.style.display).toBe("block");
  expect(banner.textContent).toContain("copy its agent description");

  // Simulate the click on a part (attachPicker is stubbed; captured.onPick is the banner's).
  const selection = { subPart: "spacer", point: [0, 0, 5.2], normal: [1, 0, 0], params: { bore: 3.4 } };
  captured.onPick(selection);

  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText.mock.calls[0][0]).toContain("spacer"); // the formatted agent description
  expect(banner.textContent).toContain("Copied");
  expect(fetch).not.toHaveBeenCalled(); // copy is purely local
});
