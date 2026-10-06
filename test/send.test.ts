import { describe, expect, test } from "bun:test";
import {
	buildComputeBudgetInstructions,
	COMPUTE_BUDGET_PROGRAM_ID,
	computeUnitLimitWithBuffer,
	isRetryableSimulationError,
	parsePriorityFeeEstimate,
	resolveCuLimit,
	SendError,
	SIM_BLOCKHASH_COMMITMENT,
	SIM_RETRY_DELAY_MS,
	SWAP_CU_MIN_LIMIT,
} from "../src/rebalance/send.ts";

describe("computeUnitLimitWithBuffer", () => {
	test("adds a 10% buffer", () => {
		expect(computeUnitLimitWithBuffer(1000)).toBe(1100);
		expect(computeUnitLimitWithBuffer(100_000)).toBe(Math.ceil(100_000 * 1.1));
	});

	test("clamps to the 1.4M max", () => {
		expect(computeUnitLimitWithBuffer(2_000_000)).toBe(1_400_000);
	});

	test("accepts a custom multiplier (swap leg)", () => {
		expect(computeUnitLimitWithBuffer(40167, 1.5)).toBe(Math.ceil(40167 * 1.5));
		expect(computeUnitLimitWithBuffer(2_000_000, 1.5)).toBe(1_400_000);
	});

	test("rejects non-positive input", () => {
		expect(() => computeUnitLimitWithBuffer(0)).toThrow(SendError);
		expect(() => computeUnitLimitWithBuffer(-5)).toThrow(SendError);
		expect(() => computeUnitLimitWithBuffer(Number.NaN)).toThrow(SendError);
		expect(() => computeUnitLimitWithBuffer(1000, 0)).toThrow(SendError);
		expect(() => computeUnitLimitWithBuffer(1000, -1)).toThrow(SendError);
	});
});

describe("resolveCuLimit", () => {
	test("clamps small swap sims up to the swap floor", () => {
		// Regression: sim 40166 * 1.5 = 60249 still failed on-chain.
		expect(resolveCuLimit(40166, 1.5, SWAP_CU_MIN_LIMIT)).toBe(
			SWAP_CU_MIN_LIMIT,
		);
		expect(SWAP_CU_MIN_LIMIT).toBe(400_000);
	});

	test("keeps the buffered value when it already clears the floor", () => {
		expect(resolveCuLimit(500_000, 1.5, SWAP_CU_MIN_LIMIT)).toBe(
			Math.ceil(500_000 * 1.5),
		);
	});

	test("behaves like computeUnitLimitWithBuffer without a floor", () => {
		expect(resolveCuLimit(1000)).toBe(1100);
	});

	test("rejects an out-of-range floor", () => {
		expect(() => resolveCuLimit(1000, 1.1, 0)).toThrow(SendError);
		expect(() => resolveCuLimit(1000, 1.1, 1_400_001)).toThrow(SendError);
		expect(() => resolveCuLimit(1000, 1.1, 1.5)).toThrow(SendError);
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

describe("isRetryableSimulationError", () => {
	test("retries stale blockhash simulation failures", () => {
		expect(isRetryableSimulationError("BlockhashNotFound")).toBe(true);
		expect(isRetryableSimulationError({ err: "BlockhashNotFound" })).toBe(true);
		expect(isRetryableSimulationError("blockhash not found")).toBe(true);
		expect(isRetryableSimulationError("blockhash expired")).toBe(true);
	});

	test("aborts on real program failures", () => {
		expect(isRetryableSimulationError("InstructionError")).toBe(false);
		expect(isRetryableSimulationError(null)).toBe(false);
		expect(isRetryableSimulationError(undefined)).toBe(false);
	});
});

describe("simulation blockhash tunables", () => {
	test("sim uses finalized so any load-balanced node knows the hash", () => {
		expect(SIM_BLOCKHASH_COMMITMENT).toBe("finalized");
	});

	test("retry delay is positive so a lagging node can catch up", () => {
		expect(Number.isInteger(SIM_RETRY_DELAY_MS)).toBe(true);
		expect(SIM_RETRY_DELAY_MS).toBeGreaterThan(0);
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
