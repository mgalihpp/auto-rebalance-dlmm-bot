import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { Effect, Schedule, Schema } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
} from "effect/unstable/http";

export class SwapError extends Error {
	readonly _tag = "SwapError";
}

export interface SwapQuote {
	readonly inputMint: string;
	readonly outputMint: string;
	readonly inAmount: string;
	readonly outAmount: string;
}

export interface JupiterQuoted {
	readonly quote: SwapQuote;
	readonly rawResponse: unknown;
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

const QuoteResponseSchema = Schema.Struct({
	inputMint: MintAddress,
	outputMint: MintAddress,
	inAmount: BaseUnitAmount,
	outAmount: BaseUnitAmount,
});

const SwapResponseSchema = Schema.Struct({
	swapTransaction: Schema.NonEmptyString,
});

const decodeQuote = Schema.decodeUnknownSync(QuoteResponseSchema);
const decodeSwapEnvelope = Schema.decodeUnknownSync(SwapResponseSchema);

export const parseQuoteResponse = (json: unknown): SwapQuote => {
	try {
		const decoded = decodeQuote(json);
		return {
			inputMint: decoded.inputMint.trim(),
			outputMint: decoded.outputMint.trim(),
			inAmount: decoded.inAmount,
			outAmount: decoded.outAmount,
		};
	} catch (e) {
		throw new SwapError(
			`Jupiter quote: missing inputMint/outputMint/inAmount/outAmount base-unit strings (${e instanceof Error ? e.message : String(e)})`,
		);
	}
};

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export const parseSwapResponse = (json: unknown): string => {
	let swapTransaction: string;
	try {
		swapTransaction = decodeSwapEnvelope(json).swapTransaction;
	} catch (e) {
		throw new SwapError(
			`Jupiter swap: missing swapTransaction base64 string (${e instanceof Error ? e.message : String(e)})`,
		);
	}
	const compact = swapTransaction.trim();
	if (compact === "" || compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
		throw new SwapError("Jupiter swap: swapTransaction is not valid base64");
	}
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(Buffer.from(compact, "base64"));
	} catch {
		throw new SwapError("Jupiter swap: swapTransaction is not valid base64");
	}
	if (bytes.length === 0) {
		throw new SwapError("Jupiter swap: swapTransaction is not valid base64");
	}
	return compact;
};

export interface GetJupiterQuoteArgs {
	readonly baseUrl: string;
	readonly inputMint: string;
	readonly outputMint: string;
	readonly amount: string;
	readonly slippageBps: number;
}

const swapErrorOf = (where: string, e: unknown): SwapError =>
	e instanceof SwapError
		? e
		: new SwapError(`${where}: ${e instanceof Error ? e.message : String(e)}`);

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

export const getJupiterQuote = (
	args: GetJupiterQuoteArgs,
): Effect.Effect<JupiterQuoted, SwapError> =>
	Effect.gen(function* () {
		if (!/^\d+$/.test(args.amount) || args.amount === "0") {
			return yield* Effect.fail(
				new SwapError(
					`Jupiter quote: amount must be a positive base-unit string, got "${args.amount}"`,
				),
			);
		}
		const client = yield* jupiterClient;
		const response = yield* client
			.get(`${args.baseUrl.replace(/\/+$/, "")}/quote`, {
				urlParams: {
					inputMint: args.inputMint,
					outputMint: args.outputMint,
					amount: args.amount,
					slippageBps: String(args.slippageBps),
				},
			})
			.pipe(
				Effect.timeout("10 seconds"),
				Effect.mapError((e) => swapErrorOf("Jupiter quote failed", e)),
			);
		const json: unknown = yield* response.json.pipe(
			Effect.mapError((e) => swapErrorOf("Jupiter quote: bad JSON body", e)),
		);
		const quote = yield* Effect.try({
			try: () => parseQuoteResponse(json),
			catch: (e) => swapErrorOf("Jupiter quote failed", e),
		});
		return { quote, rawResponse: json };
	}).pipe(Effect.provide(FetchHttpClient.layer));

export interface BuildJupiterSwapArgs {
	readonly baseUrl: string;
	readonly userPublicKey: PublicKey;
	readonly quoteResponse: unknown;
}

export const buildJupiterSwapTransactions = (
	args: BuildJupiterSwapArgs,
): Effect.Effect<VersionedTransaction[], SwapError> =>
	Effect.gen(function* () {
		const client = yield* jupiterClient;
		const request = HttpClientRequest.post(
			`${args.baseUrl.replace(/\/+$/, "")}/swap`,
		).pipe(
			HttpClientRequest.bodyJsonUnsafe({
				quoteResponse: args.quoteResponse,
				userPublicKey: args.userPublicKey.toBase58(),
				wrapAndUnwrapSol: true,
			}),
		);
		const response = yield* client.execute(request).pipe(
			Effect.timeout("10 seconds"),
			Effect.mapError((e) => swapErrorOf("Jupiter swap build failed", e)),
		);
		const json: unknown = yield* response.json.pipe(
			Effect.mapError((e) => swapErrorOf("Jupiter swap: bad JSON body", e)),
		);
		const swapTransaction = yield* Effect.try({
			try: () => parseSwapResponse(json),
			catch: (e) => swapErrorOf("Jupiter swap build failed", e),
		});
		return yield* Effect.try({
			try: () => [
				VersionedTransaction.deserialize(
					Uint8Array.from(Buffer.from(swapTransaction, "base64")),
				),
			],
			catch: (e) =>
				swapErrorOf("Jupiter swap: cannot deserialize VersionedTransaction", e),
		});
	}).pipe(Effect.provide(FetchHttpClient.layer));
