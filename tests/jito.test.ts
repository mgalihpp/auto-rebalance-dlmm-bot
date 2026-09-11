import { describe, expect, it } from "bun:test";
import {
	assertBundlePlan,
	formatBundlePlan,
	JitoError,
	parseInflightStatusResponse,
	parseSendBundleResponse,
	parseSimulateBundleResponse,
	parseTipAccountsResponse,
	pickTipAccount,
} from "../src/jito.ts";

const TIP_A = "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe";
const TIP_B = "So11111111111111111111111111111111111111112";
const B64 = (s: string): string => Buffer.from(s).toString("base64");

const expectJitoError = (fn: () => unknown, contains: string): void => {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(JitoError);
		expect((e as JitoError).message).toContain(contains);
		return;
	}
	throw new Error("expected JitoError, got success");
};

describe("parseTipAccountsResponse", () => {
	it("decodes a bare array", () => {
		expect(parseTipAccountsResponse([TIP_A, TIP_B])).toEqual([TIP_A, TIP_B]);
	});

	it("decodes a JSON-RPC envelope", () => {
		expect(
			parseTipAccountsResponse({ jsonrpc: "2.0", id: 1, result: [TIP_A] }),
		).toEqual([TIP_A]);
	});

	it("rejects an empty list", () => {
		expectJitoError(() => parseTipAccountsResponse([]), "no Jito tip");
	});

	it("rejects invalid addresses", () => {
		expectJitoError(
			() => parseTipAccountsResponse(["not-an-address"]),
			"not a valid address",
		);
	});

	it("rejects garbage shapes", () => {
		expectJitoError(() => parseTipAccountsResponse({}), "getTipAccounts");
	});
});

describe("pickTipAccount", () => {
	it("picks deterministically with an injected rand", () => {
		expect(pickTipAccount([TIP_A, TIP_B], () => 0)).toBe(TIP_A);
		expect(pickTipAccount([TIP_A, TIP_B], () => 0.999)).toBe(TIP_B);
	});

	it("throws on empty input", () => {
		expectJitoError(() => pickTipAccount([], () => 0), "no Jito tip");
	});
});

describe("parseSendBundleResponse", () => {
	it("decodes a bare bundle id", () => {
		expect(parseSendBundleResponse("c4fb09")).toBe("c4fb09");
	});

	it("decodes a JSON-RPC envelope", () => {
		expect(
			parseSendBundleResponse({ jsonrpc: "2.0", id: 1, result: "c4fb09" }),
		).toBe("c4fb09");
	});

	it("rejects empty ids", () => {
		expectJitoError(() => parseSendBundleResponse("  "), "empty bundle");
		expectJitoError(() => parseSendBundleResponse({ result: "" }), "empty bundle");
	});
});

describe("parseSimulateBundleResponse", () => {
	it("accepts a succeeded summary", () => {
		expect(
			parseSimulateBundleResponse({ value: { summary: "succeeded" } }),
		).toBeUndefined();
		expect(
			parseSimulateBundleResponse({
				result: { value: { summary: "succeeded" } },
			}),
		).toBeUndefined();
	});

	it("accepts payloads without a summary when no error is set", () => {
		expect(parseSimulateBundleResponse({ result: { value: {} } })).toBeUndefined();
	});

	it("fails on RPC error fields", () => {
		expectJitoError(
			() => parseSimulateBundleResponse({ error: { code: -32001 } }),
			"simulateBundle failed",
		);
	});

	it("fails on a failed summary", () => {
		expectJitoError(
			() =>
				parseSimulateBundleResponse({
					value: { summary: { failed: { error: "nope" } } },
				}),
			"simulateBundle failed",
		);
	});
});

describe("parseInflightStatusResponse", () => {
	it("decodes result.value entries", () => {
		expect(
			parseInflightStatusResponse({
				result: {
					value: [{ bundle_id: "abc", status: "Landed", landed_slot: 99 }],
				},
			}),
		).toEqual({ status: "Landed", slot: 99, bundleId: "abc" });
	});

	it("decodes camelCase bundleId and slot", () => {
		expect(
			parseInflightStatusResponse({
				value: [{ bundleId: "abc", status: "Pending", slot: null }],
			}),
		).toEqual({ status: "Pending", slot: null, bundleId: "abc" });
	});

	it("rejects empty value arrays", () => {
		expectJitoError(
			() => parseInflightStatusResponse({ result: { value: [] } }),
			"empty value",
		);
	});
});

describe("assertBundlePlan", () => {
	const plan = {
		legs: [
			{ label: "withdraw", txB64: B64("one") },
			{ label: "deposit+tip", txB64: B64("two") },
		],
		tipAccount: TIP_A,
		tipLamports: 500_000,
	};

	it("passes a well-formed plan", () => {
		expect(assertBundlePlan(plan)).toEqual(plan);
	});

	it("rejects empty and oversized leg lists", () => {
		expectJitoError(
			() => assertBundlePlan({ ...plan, legs: [] }),
			"no legs",
		);
		expectJitoError(
			() =>
				assertBundlePlan({
					...plan,
					legs: [0, 1, 2, 3, 4, 5].map((i) => ({
						label: `leg-${i}`,
						txB64: B64(`tx-${i}`),
					})),
				}),
			"max is 5",
		);
	});

	it("rejects dust tips", () => {
		expectJitoError(
			() => assertBundlePlan({ ...plan, tipLamports: 999 }),
			"tip must be",
		);
	});

	it("rejects broken base64 legs", () => {
		expectJitoError(
			() =>
				assertBundlePlan({
					...plan,
					legs: [{ label: "bad", txB64: "!!!not-base64!!!" }],
				}),
			"not valid base64",
		);
	});
});

describe("formatBundlePlan", () => {
	it("lists legs with the tip account", () => {
		const out = formatBundlePlan({
			legs: [{ label: "withdraw", txB64: B64("one") }],
			tipAccount: TIP_A,
			tipLamports: 500_000,
		});
		expect(out).toContain("withdraw");
		expect(out).toContain(TIP_A);
	});
});
