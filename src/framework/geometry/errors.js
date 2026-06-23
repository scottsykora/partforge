// Thrown by a backend that can't perform a requested op (e.g. Manifold has no
// fillet/chamfer). The framework catches `.code === "NEEDS_OCCT"` and reroutes
// the part to the OCCT backend.
export class KernelCapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "KernelCapabilityError";
    this.code = "NEEDS_OCCT";
  }
}
