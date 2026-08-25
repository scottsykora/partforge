// Glue for the loftSmooth propeller reference part (see parts/propeller.js).
import part from "./parts/propeller.js";
import { runWorker } from "./framework/worker.js";
runWorker(part);
