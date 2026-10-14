// callback-fault-child - a host serving a store whose policy, writer naming or evidence function faults as
// callback-faults.js makes it, run as its own process with no process-wide rejection handler, so a rejection
// escaping to the runtime ends the process (zorg's target, EM13; stage 5's fifth verification, F1 and F2).
//
// It runs the set of forms it is given and writes what it saw, as JSON, to the file it is given, and exits 0;
// a rejection that escaped ends it first, with no file written. The parent reads only that file and the exit
// code: no piped stdio.
import fs from "node:fs";
import { openTopology } from "./topology.js";
import { clientOf, openStore, serve } from "./serving.js";
import { runFaults, switchable } from "./callback-faults.js";

const [resultFile, set] = process.argv.slice(2);
if (!resultFile || !set) throw new Error("callback-fault-child needs the file to write its result to and a set of forms");

const topology = await openTopology({ callers: ["alice"] });
let cases;
try {
	const { store } = openStore();
	const { state, evidence, nameWriter, policy } = switchable();
	await serve(topology, { store, evidence, nameWriter, policy });
	cases = await runFaults({ set, client: clientOf(topology, "alice"), store, state, ran: [] });
} finally {
	await topology.close();
}
fs.writeFileSync(resultFile, JSON.stringify({ cases, handlers: process.listenerCount("unhandledRejection") }));
