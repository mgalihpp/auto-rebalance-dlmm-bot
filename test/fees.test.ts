import { describe, expect, test } from "bun:test";
import { feeClaimAction } from "../src/rebalance/fees.ts";

describe("feeClaimAction", () => {
	test("both off claims nothing", () => {
		expect(
			feeClaimAction({ compoundFees: false, reaccumulateFeesToSol: false }),
		).toBeNull();
	});

	test("compound only compounds", () => {
		expect(
			feeClaimAction({ compoundFees: true, reaccumulateFeesToSol: false }),
		).toBe("compound");
	});

	test("reaccumulate only sweeps", () => {
		expect(
			feeClaimAction({ compoundFees: false, reaccumulateFeesToSol: true }),
		).toBe("sweep");
	});

	test("both on sweeps, matching the post-zap precedence", () => {
		expect(
			feeClaimAction({ compoundFees: true, reaccumulateFeesToSol: true }),
		).toBe("sweep");
	});
});
