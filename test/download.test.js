// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { triggerDownload, downloadParts } from "../src/framework/download.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("triggerDownload with a sink", () => {
  it("calls the sink with {data,filename,mime} and touches no DOM", () => {
    const sink = vi.fn();
    const createEl = vi.spyOn(document, "createElement");
    const bytes = new Uint8Array([1, 2, 3]);
    triggerDownload(bytes, "box.step", "application/step", sink);
    expect(sink).toHaveBeenCalledWith({ data: bytes, filename: "box.step", mime: "application/step" });
    expect(createEl).not.toHaveBeenCalled();
  });

  it("without a sink still builds an anchor (legacy DOM path)", () => {
    const createEl = vi.spyOn(document, "createElement");
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    // jsdom/happy-dom anchors have a no-op click; just prove the DOM path runs.
    triggerDownload(new Uint8Array([1]), "a.stl", "model/stl");
    expect(createEl).toHaveBeenCalledWith("a");
  });
});

describe("downloadParts with a sink", () => {
  it("single part routes the raw bytes to the sink under <name>.<ext>", () => {
    const sink = vi.fn();
    const data = new Uint8Array([9]);
    downloadParts({ parts: [{ name: "iso", data }], ext: "stl", mime: "model/stl" }, "part.zip", sink);
    expect(sink).toHaveBeenCalledWith({ data, filename: "iso.stl", mime: "model/stl" });
  });

  it("multiple parts zip first, then route the zip to the sink", () => {
    const sink = vi.fn();
    downloadParts(
      { parts: [{ name: "a", data: new Uint8Array([1]) }, { name: "b", data: new Uint8Array([2]) }], ext: "stl", mime: "model/stl" },
      "widget.zip",
      sink,
    );
    expect(sink).toHaveBeenCalledTimes(1);
    const call = sink.mock.calls[0][0];
    expect(call.filename).toBe("widget.zip");
    expect(call.mime).toBe("application/zip");
    expect(call.data).toBeInstanceOf(Uint8Array);
    expect(call.data.length).toBeGreaterThan(0); // real zip bytes
  });
});
