import { type Keypair, VersionedTransaction } from "@solana/web3.js";
import type BN from "bn.js";
import { Data, Effect } from "effect";
import { DUST_THRESHOLD, type SwapLeg } from "./plan.ts";

export class SwapError extends Data.TaggedError("SwapError")<{
	message: string;
}> {}

export const JUPITER_BASE_URL = "https://api.jup.ag/swap/v2";

export interface SwapOrderRequest {
	inputMint: string;
	outputMint: string;
	amount: BN;
	taker: string;
	slippageBps: number;
	apiKey?: string;
}

export interface OrderResponse {
	transaction: string | null;
	requestId: string;
	outAmount: string;
	router?: string;
	mode?: string;
	feeBps?: number;
	feeMint?: string;
	errorCode?: number;
	errorMessage?: string;
}

export interface ExecuteResponse {
	status: "Success" | "Failed";
	signature: string;
	code: number;
	totalInputAmount: string;
	totalOutputAmount: string;
	inputAmountResult: string;
	outputAmountResult: string;
	error?: string;
}

export interface ExecuteOrderRequest {
	signedTransaction: string;
	requestId: string;
	apiKey?: string;
}

export interface SwapLegExecution {
	leg: SwapLeg;
	taker: Keypair;
	slippageBps: number;
	apiKey?: string;
}

function toSwapError(error: unknown): SwapError {
	return new SwapError({
		message: error instanceof Error ? error.message : String(error),
	});
}

function apiHeaders(apiKey?: string): Record<string, string> {
	return apiKey ? { "x-api-key": apiKey } : {};
}

export function fetchSwapOrder(
	req: SwapOrderRequest,
): Effect.Effect<OrderResponse, SwapError> {
	return Effect.tryPromise({
		try: async () => {
			const params = new URLSearchParams({
				inputMint: req.inputMint,
				outputMint: req.outputMint,
				amount: req.amount.toString(),
				taker: req.taker,
				slippageBps: String(req.slippageBps),
			});
			const res = await fetch(`${JUPITER_BASE_URL}/order?${params}`, {
				headers: apiHeaders(req.apiKey),
			});
			if (!res.ok) {
				throw new Error(`/order failed: ${res.status} ${await res.text()}`);
			}
			const order = (await res.json()) as OrderResponse;
			if (!order.transaction) {
				throw new Error(
					`no swap route: ${order.errorMessage ?? "empty transaction"}`,
				);
			}
			return order;
		},
		catch: toSwapError,
	});
}

export function executeSwapOrder(
	req: ExecuteOrderRequest,
): Effect.Effect<ExecuteResponse, SwapError> {
	return Effect.tryPromise({
		try: async () => {
			const res = await fetch(`${JUPITER_BASE_URL}/execute`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...apiHeaders(req.apiKey),
				},
				body: JSON.stringify({
					signedTransaction: req.signedTransaction,
					requestId: req.requestId,
				}),
			});
			if (!res.ok) {
				throw new Error(`/execute failed: ${res.status} ${await res.text()}`);
			}
			const result = (await res.json()) as ExecuteResponse;
			if (result.status !== "Success") {
				throw new Error(
					`swap failed: ${result.error ?? "unknown execute error"}`,
				);
			}
			return result;
		},
		catch: toSwapError,
	});
}

export function executeSwapLeg(
	args: SwapLegExecution,
): Effect.Effect<string | null, SwapError> {
	const { leg } = args;
	if (leg.direction === "None" || leg.inAmount.lte(DUST_THRESHOLD)) {
		return Effect.succeed(null);
	}
	return Effect.gen(function* () {
		const order = yield* fetchSwapOrder({
			inputMint: leg.inMint,
			outputMint: leg.outMint,
			amount: leg.inAmount,
			taker: args.taker.publicKey.toBase58(),
			slippageBps: args.slippageBps,
			apiKey: args.apiKey,
		});
		const signedTransaction = yield* Effect.tryPromise({
			try: async () => {
				if (!order.transaction) {
					throw new Error("missing order transaction");
				}
				const tx = VersionedTransaction.deserialize(
					Buffer.from(order.transaction, "base64"),
				);
				tx.sign([args.taker]);
				return Buffer.from(tx.serialize()).toString("base64");
			},
			catch: toSwapError,
		});
		const result = yield* executeSwapOrder({
			signedTransaction,
			requestId: order.requestId,
			apiKey: args.apiKey,
		});
		return result.signature;
	});
}
