import {
	ComputeBudgetProgram,
	type SignatureStatus,
	Transaction,
	type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { Data, Effect } from "effect";
import { AppSigner, SolanaConnection } from "../services.ts";
import { formatSig, nowStamp } from "../utils.ts";

export class SendError extends Data.TaggedError("SendError")<{
	message: string;
}> {}

export const SIMULATION_CU_LIMIT = 1_400_000;
export const MAX_CU_LIMIT = 1_400_000;
export const CU_BUFFER_MULTIPLIER = 1.1;
// Swap legs consume variable CU depending on route and pool state at landing
// slot, so the 10% default is too tight (seen: sim 40167, limit 44184,
// on-chain ComputationalBudgetExceeded). 50% headroom costs fractions of a
// cent in priority-fee cap and only applies to the swap leg.
export const SWAP_CU_BUFFER_MULTIPLIER = 1.5;
export const COMPUTE_BUDGET_PROGRAM_ID =
	"ComputeBudget111111111111111111111111111111";
// Helius getPriorityFeeEstimate levels, Min -> UnsafeMax, plus Auto: let
// Helius pick its own recommended optimal fee (`{ recommended: true }`)
// instead of pinning a percentile. High (75th percentile) lands rebalance
// legs in seconds while still costing fractions of a cent.
export const PRIORITY_LEVELS = [
	"Min",
	"Low",
	"Medium",
	"High",
	"VeryHigh",
	"UnsafeMax",
] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number];
export const AUTO_PRIORITY_LEVEL = "Auto" as const;
export type PrioritySetting = PriorityLevel | typeof AUTO_PRIORITY_LEVEL;
export const PRIORITY_SETTINGS: readonly PrioritySetting[] = [
	...PRIORITY_LEVELS,
	AUTO_PRIORITY_LEVEL,
];
export const DEFAULT_PRIORITY_LEVEL: PrioritySetting = "High";
export const DEFAULT_POLL_MS = 1000;
export const DEFAULT_RESEND_MS = 2500;
export const MAX_SEND_ATTEMPTS = 3;
// Simulation-only blockhash commitment. "finalized" is older than "confirmed"
// but known to every RPC node, so a load-balanced simulate call never sees a
// "too new" BlockhashNotFound (Helius blockhash-errors blog, "Mismatched
// RPCs" case; Solana cookbook "Be wary of lagging RPC nodes"). The throwaway
// simTx is discarded after CU estimation; the real finalTx below still uses a
// fresh "confirmed" blockhash.
// Delay between simulation-blockhash retries so a lagging node can catch up
// instead of failing 3x within the same second.
export const SIM_BLOCKHASH_COMMITMENT = "finalized" as const;
export const SIM_RETRY_DELAY_MS = 1000;

export interface SendManualInput {
	tx: Transaction;
	label?: string;
	pollMs?: number;
	resendMs?: number;
	priorityLevel?: PrioritySetting;
	cuBufferMultiplier?: number;
}

function toSendError(error: unknown): SendError {
	if (error instanceof SendError) {
		return error;
	}
	return new SendError({
		message: error instanceof Error ? error.message : String(error),
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function computeUnitLimitWithBuffer(
	unitsConsumed: number,
	multiplier: number = CU_BUFFER_MULTIPLIER,
): number {
	if (!Number.isFinite(unitsConsumed) || unitsConsumed <= 0) {
		throw new SendError({
			message: `invalid unitsConsumed: ${String(unitsConsumed)}`,
		});
	}
	if (!Number.isFinite(multiplier) || multiplier <= 0) {
		throw new SendError({
			message: `invalid cuBufferMultiplier: ${String(multiplier)}`,
		});
	}
	const buffered = Math.ceil(unitsConsumed * multiplier);
	return Math.min(Math.max(buffered, 1), MAX_CU_LIMIT);
}

export function buildComputeBudgetInstructions(
	cuLimit: number,
	microLamports: number,
): TransactionInstruction[] {
	if (!Number.isInteger(cuLimit) || cuLimit < 1 || cuLimit > MAX_CU_LIMIT) {
		throw new SendError({ message: `invalid cuLimit: ${String(cuLimit)}` });
	}
	const price = Number.isFinite(microLamports)
		? Math.max(0, Math.floor(microLamports))
		: 0;
	const instructions = [
		ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
	];
	if (price > 0) {
		instructions.push(
			ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
		);
	}
	return instructions;
}

export function stripComputeBudgetInstructions(
	instructions: TransactionInstruction[],
): TransactionInstruction[] {
	return instructions.filter(
		(ix) => ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID,
	);
}

export function parsePriorityFeeEstimate(payload: unknown): number {
	if (typeof payload !== "object" || payload === null) {
		return 0;
	}
	const result = (payload as { result?: unknown }).result;
	if (typeof result !== "object" || result === null) {
		return 0;
	}
	const estimate = (result as { priorityFeeEstimate?: unknown })
		.priorityFeeEstimate;
	if (typeof estimate !== "number" || !Number.isFinite(estimate)) {
		return 0;
	}
	return Math.max(0, Math.floor(estimate));
}

// Pulls `{ error: { message } }` out of a fee-estimate payload for the
// no-estimate warning. Anything else means a non-Helius RPC.
function feeErrorReason(payload: unknown): string {
	if (typeof payload === "object" && payload !== null && "error" in payload) {
		const error = payload.error;
		if (typeof error === "object" && error !== null && "message" in error) {
			const message = error.message;
			if (typeof message === "string" && message !== "") {
				return `: ${message}`;
			}
		}
	}
	return " (non-Helius RPC?)";
}

async function fetchPriorityFeeEstimate(
	rpcEndpoint: string,
	serializedTxBase58: string,
	priorityLevel: PrioritySetting,
): Promise<number> {
	// `recommended` cannot be combined with `priorityLevel` (the API rejects
	// it), so Auto sends `{ recommended: true }` on its own.
	const options =
		priorityLevel === AUTO_PRIORITY_LEVEL
			? { recommended: true }
			: { priorityLevel };
	try {
		const response = await fetch(rpcEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: "1",
				method: "getPriorityFeeEstimate",
				params: [
					{
						transaction: serializedTxBase58,
						options,
					},
				],
			}),
		});
		const payload: unknown = await response.json();
		const estimate = parsePriorityFeeEstimate(payload);
		if (estimate === 0) {
			// Helius legitimately returns 0 during quiet periods (especially
			// at Low/Min). Only warn when the payload has no usable estimate.
			const raw =
				typeof payload === "object" && payload !== null
					? (payload as { result?: { priorityFeeEstimate?: unknown } }).result
							?.priorityFeeEstimate
					: undefined;
			if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
				return 0;
			}
			// Helius answers API misuse with a 200 + { error } payload, which
			// parses to 0. Never go quiet-fee: surface the reason in the log.
			console.warn(
				`[${nowStamp()}] getPriorityFeeEstimate returned no estimate${feeErrorReason(payload)} — continuing with 0 priority fee.`,
			);
		}
		return estimate;
	} catch {
		console.warn(
			`[${nowStamp()}] getPriorityFeeEstimate failed (non-Helius RPC?) — continuing with 0 priority fee.`,
		);
		return 0;
	}
}

// Retryable send failure: rebuild with a fresh blockhash and re-sign (Helius:
// only ever re-sign with a new blockhash). Simulation and on-chain failures
// throw SendError and abort without retry.
class RetryableSendError extends Error {}

// Simulation can hit a different RPC node than the blockhash fetch on
// load-balanced endpoints, so a just-fetched hash can already read as
// unknown. Every blockhash-flavored simulation failure wants a fresh hash
// and one more attempt, not an aborted iteration.
export function isRetryableSimulationError(error: unknown): boolean {
	let text: string;
	if (typeof error === "string") {
		text = error;
	} else if (error instanceof Error) {
		text = error.message;
	} else {
		try {
			const raw = JSON.stringify(error);
			if (typeof raw !== "string") {
				return false;
			}
			text = raw;
		} catch {
			return false;
		}
	}
	return /blockhash/i.test(text) && /not\s*found|expired/i.test(text);
}

export const sendManualTransaction = Effect.fn("sendManualTransaction")(
	function* (
		input: SendManualInput,
	): Effect.fn.Return<string, SendError, SolanaConnection | AppSigner> {
		const connection = yield* SolanaConnection;
		const signer = yield* AppSigner;
		return yield* Effect.tryPromise({
			try: async () => {
				const label = input.label ?? "tx";
				const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
				const resendMs = input.resendMs ?? DEFAULT_RESEND_MS;
				const priorityLevel = input.priorityLevel ?? DEFAULT_PRIORITY_LEVEL;
				const payer = signer.publicKey;
				const base = stripComputeBudgetInstructions(input.tx.instructions);
				if (base.length === 0) {
					throw new SendError({ message: "transaction has no instructions" });
				}

				let lastSignature: string | undefined;
				const sendOnce = async (attempt: number): Promise<string> => {
					// Throwaway CU-estimation tx: finalized blockhash is universally
					// known, so any node in a load-balanced pool can simulate it.
					const simBlockhash = (
						await connection.getLatestBlockhash(SIM_BLOCKHASH_COMMITMENT)
					).blockhash;
					const simTx = new Transaction().add(
						ComputeBudgetProgram.setComputeUnitLimit({
							units: SIMULATION_CU_LIMIT,
						}),
						...base,
					);
					simTx.feePayer = payer;
					simTx.recentBlockhash = simBlockhash;
					simTx.sign(signer);

					const simulation = await connection.simulateTransaction(simTx);
					if (simulation.value.err) {
						const raw = JSON.stringify(simulation.value.err);
						if (isRetryableSimulationError(raw)) {
							throw new RetryableSendError(
								`[${label}] simulation hit a stale blockhash, retrying with a fresh one: ${raw}`,
							);
						}
						throw new SendError({
							message: `[${label}] simulation failed: ${raw}`,
						});
					}
					const unitsConsumed = simulation.value.unitsConsumed;
					if (unitsConsumed === undefined || unitsConsumed === null) {
						throw new SendError({
							message: "simulation failed to return unitsConsumed",
						});
					}
					const cuLimit = computeUnitLimitWithBuffer(
						unitsConsumed,
						input.cuBufferMultiplier ?? CU_BUFFER_MULTIPLIER,
					);
					const probeBase58 = bs58.encode(simTx.serialize());
					const microLamports = await fetchPriorityFeeEstimate(
						connection.rpcEndpoint,
						probeBase58,
						priorityLevel,
					);
					console.log(
						`[${nowStamp()}] [${label}] attempt ${attempt}/${MAX_SEND_ATTEMPTS} simulate: used=${unitsConsumed} limit=${cuLimit} fee=${microLamports}uL(${priorityLevel}) ixs=${base.length}`,
					);
					const budget = buildComputeBudgetInstructions(cuLimit, microLamports);

					const { blockhash, lastValidBlockHeight } =
						await connection.getLatestBlockhash("confirmed");
					const finalTx = new Transaction().add(...budget, ...base);
					finalTx.feePayer = payer;
					finalTx.recentBlockhash = blockhash;
					finalTx.sign(signer);
					const raw = finalTx.serialize();
					let signature: string;
					try {
						signature = await connection.sendRawTransaction(raw, {
							skipPreflight: true,
						});
					} catch (error) {
						throw new RetryableSendError(
							`[${label}] send failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					lastSignature = signature;

					let lastSend = Date.now();
					for (;;) {
						let status: SignatureStatus | null | undefined;
						try {
							const statuses = await connection.getSignatureStatuses([
								signature,
							]);
							status = statuses?.value?.[0];
						} catch (error) {
							throw new RetryableSendError(
								`[${label}] status check failed: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						if (status?.err) {
							throw new SendError({
								message: `[${label}] transaction failed: ${JSON.stringify(status.err)} (sim used=${unitsConsumed} limit=${cuLimit})`,
							});
						}
						if (
							status?.confirmationStatus === "confirmed" ||
							status?.confirmationStatus === "finalized"
						) {
							console.log(
								`[${nowStamp()}] [${label}] confirmed: ${formatSig(signature)}`,
							);
							return signature;
						}
						let currentHeight: number;
						try {
							currentHeight = await connection.getBlockHeight();
						} catch (error) {
							throw new RetryableSendError(
								`[${label}] block height check failed: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						if (currentHeight > lastValidBlockHeight) {
							throw new RetryableSendError(`[${label}] blockhash expired`);
						}
						if (Date.now() - lastSend >= resendMs) {
							try {
								await connection.sendRawTransaction(raw, {
									skipPreflight: true,
								});
							} catch {
								// Rebroadcast is best-effort; keep polling until expiry.
							}
							lastSend = Date.now();
						}
						await sleep(pollMs);
					}
				};

				for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
					try {
						if (lastSignature !== undefined) {
							// Previous attempt errored mid-flight; it may still have
							// landed, so check before rebuilding with a new blockhash.
							try {
								const prior = await connection.getSignatureStatuses([
									lastSignature,
								]);
								const priorStatus = prior?.value?.[0];
								if (
									priorStatus?.confirmationStatus === "confirmed" ||
									priorStatus?.confirmationStatus === "finalized"
								) {
									console.log(
										`[${nowStamp()}] [${label}] confirmed: ${formatSig(lastSignature)}`,
									);
									return lastSignature;
								}
								if (priorStatus?.err) {
									throw new SendError({
										message: `[${label}] transaction failed: ${JSON.stringify(priorStatus.err)}`,
									});
								}
							} catch (error) {
								if (error instanceof SendError) {
									throw error;
								}
								// Status check itself failed; rebuild below.
							}
						}
						return await sendOnce(attempt);
					} catch (error) {
						if (error instanceof SendError || attempt >= MAX_SEND_ATTEMPTS) {
							throw error;
						}
						console.warn(
							`[${nowStamp()}] [${label}] attempt ${attempt}/${MAX_SEND_ATTEMPTS} retryable, retrying with a fresh blockhash: ${error instanceof Error ? error.message : String(error)}`,
						);
						// Give a lagging RPC node time to catch up before the next
						// attempt fetches a fresh blockhash.
						await sleep(SIM_RETRY_DELAY_MS);
					}
				}
				throw new SendError({
					message: `[${label}] failed after ${MAX_SEND_ATTEMPTS} attempts`,
				});
			},
			catch: toSendError,
		});
	},
);
