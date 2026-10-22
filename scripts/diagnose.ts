// READ-ONLY ownership probe for a failed zap-in leg. Anchor answers an owner
// mismatch with a bare `Custom(3007)` (AccountOwnedByWrongProgram), so this
// prints the program that owns every account `zap_in_dlmm_for_initialized_position`
// receives: pool, mints, token programs, wallet ATAs, position, bin arrays,
// zap ledger. Sends no transactions and touches no secret beyond the owner
// pubkey.
//
// Usage: bun run scripts/diagnose.ts
import DLMM, { getBinArraysRequiredByPositionRange } from "@meteora-ag/dlmm";
import {
	DLMM_PROGRAM_ID,
	deriveLedgerAccount,
	getLbPairState,
	getOrCreateATAInstruction,
	getTokenAccountBalance,
	getTokenProgramFromMint,
	ZAP_PROGRAM_ID,
} from "@meteora-ag/zap-sdk";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { config as loadDotenv } from "dotenv";
import { Data, Effect } from "effect";
import { originalHalfRange } from "../src/rebalance/plan.ts";
import {
	AppConfig,
	AppSigner,
	makeAppLive,
	SolanaConnection,
} from "../src/services.ts";
import { nowStamp } from "../src/utils.ts";

class DiagnoseError extends Data.TaggedError("DiagnoseError")<{
	message: string;
}> {}

loadDotenv();

// One line per owning program, so a Left/Right pair from an Anchor log maps
// straight onto the output.
function describeOwner(owner: PublicKey): string {
	const id = owner.toBase58();
	if (id === TOKEN_PROGRAM_ID.toBase58()) return `${id} (SPL Token)`;
	if (id === TOKEN_2022_PROGRAM_ID.toBase58()) return `${id} (Token-2022)`;
	if (id === DLMM_PROGRAM_ID.toBase58()) return `${id} (DLMM)`;
	if (id === ZAP_PROGRAM_ID.toBase58()) return `${id} (Zap)`;
	return id;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const main = Effect.gen(function* () {
	const botConfig = yield* AppConfig;
	const connection = yield* SolanaConnection;
	const signer = yield* AppSigner;
	const owner = signer.publicKey;
	const problems: string[] = [];
	const notes: string[] = [];
	const query = <T>(what: string, run: () => Promise<T>) =>
		Effect.tryPromise({
			try: run,
			catch: (error) =>
				new DiagnoseError({ message: `${what}: ${message(error)}` }),
		});

	console.log(`[${nowStamp()}] === DIAGNOSE (read-only, sends nothing) ===`);
	console.log(`wallet            ${owner.toBase58()}`);
	console.log(`pool              ${botConfig.poolAddress}`);
	console.log(`dlmm program      ${DLMM_PROGRAM_ID.toBase58()}`);
	console.log(`zap program       ${ZAP_PROGRAM_ID.toBase58()}`);

	const pool = yield* Effect.try({
		try: () => new PublicKey(botConfig.poolAddress),
		catch: (error) =>
			new DiagnoseError({ message: `pool address: ${message(error)}` }),
	});
	const lbPair = yield* query("pool state", () =>
		getLbPairState(connection, pool),
	);
	const poolInfo = yield* query("pool account", () =>
		connection.getAccountInfo(pool),
	);
	if (poolInfo === null) {
		problems.push(`pool account ${botConfig.poolAddress} does not exist`);
	} else if (!poolInfo.owner.equals(DLMM_PROGRAM_ID)) {
		problems.push(
			`pool is owned by ${describeOwner(poolInfo.owner)}, not the DLMM program`,
		);
	}
	console.log(
		`  active bin      ${lbPair.activeId} (bin step ${lbPair.binStep})`,
	);

	const printSide = (side: "X" | "Y", mint: PublicKey) =>
		Effect.gen(function* () {
			const program = yield* query(`token program ${side}`, () =>
				getTokenProgramFromMint(connection, mint),
			);
			const mintInfo = yield* query(`mint ${side}`, () =>
				connection.getAccountInfo(mint),
			);
			const { ataPubkey } = yield* query(`ata ${side}`, () =>
				getOrCreateATAInstruction(
					connection,
					mint,
					owner,
					owner,
					false,
					program,
				),
			);
			const ataInfo = yield* query(`ata ${side}`, () =>
				connection.getAccountInfo(ataPubkey),
			);
			console.log(`token ${side}`);
			console.log(`  mint            ${mint.toBase58()}`);
			console.log(
				`  mint owner      ${mintInfo === null ? "missing" : describeOwner(mintInfo.owner)}`,
			);
			console.log(`  token program   ${describeOwner(program)}`);
			if (mintInfo !== null && !mintInfo.owner.equals(program)) {
				problems.push(
					`mint ${side} is owned by ${describeOwner(mintInfo.owner)} but the zap flow passes ${describeOwner(program)}`,
				);
			}
			if (ataInfo === null) {
				notes.push(
					`ATA ${side} ${ataPubkey.toBase58()} does not exist yet (the setup leg creates it)`,
				);
				console.log(`  wallet ata      ${ataPubkey.toBase58()} (missing)`);
				return;
			}
			const raw = yield* query(`ata ${side} balance`, () =>
				getTokenAccountBalance(connection, ataPubkey),
			);
			console.log(
				`  wallet ata      ${ataPubkey.toBase58()} (${raw}, owner ${describeOwner(ataInfo.owner)})`,
			);
			if (!ataInfo.owner.equals(program)) {
				problems.push(
					`wallet ATA ${side} is owned by ${describeOwner(ataInfo.owner)} but the zap flow expects ${describeOwner(program)}`,
				);
			}
		});

	yield* printSide("X", lbPair.tokenXMint);
	yield* printSide("Y", lbPair.tokenYMint);

	const dlmm = yield* query("pool", () => DLMM.create(connection, pool));
	const { userPositions } = yield* query("positions", () =>
		dlmm.getPositionsByUserAndLbPair(owner),
	);
	console.log(
		`positions         ${userPositions.length} for this wallet in pool`,
	);
	if (userPositions.length === 0) {
		problems.push(
			"this wallet holds no position in the pool: the bot resolves a funded position and would stop before zapping",
		);
	}
	for (const position of userPositions) {
		const address = position.publicKey;
		const info = yield* query("position account", () =>
			connection.getAccountInfo(address),
		);
		const data = position.positionData;
		const bins = `${data.lowerBinId}..${data.upperBinId}`;
		console.log(
			`  ${address.toBase58()} bins ${bins} ` +
				`X=${data.totalXAmount.toString()} Y=${data.totalYAmount.toString()} ` +
				`fees X=${data.feeX.toString()} Y=${data.feeY.toString()}`,
		);
		console.log(
			`    owner         ${info === null ? "missing" : describeOwner(info.owner)}`,
		);
		if (info === null) {
			problems.push(`position ${address.toBase58()} does not exist`);
		} else if (!info.owner.equals(DLMM_PROGRAM_ID)) {
			problems.push(
				`position ${address.toBase58()} is owned by ${describeOwner(info.owner)}, not the DLMM program`,
			);
		}
	}

	// The zap-in leg receives one bin array account per array its target range
	// touches. An uninitialized one still answers to the System program at
	// simulate time, and Anchor reports that as AccountOwnedByWrongProgram
	// (3007), not as a missing account.
	const halfWidth = userPositions[0]
		? originalHalfRange(
				userPositions[0].positionData.lowerBinId,
				userPositions[0].positionData.upperBinId,
			)
		: 10;
	const targetMin = lbPair.activeId - halfWidth;
	const targetMax = lbPair.activeId + halfWidth;
	console.log(
		`bin arrays        needed for target bins ${targetMin}..${targetMax} (half width ${halfWidth})`,
	);
	const required = getBinArraysRequiredByPositionRange(
		pool,
		new BN(targetMin),
		new BN(targetMax),
		DLMM_PROGRAM_ID,
	);
	for (const { key, index } of required) {
		const info = yield* query(`bin array ${index.toString()}`, () =>
			connection.getAccountInfo(key),
		);
		console.log(
			`  index ${index.toString().padStart(4)}      ${key.toBase58()} ` +
				`${info === null ? "MISSING (System program)" : describeOwner(info.owner)}`,
		);
		if (info === null) {
			problems.push(
				`bin array ${index.toString()} (${key.toBase58()}) is not initialized; ` +
					"the zap-in leg passes it as a writable account, so Anchor fails with 3007 and Left: System program",
			);
		}
	}

	const ledger = deriveLedgerAccount(owner);
	const ledgerInfo = yield* query("zap ledger", () =>
		connection.getAccountInfo(ledger),
	);
	console.log(`zap ledger        ${ledger.toBase58()}`);
	console.log(
		`  owner           ${ledgerInfo === null ? "missing (created by the next run)" : describeOwner(ledgerInfo.owner)}`,
	);
	if (ledgerInfo !== null && !ledgerInfo.owner.equals(ZAP_PROGRAM_ID)) {
		problems.push(
			`zap ledger is owned by ${describeOwner(ledgerInfo.owner)}, not the Zap program`,
		);
	}
	if (ledgerInfo !== null) {
		notes.push(
			"zap ledger exists and will be reused; a leftover balance from the failed run stays on it until the tidy-up leg closes it",
		);
	}

	console.log("=== VERDICT ===");
	if (problems.length === 0) {
		console.log("no owner mismatch found in the accounts the zap-in leg reads");
		console.log(
			"if the next zap-in still fails with 3007, the simulation error now names the account plus Left/Right programs",
		);
	}
	for (const problem of problems) {
		console.log(`PROBLEM: ${problem}`);
	}
	for (const note of notes) {
		console.log(`note: ${note}`);
	}
	return problems.length;
});

Effect.runPromise(Effect.provide(main, makeAppLive(process.env))).then(
	(problems) => process.exit(problems > 0 ? 1 : 0),
	(error) => {
		console.error(`[${nowStamp()}] Diagnose failed:`, error);
		process.exit(1);
	},
);
