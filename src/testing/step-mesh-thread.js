// src/testing/step-mesh-thread.js — runs INSIDE the worker_thread only.
import { parentPort, workerData } from "node:worker_threads";
import { bootOcctKernel } from "./occt.js";

const kernel = await bootOcctKernel();
const out = [];
const transfer = [];
for (const { name, bytes, digest } of workerData) {
  await kernel._registerImport({ name, digest, step: bytes });
  const { positions, indices } = kernel.import(name).toIndexedMesh({ quality: "print" });
  out.push({ name, digest, positions, indices });
  transfer.push(positions.buffer, indices.buffer);
}
parentPort.postMessage(out, transfer);
process.exit(0);
