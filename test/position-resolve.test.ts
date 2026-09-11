import { describe, expect, test } from "bun:test";
import BN from "bn.js";
import {
	DlmmError,
	type PositionCandidate,
	resolvePosition,
} from "../src/rebalance/dlmm.ts";

function fake(
	address: string,
	amounts?: Partial<{
		totalXAmount: string | number | BN;
		totalYAmount: string | number | BN;
		feeX: string | number | BN;
		feeY: string | number | BN;
	}>,
): PositionCandidate {
	return {
		publicKey: { toBase58: () => address },
		positionData: {
			totalXAmount: amounts?.totalXAmount ?? "0",
			totalYAmount: amounts?.totalYAmount ?? "0",
			...(amounts?.feeX !== undefined ? { feeX: amounts.feeX } : {}),
			...(amounts?.feeY !== undefined ? { feeY: amounts.feeY } : {}),
		},
	};
}

describe("resolvePosition", () => {
	test("throws no-position error when there are no candidates", () => {
		try {
			resolvePosition([]);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(DlmmError);
			expect((error as DlmmError).message).toBe(
				"no DLMM position found for owner in this pool",
			);
		}
	});

	test("auto-selects the only funded position", () => {
		const funded = fake("Funded", {
			totalXAmount: new BN("1000000"),
			totalYAmount: "2000000",
		});
		expect(resolvePosition([funded])).toBe(funded);
	});

	test("auto-selects one funded position among empties", () => {
		const empties = [
			fake("Empty1"),
			fake("Empty2", { totalXAmount: 0, totalYAmount: new BN(0) }),
		];
		const feesOnly = fake("FeesOnly", { feeX: new BN(25) });
		expect(resolvePosition([...empties, feesOnly])).toBe(feesOnly);
	});

	test("throws listing addresses when multiple positions are funded", () => {
		const candidates = [
			fake("A", { totalXAmount: "100" }),
			fake("B", { totalYAmount: 200 }),
		];
		try {
			resolvePosition(candidates);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(DlmmError);
			const message = (error as DlmmError).message;
			expect(message).toContain("A");
			expect(message).toContain("B");
			expect(message).toContain("one bot instance per pool");
			expect(message).toContain("withdraw the extra position");
		}
	});
});
