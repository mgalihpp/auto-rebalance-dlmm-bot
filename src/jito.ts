import { PublicKey } from "@solana/web3.js";
import { Duration, Effect, Schema } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
} from "effect/unstable/http";

export class JitoError extends Error {
	readonly _tag = "JitoError";
}

export const JITO_DEFAULT_BLOCK_ENGINE_URL =
	"https://mainnet.block-engine.jito.wtf";
export const JITO_MAX_TXS = 5;
export const JITO_MIN_TIP_LAMPORTS = 1000;
export const JITO_POLL_TIMEOUT_MS = 30_000;
export const JITO_POLL_INTERVAL_MS = 3_000;

export interface BundleLeg {
	readonly label: string;
	readonly txB64: string;
}

export interface BundlePlan {
	readonly legs: readonly BundleLeg[];
	readonly tipAccount: string;
	readonly tipLamports: number;
}

export type BundleStatus =
	| { readonly _tag: "Built" }
	| { readonly _tag: "SimulatedOk" }
	| { readonly _tag: "Sent"; readonly bundleId: string }
	| { readonly _tag: "Landed"; readonly slot: number | null }
	| { readonly _tag: "Failed"; readonly reason: string }
	| { readonly _tag: "TimedOut" };

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const assertBase64Tx = (raw: string, where: string): string => {
	const compact = raw.trim();
	if (compact === "" || compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
		throw new JitoError(`${where}: transaction is not valid base64`);
	}
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(Buffer.from(compact, "base64"));
	} catch {
		throw new JitoError(`${where}: transaction is not valid base64`);
	}
	if (bytes.length === 0) {
		throw new JitoError(`${where}: transaction is not valid base64`);
	}
	return compact;
};

const assertTipAccount = (raw: string): string => {
	const compact = raw.trim();
	if (compact === "") throw new JitoError("tip account must not be empty");
	try {
		new PublicKey(compact);
	} catch {
		throw new JitoError(`tip account is not a valid address: "${raw}"`);
	}
	return compact;
};

// why: a bundle wider than 5 txs is rejected by the block engine, and a tip
// below 1000 lamports is deprioritized to the point of never landing.
export const assertBundlePlan = (plan: BundlePlan): BundlePlan => {
	if (plan.legs.length === 0) throw new JitoError("bundle has no legs");
	if (plan.legs.length > JITO_MAX_TXS) {
		throw new JitoError(
			`bundle has ${plan.legs.length} legs, max is ${JITO_MAX_TXS}`,
		);
	}
	plan.legs.forEach((leg, i) => {
		if (leg.label.trim() === "") throw new JitoError(`leg ${i} has no label`);
		assertBase64Tx(leg.txB64, `bundle leg ${leg.label}`);
	});
	assertTipAccount(plan.tipAccount);
	if (!Number.isInteger(plan.tipLamports) || plan.tipLamports < JITO_MIN_TIP_LAMPORTS) {
		throw new JitoError(
			`tip must be an integer >= ${JITO_MIN_TIP_LAMPORTS} lamports, got ${plan.tipLamports}`,
		);
	}
	return plan;
};

export const pickTipAccount = (
	accounts: readonly string[],
	rand: () => number = Math.random,
): string => {
	if (accounts.length === 0) throw new JitoError("no Jito tip accounts found");
	const idx = Math.floor(rand() * accounts.length);
	const picked = accounts[idx] ?? accounts[0];
	if (picked === undefined || picked.trim() === "") {
		throw new JitoError("no Jito tip accounts found");
	}
	return assertTipAccount(picked);
};

const TipArraySchema = Schema.Array(Schema.String);
const TipEnvelopeSchema = Schema.Struct({ result: Schema.Array(Schema.String) });
const decodeTipArray = Schema.decodeUnknownSync(TipArraySchema);
const decodeTipEnvelope = Schema.decodeUnknownSync(TipEnvelopeSchema);

export const parseTipAccountsResponse = (json: unknown): string[] => {
	let raw: readonly string[];
	try {
		raw = decodeTipArray(json);
	} catch {
		try {
			raw = decodeTipEnvelope(json).result;
		} catch (e) {
			throw new JitoError(
				`getTipAccounts: expected string[] or {result: string[]} (${e instanceof Error ? e.message : String(e)})`,
			);
		}
	}
	if (raw.length === 0) throw new JitoError("no Jito tip accounts found");
	return raw.map((a) => assertTipAccount(a));
};

const SendEnvelopeSchema = Schema.Struct({ result: Schema.String });
const decodeSendEnvelope = Schema.decodeUnknownSync(SendEnvelopeSchema);

export const parseSendBundleResponse = (json: unknown): string => {
	if (typeof json === "string") {
		if (json.trim() === "") throw new JitoError("sendBundle: empty bundle id");
		return json.trim();
	}
	try {
		const id = decodeSendEnvelope(json).result.trim();
		if (id === "") throw new JitoError("sendBundle: empty bundle id");
		return id;
	} catch (e) {
		if (e instanceof JitoError) throw e;
		throw new JitoError(
			`sendBundle: missing result bundle id (${e instanceof Error ? e.message : String(e)})`,
		);
	}
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;

export const parseSimulateBundleResponse = (json: unknown): void => {
	if (isRecord(json) && json.error !== undefined && json.error !== null) {
		throw new JitoError(
			`simulateBundle failed: ${JSON.stringify(json.error).slice(0, 300)}`,
		);
	}
	const payload: unknown =
		isRecord(json) && "result" in json ? json.result : json;
	const value: unknown =
		isRecord(payload) && "value" in payload ? payload.value : payload;
	if (isRecord(value) && "summary" in value) {
		const summary: unknown = value.summary;
		if (summary === "succeeded") return;
		throw new JitoError(
			`simulateBundle failed: ${JSON.stringify(summary).slice(0, 300)}`,
		);
	}
};

export interface InflightStatus {
	readonly status: string;
	readonly slot: number | null;
	readonly bundleId: string | null;
}

const StatusEntrySchema = Schema.Struct({
	status: Schema.optional(Schema.String),
	bundle_id: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
	bundleId: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
	landed_slot: Schema.optional(Schema.Union([Schema.Number, Schema.Null])),
	slot: Schema.optional(Schema.Union([Schema.Number, Schema.Null])),
});
const decodeEntry = Schema.decodeUnknownSync(StatusEntrySchema);

export const parseInflightStatusResponse = (json: unknown): InflightStatus => {
	let rawEntries: unknown;
	if (isRecord(json)) {
		const result: unknown = json.result;
		if (isRecord(result) && Array.isArray(result.value)) {
			rawEntries = result.value;
		} else if (Array.isArray(result)) {
			rawEntries = result;
		} else if (Array.isArray(json.value)) {
			rawEntries = json.value;
		}
	}
	if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
		throw new JitoError("getInflightBundleStatuses: empty value array");
	}
	let first: {
		readonly status?: string;
		readonly bundle_id?: string | null;
		readonly bundleId?: string | null;
		readonly landed_slot?: number | null;
		readonly slot?: number | null;
	};
	try {
		first = decodeEntry(rawEntries[0]);
	} catch (e) {
		throw new JitoError(
			`getInflightBundleStatuses: bad entry (${e instanceof Error ? e.message : String(e)})`,
		);
	}
	const status = (first.status ?? "").trim() || "Unknown";
	const slotRaw = first.landed_slot ?? first.slot ?? null;
	const slot =
		typeof slotRaw === "number" && Number.isInteger(slotRaw) && slotRaw >= 0
			? slotRaw
			: null;
	const bundleId =
		(first.bundle_id ?? first.bundleId ?? null) !== null
			? String(first.bundle_id ?? first.bundleId).trim() || null
			: null;
	return { status, slot, bundleId };
};

export const formatBundlePlan = (plan: BundlePlan): string => {
	const lines = plan.legs.map(
		(leg, i) =>
			`  [${i}] ${leg.label} (${leg.txB64.trim().length} b64 chars)`,
	);
	return [
		`bundle plan: ${plan.legs.length} tx(s), tip ${(plan.tipLamports / 1e9).toFixed(9)} SOL -> ${plan.tipAccount}`,
		...lines,
		"  tip sits in the last transaction",
	].join("\n");
};

const jitoErrorOf = (where: string, e: unknown): JitoError =>
	e instanceof JitoError
		? e
		: new JitoError(`${where}: ${e instanceof Error ? e.message : String(e)}`);

const jitoClient = Effect.gen(function* () {
	const base = yield* HttpClient.HttpClient;
	return base.pipe(HttpClient.filterStatusOk);
});

const postJsonRpc = (
	url: string,
	method: string,
	params: unknown,
): Effect.Effect<unknown, JitoError> =>
	Effect.gen(function* () {
		const client = yield* jitoClient;
		const request = HttpClientRequest.post(url).pipe(
			HttpClientRequest.setHeaders({
				"content-type": "application/json",
			}),
			HttpClientRequest.bodyJsonUnsafe({
				jsonrpc: "2.0",
				id: 1,
				method,
				params,
			}),
		);
		const response = yield* client.execute(request).pipe(
			Effect.timeout("10 seconds"),
			Effect.mapError((e) => jitoErrorOf(method, e)),
		);
		return yield* response.json.pipe(
			Effect.mapError((e) => jitoErrorOf(`${method}: bad JSON body`, e)),
		);
	}).pipe(Effect.provide(FetchHttpClient.layer));

export const getTipAccounts = (args: {
	readonly blockEngineUrl: string;
}): Effect.Effect<string[], JitoError> =>
	Effect.gen(function* () {
		const json = yield* postJsonRpc(args.blockEngineUrl, "getTipAccounts", []);
		return yield* Effect.try({
			try: () => parseTipAccountsResponse(json),
			catch: (e) => jitoErrorOf("getTipAccounts failed", e),
		});
	});

export const simulateBundle = (args: {
	readonly blockEngineUrl: string;
	readonly transactions: readonly string[];
}): Effect.Effect<void, JitoError> =>
	Effect.gen(function* () {
		if (args.transactions.length === 0 || args.transactions.length > JITO_MAX_TXS) {
			return yield* Effect.fail(
				new JitoError(
					`simulateBundle: need 1-${JITO_MAX_TXS} transactions, got ${args.transactions.length}`,
				),
			);
		}
		const json = yield* postJsonRpc(args.blockEngineUrl, "simulateBundle", [
			{ encodedTransactions: [...args.transactions] },
		]);
		return yield* Effect.try({
			try: () => parseSimulateBundleResponse(json),
			catch: (e) => jitoErrorOf("simulateBundle failed", e),
		});
	});

export const sendBundle = (args: {
	readonly blockEngineUrl: string;
	readonly transactions: readonly string[];
}): Effect.Effect<string, JitoError> =>
	Effect.gen(function* () {
		if (args.transactions.length === 0 || args.transactions.length > JITO_MAX_TXS) {
			return yield* Effect.fail(
				new JitoError(
					`sendBundle: need 1-${JITO_MAX_TXS} transactions, got ${args.transactions.length}`,
				),
			);
		}
		const json = yield* postJsonRpc(args.blockEngineUrl, "sendBundle", [
			[...args.transactions],
		]);
		return yield* Effect.try({
			try: () => parseSendBundleResponse(json),
			catch: (e) => jitoErrorOf("sendBundle failed", e),
		});
	});

export const fetchBundleStatusOnce = (args: {
	readonly blockEngineUrl: string;
	readonly bundleId: string;
}): Effect.Effect<InflightStatus, JitoError> =>
	Effect.gen(function* () {
		if (args.bundleId.trim() === "") {
			return yield* Effect.fail(new JitoError("bundle id must not be empty"));
		}
		const json = yield* postJsonRpc(
			args.blockEngineUrl,
			"getInflightBundleStatuses",
			[[args.bundleId]],
		);
		return yield* Effect.try({
			try: () => parseInflightStatusResponse(json),
			catch: (e) => jitoErrorOf("getInflightBundleStatuses failed", e),
		});
	});

// why: the block engine only keeps 5 minutes of bundle state, so an empty or
// unknown status means "not landed yet", not terminal. Only Landed ends the
// wait with success; Failed/Invalid fold into the Failed union member and a
// quiet deadline folds into TimedOut so the caller can fall back.
export const pollBundleStatus = (args: {
	readonly blockEngineUrl: string;
	readonly bundleId: string;
	readonly timeoutMs?: number;
	readonly intervalMs?: number;
}): Effect.Effect<BundleStatus, JitoError> =>
	Effect.gen(function* () {
		const timeoutMs = args.timeoutMs ?? JITO_POLL_TIMEOUT_MS;
		const intervalMs = args.intervalMs ?? JITO_POLL_INTERVAL_MS;
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const outcome: { readonly ok: true; readonly found: InflightStatus } | {
				readonly ok: false;
			} = yield* fetchBundleStatusOnce({
				blockEngineUrl: args.blockEngineUrl,
				bundleId: args.bundleId,
			}).pipe(
				Effect.map((found) => ({ ok: true as const, found })),
				Effect.catch((e) =>
					Effect.sync(() => {
						console.error(`poll bundle status retry: ${e.message}`);
						return { ok: false as const };
					}),
				),
			);
			if (!outcome.ok) {
				if (Date.now() >= deadline) return { _tag: "TimedOut" } as const;
				yield* Effect.sleep(Duration.millis(intervalMs));
				continue;
			}
			const status = outcome.found;
			if (status.status === "Landed") {
				return { _tag: "Landed", slot: status.slot } as const;
			}
			if (status.status === "Failed" || status.status === "Invalid") {
				return {
					_tag: "Failed",
					reason: `bundle ${status.status}${status.slot !== null ? ` slot=${status.slot}` : ""}`,
				} as const;
			}
			if (Date.now() >= deadline) return { _tag: "TimedOut" } as const;
			yield* Effect.sleep(Duration.millis(intervalMs));
		}
	});
