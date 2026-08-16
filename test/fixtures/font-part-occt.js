// font-part.js forced onto the OCCT backend — covers the OCCT branch of the
// CLI's bootKernel fonts plumbing (the two branches boot different kernels).
import base from "./font-part.js";

export default { ...base, meta: { ...base.meta, backend: "occt" } };
