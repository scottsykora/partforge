// src/framework/pick-request/server.js
// The Node side of request-a-pick: an http+SSE server holding one active batch,
// a blocking CLI client (requestPicks), and CLI output formatting. 127.0.0.1 only.
import { createServer, request as httpRequest } from "node:http";
import { createBatch, view, resolve, cancel, timeout, result } from "./batch.js";
import { formatSelection } from "../selection/format.js";

const json = (res, code, obj, origin) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": origin || "*" });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve_) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve_(b ? JSON.parse(b) : {}));
});

export function createPickServer({ port = 4518, timeoutMs = 120000 } = {}) {
  let batch = null;        // the one active batch (or null)
  let pending = null;      // { res, timer } — the held POST /request response
  const sseClients = new Set();
  const allSockets = new Set(); // track every socket for forceful teardown

  const sse = (event, data) => {
    for (const res of sseClients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const finish = () => {                 // resolve the held /request with the result
    if (pending) {
      clearTimeout(pending.timer);
      json(pending.res, 200, result(batch));
      pending = null;
    }
    sse("cleared", {});
    batch = null;
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": origin || "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      return res.end();
    }
    const url = req.url.split("?")[0];

    if (req.method === "POST" && url === "/request") {
      if (batch) return json(res, 409, { status: "busy" }, origin);
      const { prompts } = await readBody(req);
      batch = createBatch(prompts || []);
      pending = { res, timer: setTimeout(() => { timeout(batch); finish(); }, timeoutMs) };
      sse("prompt", view(batch));
      return; // held open until finish()
    }
    if (req.method === "GET" && url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
        "access-control-allow-origin": origin || "*",
      });
      res.write(": connected\n\n"); // SSE comment — flushes headers, makes fetch() resolve
      sseClients.add(res);
      if (batch) res.write(`event: prompt\ndata: ${JSON.stringify(view(batch))}\n\n`); // replay current
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (req.method === "POST" && url === "/resolve") {
      const { id, index, selection } = await readBody(req);
      if (batch && id === batch.id) {
        resolve(batch, index, selection);
        if (view(batch).status === "collecting") sse("prompt", view(batch));
        else finish();
      }
      return json(res, 200, { ok: true }, origin);
    }
    if (req.method === "POST" && url === "/cancel") {
      const { id } = await readBody(req);
      if (batch && id === batch.id) { cancel(batch); finish(); }
      return json(res, 200, { ok: true }, origin);
    }
    return json(res, 404, { error: "not found" }, origin);
  });

  server.on("connection", (socket) => {
    allSockets.add(socket);
    socket.on("close", () => allSockets.delete(socket));
  });

  return {
    start: () => new Promise((res_) => server.listen(port, "127.0.0.1", () => res_({ port: server.address().port }))),
    stop: () => new Promise((res_) => {
      // If a batch is active, cancel it and resolve the held /request cleanly
      // so any awaiting requestPicks() gets a result instead of a socket hang-up.
      if (batch) { cancel(batch); finish(); }
      for (const c of sseClients) c.end();
      server.close(() => res_());
      // destroy any lingering sockets (SSE keep-alive) so server.close resolves
      for (const s of allSockets) s.destroy();
    }),
  };
}

// CLI client: POST the prompts and await the held response (blocks until the batch
// reaches a terminal status server-side). Fails fast with a hint if nothing answers.
export function requestPicks({ port = 4518, host = "127.0.0.1", prompts }) {
  return new Promise((resolve_, reject) => {
    const payload = JSON.stringify({ prompts });
    const req = httpRequest(
      { host, port, path: "/request", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve_(JSON.parse(b))); },
    );
    req.on("error", (e) => reject(new Error(`could not reach pick-server on ${host}:${port} (is the app open and \`partforge pick-serve\` running?) — ${e.message}`)));
    req.end(payload);
  });
}

// Human-readable CLI output: one summary line per pick, then the raw JSON to parse.
export function formatPickResult({ status, picks }) {
  const lines = [`status: ${status} (${picks.length} pick${picks.length === 1 ? "" : "s"})`];
  for (const { prompt, selection } of picks) {
    lines.push(`• "${prompt}" → ${formatSelection(selection, { style: "prompt" })}`);
  }
  lines.push("", JSON.stringify({ status, picks }, null, 2));
  return lines.join("\n");
}
