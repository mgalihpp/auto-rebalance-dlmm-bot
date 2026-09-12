import {
	ComputeBudgetProgram,
	type Connection,
	type Keypair,
	Transaction,
	type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { Data, Effect } from "effect";

export class SendError extends Data.TaggedError("SendError")<{
	message: string;
}> {}

export const SIMULATION_CU_LIMIT = 1_400_000;
export const MAX_CU_LIMIT = 1_400_000;
export const CU_BUFFER_MULTIPLIER = 1.1;
export const COMPUTE_BUDGET_PROGRAM_ID =
	"ComputeBudget111111111111111111111111111111";
export const DEFAULT_POLL_MS = 2000;
export const DEFAULT_RESEND_MS = 5000;

export interface SendManualInput {
	connection: Connection;
	tx: Transaction;
	signers: Keypair[];
	pollMs?: number;
	resendMs?: number;
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

export function computeUnitLimitWithBuffer(unitsConsumed: number): number {
	if (!Number.isFinite(unitsConsumed) || unitsConsumed <= 0) {
		throw new SendError({
			message: `invalid unitsConsumed: ${String(unitsConsumed)}`,
		});
	}
	const buffered = Math.ceil(unitsConsumed * CU_BUFFER_MULTIPLIER);
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

export function withComputeBudget(
	tx: Transaction,
	cuLimit: number,
	microLamports: number,
): Transaction {
	const base = stripComputeBudgetInstructions(tx.instructions);
	const budget = buildComputeBudgetInstructions(cuLimit, microLamports);
	const rebuilt = new Transaction().add(...budget, ...base);
	if (tx.feePayer) {
		rebuilt.feePayer = tx.feePayer;
	}
	return rebuilt;
}

async function fetchPriorityFeeEstimate(
	rpcEndpoint: string,
	serializedTxBase58: string,
): Promise<number> {
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
						options: { recommended: true },
					},
				],
			}),
		});
		const payload: unknown = await response.json();
		return parsePriorityFeeEstimate(payload);
	} catch {
		console.warn(
			"getPriorityFeeEstimate failed (non-Helius RPC?) — continuing with 0 priority fee.",
		);
		return 0;
	}
}

export function sendManualTransaction(
	input: SendManualInput,
): Effect.Effect<string, SendError> {
	return Effect.tryPromise({
		try: async () => {
			const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
			const resendMs = input.resendMs ?? DEFAULT_RESEND_MS;
			const firstSigner = input.signers[0];
			if (!firstSigner) {
				throw new SendError({ message: "no signers provided" });
			}
			const payer = firstSigner.publicKey;
			const base = stripComputeBudgetInstructions(input.tx.instructions);
			if (base.length === 0) {
				throw new SendError({ message: "transaction has no instructions" });
			}

			const simBlockhash = (
				await input.connection.getLatestBlockhash("confirmed")
			).blockhash;
			const simTx = new Transaction().add(
				ComputeBudgetProgram.setComputeUnitLimit({
					units: SIMULATION_CU_LIMIT,
				}),
				...base,
			);
			simTx.feePayer = payer;
			simTx.recentBlockhash = simBlockhash;
			simTx.sign(...input.signers);

			const simulation = await input.connection.simulateTransaction(simTx);
			if (simulation.value.err) {
				throw new SendError({
					message: `simulation failed: ${JSON.stringify(simulation.value.err)}`,
				});
			}
			const unitsConsumed = simulation.value.unitsConsumed;
			if (unitsConsumed === undefined || unitsConsumed === null) {
				throw new SendError({
					message: "simulation failed to return unitsConsumed",
				});
			}
			const cuLimit = computeUnitLimitWithBuffer(unitsConsumed);

			const probeBase58 = bs58.encode(simTx.serialize());
			const microLamports = await fetchPriorityFeeEstimate(
				input.connection.rpcEndpoint,
				probeBase58,
			);
			const budget = buildComputeBudgetInstructions(cuLimit, microLamports);

			const { blockhash, lastValidBlockHeight } =
				await input.connection.getLatestBlockhash("confirmed");
			const finalTx = new Transaction().add(...budget, ...base);
			finalTx.feePayer = payer;
			finalTx.recentBlockhash = blockhash;
			finalTx.sign(...input.signers);
			const raw = finalTx.serialize();
			const signature = await input.connection.sendRawTransaction(raw, {
				skipPreflight: true,
			});

			let lastSend = Date.now();
			for (;;) {
				const statuses = await input.connection.getSignatureStatuses([
					signature,
				]);
				const status = statuses?.value?.[0];
				if (status?.err) {
					throw new SendError({
						message: `transaction failed: ${JSON.stringify(status.err)}`,
					});
				}
				if (
					status?.confirmationStatus === "confirmed" ||
					status?.confirmationStatus === "finalized"
				) {
					return signature;
				}
				const currentHeight = await input.connection.getBlockHeight();
				if (currentHeight > lastValidBlockHeight) {
					throw new SendError({
						message: "blockhash expired, transaction failed",
					});
				}
				if (Date.now() - lastSend >= resendMs) {
					try {
						await input.connection.sendRawTransaction(raw, {
							skipPreflight: true,
						});
					} catch {
						// Rebroadcast is best-effort; keep polling until expiry.
					}
					lastSend = Date.now();
				}
				await sleep(pollMs);
			}
		},
		catch: toSendError,
	});
}
