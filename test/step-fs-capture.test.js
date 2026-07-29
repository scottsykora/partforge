import { describe, it, expect } from "vitest";
import { stepBytesViaFsCapture } from "../src/framework/geometry/occt-backend.js";

// A fake emscripten oc whose FS.readFile returns `bytes` for any path.
const fakeOc = (bytes) => ({ FS: { readFile: () => bytes } });

describe("stepBytesViaFsCapture", () => {
  it("returns the STEP bytes when the export runs cleanly", () => {
    const oc = fakeOc(new Uint8Array([1, 2, 3, 4]));
    const buf = stepBytesViaFsCapture(oc, () => { oc.FS.readFile("/export.step"); });
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("still returns the bytes when the export THROWS during post-write cleanup", () => {
    // The Safari case: file written + read, then a rawDestructor crash.
    const oc = fakeOc(new Uint8Array([5, 6, 7]));
    const buf = stepBytesViaFsCapture(oc, () => {
      oc.FS.readFile("/export.step");                 // bytes captured
      throw new Error("rawDestructor cleanup crash");  // then it blows up
    });
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([5, 6, 7]));
  });

  it("rethrows if the export fails BEFORE producing any bytes", () => {
    const oc = fakeOc(new Uint8Array([1]));
    expect(() => stepBytesViaFsCapture(oc, () => { throw new Error("build failed"); }))
      .toThrow("build failed");
  });

  it("throws if the export never wrote a .step file", () => {
    const oc = fakeOc(new Uint8Array([1]));
    expect(() => stepBytesViaFsCapture(oc, () => { oc.FS.readFile("/something.brep"); }))
      .toThrow(/no bytes/i);
  });

  it("copies the bytes so later heap mutation can't corrupt the result", () => {
    const heap = new Uint8Array([9, 9, 9]);
    const oc = fakeOc(heap);
    const buf = stepBytesViaFsCapture(oc, () => {
      oc.FS.readFile("/export.step"); // captured (copied)
      heap.fill(0);                    // simulate the heap being reused after
    });
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([9, 9, 9]));
  });

  it("restores oc.FS.readFile afterward, even when the export crashes", () => {
    const orig = () => new Uint8Array([1]);
    const oc = { FS: { readFile: orig } };
    stepBytesViaFsCapture(oc, () => { oc.FS.readFile("/export.step"); throw new Error("boom"); });
    expect(oc.FS.readFile).toBe(orig);
  });
});
