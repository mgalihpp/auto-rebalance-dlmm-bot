import {
	ComputeBudgetProgram,
	PublicKey,
	type SignatureStatus,
	SystemProgram,
	Transaction,
	type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { Data, Effect } from "effect";
import { AppSigner, SolanaConnection } from "../services.ts";
import { formatSig, jitoBundleUrl, nowStamp } from "../utils.ts";

export class SendError extends Data.TaggedError("SendError")<{
	message: string;
}> {}

export const SIMULATION_CU_LIMIT = 1_400_000;
export const MAX_CU_LIMIT = 1_400_000;
export const CU_BUFFER_MULTIPLIER = 1.1;
// Swap legs consume variable CU depending on route and pool state at landing
// slot, so the 10% default is too tight (seen: sim 40167, limit 44184,
// on-chain ComputationalBudgetExceeded). 50% headroom costs fractions of a
// cent in priority-fee cap and only applies to the swap leg. Even 1.5x still
// failed (seen: sim 40166, limit 60249, on-chain ComputationalBudgetExceeded),
// because a single Jupiter instruction can land a multi-hop route that costs
// far more than the simulation slot. Production Jupiter integrations bump
// complex routes to 400k, and the zap-sdk itself hardcodes 600k for zap-in
// (462_610 observed * 1.2 rounded up) — so the swap leg gets a floor on top
// of the multiplier. Still sim-based, not a static limit: large sims keep
// their buffered value, small sims clamp up to the floor.
export const SWAP_CU_BUFFER_MULTIPLIER = 1.5;
export const SWAP_CU_MIN_LIMIT = 400_000;
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
	cuMinLimit?: number;
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

// Pure resolver so the swap floor stays offline-testable: buffer first, then
// clamp up to minLimit, then cap at MAX_CU_LIMIT.
export function resolveCuLimit(
	unitsConsumed: number,
	multiplier: number = CU_BUFFER_MULTIPLIER,
	minLimit?: number,
): number {
	const buffered = computeUnitLimitWithBuffer(unitsConsumed, multiplier);
	if (minLimit === undefined) {
		return buffered;
	}
	if (!Number.isInteger(minLimit) || minLimit < 1 || minLimit > MAX_CU_LIMIT) {
		throw new SendError({ message: `invalid cuMinLimit: ${String(minLimit)}` });
	}
	return Math.min(Math.max(buffered, minLimit), MAX_CU_LIMIT);
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
					const cuLimit = resolveCuLimit(
						unitsConsumed,
						input.cuBufferMultiplier ?? CU_BUFFER_MULTIPLIER,
						input.cuMinLimit,
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

// Jito bundle send (https://docs.jito.wtf/lowlatencytxnsend/): up to 5 legs
// land in order, in one slot, all-or-nothing, so a zap can never stop
// half-way with liquidity removed but not re-deposited. Only the tip buys
// priority in the block-engine auction, so legs carry a sim-based CU limit
// and no priority fee.
export const MAX_BUNDLE_TXS = 5;
export const JITO_MIN_TIP_LAMPORTS = 1000;
export const DEFAULT_JITO_BLOCK_ENGINE_URL =
	"https://mainnet.block-engine.jito.wtf";
// Constant per Jito docs (getTipAccounts). Pick one at random to reduce
// contention; never reference them through an address lookup table.
export const JITO_TIP_ACCOUNTS = [
	"96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
	"HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
	"Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
	"ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
	"DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
	"ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
	"DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
	"3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
] as const;

export interface BundleLeg {
	tx: Transaction;
	label: string;
	cuBufferMultiplier?: number;
	cuMinLimit?: number;
}

export interface SendBundleInput {
	legs: BundleLeg[];
	tipLamports: number;
	blockEngineUrl: string;
	pollMs?: number;
	resendMs?: number;
}

export function pickTipAccount(random: () => number = Math.random): PublicKey {
	const index = Math.min(
		Math.max(Math.floor(random() * JITO_TIP_ACCOUNTS.length), 0),
		JITO_TIP_ACCOUNTS.length - 1,
	);
	return new PublicKey(JITO_TIP_ACCOUNTS[index] ?? JITO_TIP_ACCOUNTS[0]);
}

export type BundleSimulation =
	| { ok: true; unitsConsumed: number[] }
	| { ok: false; reason: string };

// Reads a Jito-flavored simulateBundle payload (Helius exposes it on the
// regular RPC URL). A plain Solana RPC answers with a method-not-found error.
export function parseSimulateBundleResult(
	payload: unknown,
	legCount: number,
): BundleSimulation {
	if (typeof payload !== "object" || payload === null) {
		return { ok: false, reason: "empty simulateBundle response" };
	}
	if ("error" in payload && payload.error) {
		return {
			ok: false,
			reason: `simulateBundle rejected (RPC_URL must support it, e.g. Helius): ${JSON.stringify(payload.error)}`,
		};
	}
	const value = (payload as { result?: { value?: unknown } }).result?.value;
	if (typeof value !== "object" || value === null) {
		return { ok: false, reason: "simulateBundle returned no result" };
	}
	const summary = (value as { summary?: unknown }).summary;
	if (summary !== "succeeded") {
		return {
			ok: false,
			reason: `bundle simulation failed: ${JSON.stringify(summary)}`,
		};
	}
	const results = (value as { transactionResults?: unknown })
		.transactionResults;
	if (!Array.isArray(results) || results.length !== legCount) {
		return {
			ok: false,
			reason: `simulateBundle returned ${Array.isArray(results) ? results.length : "no"} results for ${legCount} legs`,
		};
	}
	const unitsConsumed: number[] = [];
	for (const result of results) {
		const units =
			typeof result === "object" && result !== null && "unitsConsumed" in result
				? result.unitsConsumed
				: undefined;
		if (typeof units !== "number" || !Number.isFinite(units) || units <= 0) {
			return {
				ok: false,
				reason: "simulateBundle result is missing unitsConsumed",
			};
		}
		unitsConsumed.push(units);
	}
	return { ok: true, unitsConsumed };
}

export type BundleLanding =
	| { kind: "landed" }
	| { kind: "failed"; index: number; err: string }
	| { kind: "pending"; landed: number };

// A bundle lands atomically, but an uncled block can rebroadcast single legs
// outside it (Jito docs, "Uncled Blocks"). Any leg error, or some legs landed
// at blockhash expiry, means the zap state is partial and must not be resent.
export function classifyBundleLanding(
	statuses: ReadonlyArray<SignatureStatus | null | undefined>,
): BundleLanding {
	let landed = 0;
	for (const [index, status] of statuses.entries()) {
		if (status?.err) {
			return { kind: "failed", index, err: JSON.stringify(status.err) };
		}
		if (
			status?.confirmationStatus === "confirmed" ||
			status?.confirmationStatus === "finalized"
		) {
			landed++;
		}
	}
	if (statuses.length > 0 && landed === statuses.length) {
		return { kind: "landed" };
	}
	return { kind: "pending", landed };
}

// Jito's own view of a submitted bundle (getInflightBundleStatuses, 5-minute
// look back). "Invalid" also covers "not reached the block engine yet", so
// the poll loop only trusts it after JITO_INVALID_GRACE_MS.
export const INFLIGHT_BUNDLE_STATUSES = [
	"Pending",
	"Landed",
	"Failed",
	"Invalid",
] as const;
export type InflightBundleStatus = (typeof INFLIGHT_BUNDLE_STATUSES)[number];
export const JITO_INVALID_GRACE_MS = 10_000;

export function parseInflightBundleStatus(
	payload: unknown,
	bundleId: string,
): InflightBundleStatus | null {
	const value = (payload as { result?: { value?: unknown } } | null)?.result
		?.value;
	if (!Array.isArray(value)) {
		return null;
	}
	const entry = value.find(
		(item) =>
			typeof item === "object" &&
			item !== null &&
			(item as { bundle_id?: unknown }).bundle_id === bundleId,
	) as { status?: unknown } | undefined;
	return (
		INFLIGHT_BUNDLE_STATUSES.find((status) => status === entry?.status) ?? null
	);
}

async function postJson(url: string, body: unknown): Promise<unknown> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	try {
		return await response.json();
	} catch {
		return { error: `HTTP ${response.status}` };
	}
}

export const sendJitoBundle = Effect.fn("sendJitoBundle")(function* (
	input: SendBundleInput,
): Effect.fn.Return<
	{ signatures: string[]; bundleId?: string },
	SendError,
	SolanaConnection | AppSigner
> {
	const connection = yield* SolanaConnection;
	const signer = yield* AppSigner;
	return yield* Effect.tryPromise({
		try: async () => {
			const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
			const resendMs = input.resendMs ?? DEFAULT_RESEND_MS;
			const { legs, tipLamports } = input;
			if (legs.length === 0 || legs.length > MAX_BUNDLE_TXS) {
				throw new SendError({
					message: `[bundle] expected 1..${MAX_BUNDLE_TXS} legs, got ${legs.length}`,
				});
			}
			if (
				!Number.isInteger(tipLamports) ||
				tipLamports < JITO_MIN_TIP_LAMPORTS
			) {
				throw new SendError({
					message: `[bundle] invalid tip: ${String(tipLamports)} lamports`,
				});
			}
			const payer = signer.publicKey;
			const bases = legs.map((leg) => {
				const base = stripComputeBudgetInstructions(leg.tx.instructions);
				if (base.length === 0) {
					throw new SendError({
						message: `[bundle] ${leg.label} has no instructions`,
					});
				}
				return base;
			});
			// Tip rides inside the last leg, never as its own transaction: if
			// the bundle is unbundled and that leg fails, no tip is paid.
			bases[bases.length - 1]?.push(
				SystemProgram.transfer({
					fromPubkey: payer,
					toPubkey: pickTipAccount(),
					lamports: tipLamports,
				}),
			);
			const labels = legs.map((leg) => leg.label);
			const build = (blockhash: string, limits: readonly number[]) =>
				bases.map((base, index) => {
					const tx = new Transaction().add(
						...buildComputeBudgetInstructions(
							limits[index] ?? SIMULATION_CU_LIMIT,
							0,
						),
						...base,
					);
					tx.feePayer = payer;
					tx.recentBlockhash = blockhash;
					tx.sign(signer);
					return tx;
				});
			const signaturesOf = (txs: Transaction[]) =>
				txs.map((tx, index) => {
					if (!tx.signature) {
						throw new SendError({
							message: `[bundle] ${labels[index]} is unsigned`,
						});
					}
					return bs58.encode(tx.signature);
				});

			const describeLanding = (
				landing: BundleLanding,
				total: number,
			): SendError | null => {
				if (landing.kind === "failed") {
					return new SendError({
						message: `[bundle] ${labels[landing.index]} failed on-chain: ${landing.err} — check wallet and position manually`,
					});
				}
				if (landing.kind === "pending" && landing.landed > 0) {
					return new SendError({
						message: `[bundle] landed partially (${landing.landed}/${total} legs) — check wallet and position manually`,
					});
				}
				return null;
			};

			let lastSignatures: string[] | undefined;
			let lastBundleId: string | undefined;
			const sendOnce = async (
				attempt: number,
			): Promise<{
				signatures: string[];
				bundleId?: string;
			}> => {
				const { blockhash, lastValidBlockHeight } =
					await connection.getLatestBlockhash("confirmed");
				const simTxs = build(
					blockhash,
					bases.map(() => SIMULATION_CU_LIMIT),
				);
				const simSignatures = signaturesOf(simTxs);
				let simPayload: unknown;
				try {
					simPayload = await postJson(connection.rpcEndpoint, {
						jsonrpc: "2.0",
						id: "1",
						method: "simulateBundle",
						params: [
							{
								encodedTransactions: simTxs.map((tx) =>
									tx.serialize().toString("base64"),
								),
							},
							{
								preExecutionAccountsConfigs: simTxs.map(() => null),
								postExecutionAccountsConfigs: simTxs.map(() => null),
								skipSigVerify: true,
								replaceRecentBlockhash: true,
							},
						],
					});
				} catch (error) {
					throw new RetryableSendError(
						`[bundle] simulateBundle request failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				const simulation = parseSimulateBundleResult(simPayload, bases.length);
				if (!simulation.ok) {
					if (isRetryableSimulationError(simulation.reason)) {
						throw new RetryableSendError(`[bundle] ${simulation.reason}`);
					}
					const failedIndex = simSignatures.findIndex((sig) =>
						simulation.reason.includes(sig),
					);
					const leg = failedIndex >= 0 ? ` (${labels[failedIndex]})` : "";
					throw new SendError({
						message: `[bundle]${leg} ${simulation.reason}`,
					});
				}
				const limits = simulation.unitsConsumed.map((used, index) =>
					resolveCuLimit(
						used,
						legs[index]?.cuBufferMultiplier ?? CU_BUFFER_MULTIPLIER,
						legs[index]?.cuMinLimit,
					),
				);
				console.log(
					`[${nowStamp()}] [bundle] attempt ${attempt}/${MAX_SEND_ATTEMPTS} simulate: ${labels
						.map(
							(label, index) =>
								`${label} used=${simulation.unitsConsumed[index]} limit=${limits[index]}`,
						)
						.join(", ")} | tip=${tipLamports} lamports`,
				);

				const finalTxs = build(blockhash, limits);
				const signatures = signaturesOf(finalTxs);
				const encoded = finalTxs.map((tx) => tx.serialize().toString("base64"));
				lastSignatures = signatures;
				lastBundleId = undefined;
				const blockEngine = input.blockEngineUrl.replace(/\/+$/, "");
				const submit = async (): Promise<string> => {
					const payload = await postJson(`${blockEngine}/api/v1/bundles`, {
						jsonrpc: "2.0",
						id: 1,
						method: "sendBundle",
						params: [encoded, { encoding: "base64" }],
					});
					const result =
						typeof payload === "object" && payload !== null
							? (payload as { result?: unknown }).result
							: undefined;
					if (typeof result !== "string") {
						throw new Error(`sendBundle rejected: ${JSON.stringify(payload)}`);
					}
					return result;
				};
				let bundleId: string;
				try {
					bundleId = await submit();
				} catch (error) {
					throw new RetryableSendError(
						`[bundle] ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				lastBundleId = bundleId;
				console.log(
					`[${nowStamp()}] [bundle] submitted ${labels.join(" -> ")}: ${jitoBundleUrl(bundleId)}`,
				);

				const submittedAt = Date.now();
				let lastSend = submittedAt;
				let lastInflight: InflightBundleStatus | null = null;
				for (;;) {
					let landing: BundleLanding;
					try {
						const statuses = await connection.getSignatureStatuses(signatures);
						landing = classifyBundleLanding(statuses.value);
					} catch (error) {
						throw new RetryableSendError(
							`[bundle] status check failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					if (landing.kind === "landed") {
						for (const [index, signature] of signatures.entries()) {
							console.log(
								`[${nowStamp()}] [${labels[index]}] confirmed: ${formatSig(signature)}`,
							);
						}
						return { signatures, bundleId };
					}
					if (landing.kind === "failed") {
						throw describeLanding(landing, signatures.length);
					}
					let currentHeight: number;
					try {
						currentHeight = await connection.getBlockHeight();
					} catch (error) {
						throw new RetryableSendError(
							`[bundle] block height check failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					if (currentHeight > lastValidBlockHeight) {
						const partial = describeLanding(landing, signatures.length);
						if (partial) {
							throw partial;
						}
						throw new RetryableSendError("[bundle] blockhash expired");
					}
					if (Date.now() - lastSend >= resendMs) {
						let inflight: InflightBundleStatus | null = null;
						try {
							inflight = parseInflightBundleStatus(
								await postJson(
									`${blockEngine}/api/v1/getInflightBundleStatuses`,
									{
										jsonrpc: "2.0",
										id: 1,
										method: "getInflightBundleStatuses",
										params: [[bundleId]],
									},
								),
								bundleId,
							);
						} catch {
							// Status is diagnostic only; keep polling signatures.
						}
						if (inflight !== null && inflight !== lastInflight) {
							console.log(`[${nowStamp()}] [bundle] Jito status: ${inflight}`);
							lastInflight = inflight;
						}
						const dropped =
							inflight === "Failed" ||
							(inflight === "Invalid" &&
								Date.now() - submittedAt >= JITO_INVALID_GRACE_MS);
						if (dropped) {
							const partial = describeLanding(landing, signatures.length);
							if (partial) {
								throw partial;
							}
							throw new RetryableSendError(
								`[bundle] Jito dropped the bundle (${inflight}) — usually outbid in the tip auction`,
							);
						}
						if (inflight !== "Landed") {
							try {
								await submit();
							} catch {
								// Rebroadcast is best-effort; keep polling until expiry.
							}
						}
						lastSend = Date.now();
					}
					await sleep(pollMs);
				}
			};

			for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
				try {
					if (lastSignatures !== undefined) {
						// Previous attempt errored mid-flight; the bundle may still
						// have landed, so check before rebuilding with a new blockhash.
						let landing: BundleLanding | undefined;
						try {
							const prior =
								await connection.getSignatureStatuses(lastSignatures);
							landing = classifyBundleLanding(prior.value);
						} catch {
							// Status check itself failed; rebuild below.
						}
						if (landing?.kind === "landed") {
							return { signatures: lastSignatures, bundleId: lastBundleId };
						}
						const partial =
							landing && describeLanding(landing, lastSignatures.length);
						if (partial) {
							throw partial;
						}
					}
					return await sendOnce(attempt);
				} catch (error) {
					if (
						!(error instanceof RetryableSendError) ||
						attempt >= MAX_SEND_ATTEMPTS
					) {
						throw error;
					}
					console.warn(
						`[${nowStamp()}] [bundle] attempt ${attempt}/${MAX_SEND_ATTEMPTS} retryable, retrying with a fresh blockhash: ${error.message}`,
					);
					await sleep(SIM_RETRY_DELAY_MS);
				}
			}
			throw new SendError({
				message: `[bundle] failed after ${MAX_SEND_ATTEMPTS} attempts`,
			});
		},
		catch: toSendError,
	});
});
