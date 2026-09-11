import { describe, expect, test } from "bun:test";
import DLMM from "@meteora-ag/dlmm";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import Decimal from "decimal.js";

describe("rebalance bot deps", () => {
	test("solana primitives work offline", () => {
		const keypair = Keypair.generate();
		expect(keypair.publicKey instanceof PublicKey).toBe(true);

		const roundtrip = Keypair.fromSecretKey(
			bs58.decode(bs58.encode(keypair.secretKey)),
		);
		expect(roundtrip.publicKey.equals(keypair.publicKey)).toBe(true);

		const conn = new Connection("https://api.mainnet-beta.solana.com");
		expect(conn.rpcEndpoint).toContain("solana.com");
	});

	test("token + math helpers work", async () => {
		const owner = Keypair.generate().publicKey;
		const mint = Keypair.generate().publicKey;
		const ata = await getAssociatedTokenAddress(mint, owner);
		expect(ata instanceof PublicKey).toBe(true);

		expect(new BN("1000000").mul(new BN(2)).toString()).toBe("2000000");
		expect(new Decimal("1.5").plus("2.25").toString()).toBe("3.75");
	});

	test("dlmm sdk exposes pool loader", () => {
		expect(typeof DLMM.create).toBe("function");
		expect(typeof DLMM.createMultiple).toBe("function");
	});
});
