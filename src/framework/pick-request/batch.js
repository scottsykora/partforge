// Pure state machine for one batch of click requests: ordered prompts in,
// ordered picks out. No http, no DOM, no timers (the server owns the clock).
import { randomUUID } from "node:crypto";

export function createBatch(prompts) {
  return { id: randomUUID(), prompts: [...prompts], picks: [], index: 0, status: "collecting" };
}

export function view(batch) {
  const collecting = batch.status === "collecting";
  return {
    id: batch.id,
    index: batch.index,
    total: batch.prompts.length,
    prompt: collecting ? batch.prompts[batch.index] : null,
    status: batch.status,
  };
}

// Record a click for the current step. Ignores a non-collecting batch or an index
// that isn't the one we're waiting on (stale/duplicate click guard).
export function resolve(batch, index, selection) {
  if (batch.status !== "collecting" || index !== batch.index) return batch;
  batch.picks.push({ prompt: batch.prompts[batch.index], selection });
  batch.index += 1;
  if (batch.index >= batch.prompts.length) batch.status = "done";
  return batch;
}

export function cancel(batch) {
  if (batch.status === "collecting") batch.status = "cancelled";
  return batch;
}

export function timeout(batch) {
  if (batch.status === "collecting") batch.status = "timeout";
  return batch;
}

export function result(batch) {
  return { status: batch.status, picks: batch.picks };
}
