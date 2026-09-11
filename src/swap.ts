import { type Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { Effect, Schedule, Schema } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
} from "effect/unstable/http";

export class SwapError extends Error {
	readonly _tag = "SwapError";
}

export interface JupiterOrder {
	readonly inAmount: string;
	readonly outAmount: string;
	readonly router: string;
	readonly mode: string;
}

export interface JupiterOrdered {
	readonly order: JupiterOrder;
	readonly transactionB64: string;
	readonly requestId: string;
	readonly rawResponse: unknown;
}

export interface JupiterExecuted {
	readonly signature: string;
	readonly totalIn: string;
	readonly totalOut: string;
}

const BaseUnitAmount = Schema.String.check(
	Schema.isPattern(/^\d+$/, {
		message: "expected a base-unit integer string",
	}),
);

const MintAddress = Schema.String.check(
	Schema.makeFilter(
		(s: string): boolean => {
			if (s.trim() === "") return false;
			try {
				new PublicKey(s.trim());
				return true;
			} catch {
				return false;
			}
		},
		{ message: "expected a valid Solana mint address" },
	),
);

const decodeMint = Schema.decodeUnknownSync(MintAddress);
const decodeBaseUnit = Schema.decodeUnknownSync(BaseUnitAmount);

// why: Swap V2 /order builds the unsigned tx server-side when taker is set.
// transaction is null without taker (quote only) and "" when no route can
// be built. inAmount is optional in the wire format, callers fall back to
// the request amount so the pure parser stays offline-testable.
const OrderResponseSchema = Schema.Struct({
	transaction: Schema.Union([Schema.String, Schema.Null]),
	requestId: Schema.NonEmptyString,
	outAmount: BaseUnitAmount,
	router: Schema.NonEmptyString,
	mode: Schema.NonEmptyString,
	inAmount: Schema.optional(BaseUnitAmount),
});

const OrderErrorFieldsSchema = Schema.Struct({
	router: Schema.optional(Schema.String),
	mode: Schema.optional(Schema.String),
	errorCode: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
	errorMessage: Schema.optional(Schema.String),
});

const decodeOrder = Schema.decodeUnknownSync(OrderResponseSchema);
const decodeOrderErrorFields = Schema.decodeUnknownSync(OrderErrorFieldsSchema);

const ExecuteResponseSchema = Schema.Struct({
	status: Schema.Literals(["Success", "Failed"]),
	signature: Schema.optional(Schema.String),
	code: Schema.optional(Schema.Number),
	totalInputAmount: Schema.optional(Schema.String),
	totalOutputAmount: Schema.optional(Schema.String),
});

const decodeExecute = Schema.decodeUnknownSync(ExecuteResponseSchema);

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const assertBase64 = (raw: string, where: string): string => {
	const compact = raw.trim();
	if (compact === "" || compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
		throw new SwapError(`${where}: transaction is not valid base64`);
	}
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(Buffer.from(compact, "base64"));
	} catch {
		throw new SwapError(`${where}: transaction is not valid base64`);
	}
	if (bytes.length === 0) {
		throw new SwapError(`${where}: transaction is not valid base64`);
	}
	return compact;
};

const orderFailureDetail = (json: unknown): string => {
	try {
		const f = decodeOrderErrorFields(json);
		const parts: string[] = [];
		if (f.router !== undefined && f.router.trim() !== "")
			parts.push(`router=${f.router.trim()}`);
		if (f.mode !== undefined && f.mode.trim() !== "")
			parts.push(`mode=${f.mode.trim()}`);
		if (f.errorCode !== undefined)
			parts.push(`errorCode=${String(f.errorCode)}`);
		if (f.errorMessage !== undefined && f.errorMessage.trim() !== "")
			parts.push(`errorMessage=${f.errorMessage.trim()}`);
		return parts.length > 0 ? ` (${parts.join(" ")})` : "";
	} catch {
		return "";
	}
};

export const parseJupiterOrderResponse = (
	json: unknown,
	fallbackInAmount: string,
): {
	readonly order: JupiterOrder;
	readonly transactionB64: string;
	readonly requestId: string;
} => {
	let inAmountFallback: string;
	try {
		inAmountFallback = decodeBaseUnit(fallbackInAmount);
	} catch (e) {
		throw new SwapError(
			`Jupiter order: fallback inAmount is not a base-unit string (${e instanceof Error ? e.message : String(e)})`,
		);
	}
	let decoded: {
		readonly transaction: string | null;
		readonly requestId: string;
		readonly outAmount: string;
		readonly router: string;
		readonly mode: string;
		readonly inAmount?: string;
	};
	try {
		decoded = decodeOrder(json);
	} catch (e) {
		throw new SwapError(
			`Jupiter order: missing transaction/requestId/outAmount/router/mode base-unit strings (${e instanceof Error ? e.message : String(e)})`,
		);
	}
	if (decoded.transaction === null || decoded.transaction.trim() === "") {
		throw new SwapError(
			`Jupiter order: cannot build transaction, fail typed${orderFailureDetail(json)}`,
		);
	}
	const transactionB64 = assertBase64(decoded.transaction, "Jupiter order");
	return {
		order: {
			inAmount: decoded.inAmount ?? inAmountFallback,
			outAmount: decoded.outAmount,
			router: decoded.router,
			mode: decoded.mode,
		},
		transactionB64,
		requestId: decoded.requestId,
	};
};

export const parseJupiterExecuteResponse = (json: unknown): JupiterExecuted => {
	let decoded: {
		readonly status: "Success" | "Failed";
		readonly signature?: string;
		readonly code?: number;
		readonly totalInputAmount?: string;
		readonly totalOutputAmount?: string;
	};
	try {
		decoded = decodeExecute(json);
	} catch (e) {
		throw new SwapError(
			`Jupiter execute: missing status/signature fields (${e instanceof Error ? e.message : String(e)})`,
		);
	}
	const code = decoded.code ?? (decoded.status === "Success" ? 0 : -1);
	if (decoded.status !== "Success" || code !== 0) {
		throw new SwapError(
			`Jupiter execute failed: status=${decoded.status} code=${code}`,
		);
	}
	const signature = (decoded.signature ?? "").trim();
	if (signature === "") {
		throw new SwapError("Jupiter execute failed: missing signature");
	}
	const pickTotal = (raw: string | undefined): string =>
		raw !== undefined && /^\d+$/.test(raw.trim()) ? raw.trim() : "0";
	return {
		signature,
		totalIn: pickTotal(decoded.totalInputAmount),
		totalOut: pickTotal(decoded.totalOutputAmount),
	};
};

export interface GetJupiterOrderArgs {
	readonly inputMint: string;
	readonly outputMint: string;
	readonly amount: string;
	readonly slippageBps: number;
	readonly taker: string;
}

export interface ExecuteJupiterOrderArgs {
	readonly signedTransactionB64: string;
	readonly requestId: string;
}

const swapErrorOf = (where: string, e: unknown): SwapError =>
	e instanceof SwapError
		? e
		: new SwapError(`${where}: ${e instanceof Error ? e.message : String(e)}`);

const JUPITER_V2_BASE_URL = "https://api.jup.ag/swap/v2";

const jupiterAuthHeaders = (): Record<string, string> => {
	const key = process.env.JUPITER_API_KEY?.trim();
	return key ? { "x-api-key": key } : {};
};

const jupiterClient = Effect.gen(function* () {
	const base = yield* HttpClient.HttpClient;
	return base.pipe(
		HttpClient.filterStatusOk,
		HttpClient.retryTransient({
			times: 2,
			schedule: Schedule.exponential("100 millis"),
		}),
	);
});

const assertMintArg = (raw: string, name: string): string => {
	try {
		return decodeMint(raw).trim();
	} catch {
		throw new SwapError(
			`Jupiter order: ${name} is not a valid Solana mint address: "${raw}"`,
		);
	}
};

export interface SignJupiterOrderArgs {
	readonly transactionB64: string;
	readonly owner: Keypair;
}

// why: the bundle path self-broadcasts inside a Jito bundle, so it signs the
// /order transaction locally and skips /execute. Routes needing the
// market-maker co-sign fail bundle simulation, which falls back to sequential.
export const signJupiterOrder = (
	args: SignJupiterOrderArgs,
): Effect.Effect<string, SwapError> =>
	Effect.try({
		try: () => {
			const tx = VersionedTransaction.deserialize(
				Uint8Array.from(
					Buffer.from(
						assertBase64(args.transactionB64, "Jupiter order"),
						"base64",
					),
				),
			);
			tx.sign([args.owner]);
			return Buffer.from(tx.serialize()).toString("base64");
		},
		catch: (e) => swapErrorOf("Jupiter sign failed", e),
	});

export const getJupiterOrder = (
	args: GetJupiterOrderArgs,
): Effect.Effect<JupiterOrdered, SwapError> =>
	Effect.gen(function* () {
		if (!/^\d+$/.test(args.amount) || args.amount === "0") {
			return yield* Effect.fail(
				new SwapError(
					`Jupiter order: amount must be a positive base-unit string, got "${args.amount}"`,
				),
			);
		}
		let inputMint: string;
		let outputMint: string;
		let taker: string;
		try {
			inputMint = assertMintArg(args.inputMint, "inputMint");
			outputMint = assertMintArg(args.outputMint, "outputMint");
			taker = assertMintArg(args.taker, "taker");
		} catch (e) {
			return yield* Effect.fail(swapErrorOf("Jupiter order failed", e));
		}
		const client = yield* jupiterClient;
		const response = yield* client
			.get(`${JUPITER_V2_BASE_URL}/order`, {
				urlParams: {
					inputMint,
					outputMint,
					amount: args.amount,
					taker,
					slippageBps: String(args.slippageBps),
				},
				headers: jupiterAuthHeaders(),
			})
			.pipe(
				Effect.timeout("10 seconds"),
				Effect.mapError((e) => swapErrorOf("Jupiter order failed", e)),
			);
		const json: unknown = yield* response.json.pipe(
			Effect.mapError((e) => swapErrorOf("Jupiter order: bad JSON body", e)),
		);
		const parsed = yield* Effect.try({
			try: () => parseJupiterOrderResponse(json, args.amount),
			catch: (e) => swapErrorOf("Jupiter order failed", e),
		});
		return { ...parsed, rawResponse: json };
	}).pipe(Effect.provide(FetchHttpClient.layer));

export const executeJupiterOrder = (
	args: ExecuteJupiterOrderArgs,
): Effect.Effect<JupiterExecuted, SwapError> =>
	Effect.gen(function* () {
		let signedTransaction: string;
		try {
			signedTransaction = assertBase64(
				args.signedTransactionB64,
				"Jupiter execute",
			);
		} catch (e) {
			return yield* Effect.fail(swapErrorOf("Jupiter execute failed", e));
		}
		if (args.requestId.trim() === "") {
			return yield* Effect.fail(
				new SwapError("Jupiter execute: requestId must not be empty"),
			);
		}
		const client = yield* jupiterClient;
		const request = HttpClientRequest.post(
			`${JUPITER_V2_BASE_URL}/execute`,
		).pipe(
			HttpClientRequest.setHeaders(jupiterAuthHeaders()),
			HttpClientRequest.bodyJsonUnsafe({
				signedTransaction,
				requestId: args.requestId,
			}),
		);
		const response = yield* client.execute(request).pipe(
			Effect.timeout("10 seconds"),
			Effect.mapError((e) => swapErrorOf("Jupiter execute failed", e)),
		);
		const json: unknown = yield* response.json.pipe(
			Effect.mapError((e) => swapErrorOf("Jupiter execute: bad JSON body", e)),
		);
		return yield* Effect.try({
			try: () => parseJupiterExecuteResponse(json),
			catch: (e) => swapErrorOf("Jupiter execute failed", e),
		});
	}).pipe(Effect.provide(FetchHttpClient.layer));
