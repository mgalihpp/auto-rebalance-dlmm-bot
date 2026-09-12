import { describe, expect, test } from "bun:test";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
	buildComputeBudgetInstructions,
	COMPUTE_BUDGET_PROGRAM_ID,
	computeUnitLimitWithBuffer,
	parsePriorityFeeEstimate,
	SendError,
	stripComputeBudgetInstructions,
	withComputeBudget,
} from "../src/rebalance/send.ts";

function transferTx() {
	const from = Keypair.generate().publicKey;
	const to = Keypair.generate().publicKey;
	const tx = new Transaction().add(
		SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: 1 }),
	);
	return tx;
}

describe("computeUnitLimitWithBuffer", () => {
	test("adds a 10% buffer", () => {
		expect(computeUnitLimitWithBuffer(1000)).toBe(1100);
		expect(computeUnitLimitWithBuffer(100_000)).toBe(Math.ceil(100_000 * 1.1));
	});

	test("clamps to the 1.4M max", () => {
		expect(computeUnitLimitWithBuffer(2_000_000)).toBe(1_400_000);
	});

	test("rejects non-positive input", () => {
		expect(() => computeUnitLimitWithBuffer(0)).toThrow(SendError);
		expect(() => computeUnitLimitWithBuffer(-5)).toThrow(SendError);
		expect(() => computeUnitLimitWithBuffer(Number.NaN)).toThrow(SendError);
	});
});

describe("buildComputeBudgetInstructions", () => {
	test("omits the price instruction when fee is zero", () => {
		const ixs = buildComputeBudgetInstructions(200_000, 0);
		expect(ixs).toHaveLength(1);
		expect(ixs[0]?.programId.toBase58()).toBe(COMPUTE_BUDGET_PROGRAM_ID);
	});

	test("includes limit + price when fee is positive", () => {
		const ixs = buildComputeBudgetInstructions(200_000, 5000);
		expect(ixs).toHaveLength(2);
		for (const ix of ixs) {
			expect(ix.programId.toBase58()).toBe(COMPUTE_BUDGET_PROGRAM_ID);
		}
	});

	test("rejects an out-of-range limit", () => {
		expect(() => buildComputeBudgetInstructions(0, 0)).toThrow(SendError);
	});
});

describe("parsePriorityFeeEstimate", () => {
	test("floors the Helius estimate", () => {
		expect(
			parsePriorityFeeEstimate({ result: { priorityFeeEstimate: 1234.9 } }),
		).toBe(1234);
	});

	test("falls back to zero for unknown shapes (non-Helius RPC)", () => {
		expect(parsePriorityFeeEstimate(null)).toBe(0);
		expect(parsePriorityFeeEstimate({})).toBe(0);
		expect(parsePriorityFeeEstimate({ result: {} })).toBe(0);
		expect(
			parsePriorityFeeEstimate({ result: { priorityFeeEstimate: -10 } }),
		).toBe(0);
	});
});

describe("withComputeBudget", () => {
	test("prepends budget instructions and keeps the original", () => {
		const tx = transferTx();
		const rebuilt = withComputeBudget(tx, 200_000, 5000);
		expect(rebuilt.instructions).toHaveLength(3);
		expect(rebuilt.instructions[0]?.programId.toBase58()).toBe(
			COMPUTE_BUDGET_PROGRAM_ID,
		);
		expect(rebuilt.instructions[1]?.programId.toBase58()).toBe(
			COMPUTE_BUDGET_PROGRAM_ID,
		);
	});

	test("replaces stale budget instructions instead of stacking", () => {
		const tx = transferTx();
		const once = withComputeBudget(tx, 200_000, 0);
		const twice = withComputeBudget(once, 300_000, 0);
		expect(stripComputeBudgetInstructions(twice.instructions)).toHaveLength(1);
		expect(twice.instructions).toHaveLength(2);
	});
});
