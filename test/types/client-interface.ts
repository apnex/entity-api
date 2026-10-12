// client-interface - a compile-time consumer of entity-api's client half (zorg's target, EM10, EM12;
// operation-proxy's caller-interface-parity). Compiled by `npm test` with the package's own strict settings,
// emitting nothing: it passes when it compiles. It imports the package by its public name, so it reads what a
// consumer reads.
//
// A strict TypeScript consumer builds a client over a caller across a hop - one giving the endings EM12 admits:
// attempt null, a proxy code, and the reasons a hop adds, proxy-lost and hop-stalled - and reads every ending
// of a page and of a whole find exhaustively. A page's ending is the caller's, unchanged; a whole find's is the
// caller's but for the first page's invocation and attempt, and its attempt null when no page was sent.
import type { CallEnding, CallRequest, HopNotDeliveredEnding, HopUnknownEnding, OperationCaller, UnknownReason } from "@apnex/operation-call";
import { createStoreClient, type FindEnding, type StoreClient } from "@apnex/entity-api";

/** True only when two types are the same type. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** Compiles only when given true. */
const holds = <T extends true>(): T | undefined => undefined;

/** Reads any ending of the client half, a page's or a whole find's, exhaustively. */
function describe(ending: CallEnding | FindEnding): string {
	const attempt: string = ending.attempt ?? "no attempt of the call layer";
	switch (ending.ending) {
		case "answered": return `${attempt} answered ${JSON.stringify(ending.answer)}`;
		case "refused": return `${attempt} refused ${ending.refusal.code}`;
		case "not-delivered": return `${attempt} not delivered: ${ending.agpCode ?? ending.proxyCode ?? "no code"}`;
		case "unknown": return `${attempt} unknown: ${ending.reason}, ${ending.agpCode ?? "no AGP code"}, ${ending.deliveryReport ?? "no report"}`;
		default: {
			const none: never = ending;
			return none;
		}
	}
}

const invocation = "0000000000000-0000000000000000";
const stalled: HopUnknownEnding = { ending: "unknown", invocation, attempt: null, operation: "find", reason: "hop-stalled", agpCode: null, deliveryReport: null };
const lost: HopUnknownEnding = { ...stalled, reason: "proxy-lost" };
const unsent: HopNotDeliveredEnding = { ending: "not-delivered", invocation, attempt: null, operation: "find", agpCode: null, proxyCode: "deadline-passed", earlierAttemptsUncertain: false };

/** A caller across a hop, giving each ending EM12 adds, accepted by the client half unchanged. */
export async function acrossAHop(_call: CallRequest): Promise<string[]> {
	const endings: readonly CallEnding[] = [stalled, lost, unsent];
	let n = 0;
	const across: OperationCaller = { invoke: async () => endings[n++ % endings.length] ?? unsent };
	const client: StoreClient = createStoreClient({ caller: across, host: "host-a", service: "store", bound: 1000 });
	const page: CallEnding = await client.findPage({ kind: "any" });
	const find: FindEnding = await client.find({ kind: "any" });
	const read: CallEnding = await client.read({ target: { id: "e1.1" } });
	return [describe(page), describe(find), describe(read)];
}

// A page's ending, and every other operation's, is the caller's ending itself, neither narrowed nor widened.
holds<Same<Awaited<ReturnType<StoreClient["findPage"]>>, CallEnding>>();
holds<Same<Awaited<ReturnType<StoreClient["create"]>>, CallEnding>>();
holds<Same<Awaited<ReturnType<StoreClient["read"]>>, CallEnding>>();
holds<Same<Awaited<ReturnType<StoreClient["historyBound"]>>, CallEnding>>();
holds<Same<Awaited<ReturnType<StoreClient["find"]>>, FindEnding>>();
// A whole find carries each of a hop's endings: attempt null, a proxy code, and both reasons a hop adds.
holds<HopUnknownEnding extends FindEnding ? true : false>();
holds<HopNotDeliveredEnding extends FindEnding ? true : false>();
holds<CallEnding extends FindEnding ? true : false>();
holds<Same<Extract<FindEnding, { readonly ending: "unknown" }>["reason"], UnknownReason>>();
holds<Same<Extract<FindEnding, { readonly ending: "not-delivered" }>["proxyCode"], string | null>>();
// A whole find's later page ending a hop's way keeps the first page's attempt, so its attempt may be a string.
export const laterHopPage: FindEnding = { ...unsent, attempt: `${invocation}.00000001` };
export const laterHopStall: FindEnding = { ...stalled, attempt: `${invocation}.00000001` };
// And no ending outside the caller interface's is a find's.
// @ts-expect-error a reason no caller gives is no find's
export const noSuchReason: FindEnding = { ...stalled, reason: "made-up" };
