/**
 * Create the tip token with the 3.69% HTS custom fee.
 *
 * ## Why a token with a custom fee instead of a splitter contract
 *
 * An x402 `exact` payment is **ONE transfer to ONE `payTo`**. The 96.31 / 3.69
 * split therefore cannot happen in the protocol. It has to happen **on the asset**.
 *
 * Hedera does this natively: a fractional custom fee on the token routes 3.69% of
 * every transfer to the agent's compute account and leaves 96.31% with the artist,
 * atomically, in the same transaction, with no contract to deploy or audit. Hedera's
 * own bonus list calls this out.
 *
 * ```
 *   fan ──0.10 OSOTIP──► artist account
 *                          └─ HTS fee 369/10000 ──► 0.00369 ──► agent compute account
 * ```
 *
 * ## Usage
 *
 *   node scripts/create-tip-token.ts
 *
 * Needs in `.env` (live mode):
 *
 * | Variable | Role |
 * |---|---|
 * | `HEDERA_TREASURY_ACCOUNT_ID` / `_PRIVATE_KEY` | creates and pays for the token |
 * | `HEDERA_ARTIST_ACCOUNT_ID` | receives the 96.31% |
 * | `HEDERA_COMPUTE_ACCOUNT_ID` | receives the 3.69% — the **fee collector** |
 *
 * Prints the token id; put it in `HEDERA_ASSET` and restart `payments`.
 *
 * > **Never executed.** This script is written against `@hiero-ledger/sdk@2.90.1`
 * > as installed, but no funded Hedera account existed while it was written. It
 * > must not be reported as working until it creates a token on testnet.
 */
import { loadDotEnv } from '../src/config.ts';

loadDotEnv();

/** Read a required env var, or exit with the variable's name — never with a stack trace. */
const need = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`missing env ${k} — see .env.example / docs/RUNBOOK.md`);
    process.exit(1);
  }
  return v;
};

const treasuryId = need('HEDERA_TREASURY_ACCOUNT_ID');
const treasuryKey = need('HEDERA_TREASURY_PRIVATE_KEY');
const artistId = need('HEDERA_ARTIST_ACCOUNT_ID');
const computeId = need('HEDERA_COMPUTE_ACCOUNT_ID');

const agentBps = Number(process.env.SPLIT_AGENT_BPS ?? 369);
const decimals = Number(process.env.HEDERA_ASSET_DECIMALS ?? 6);

// A fee of 0% would silently make the agent free; 100% would take the artist's whole
// tip. Both are configuration mistakes, so refuse them here rather than minting a
// token that behaves absurdly.
if (agentBps <= 0 || agentBps >= 10_000) {
  console.error(`SPLIT_AGENT_BPS must be between 1 and 9999, got ${agentBps}`);
  process.exit(1);
}

// Hedera fractional fees are numerator/denominator with a cap. 3.69% = 369/10000.
// The SDK accepts number | Long here; both values are small and exact.
const feeNumerator = agentBps;
const feeDenominator = 10_000;

// Loaded dynamically so the script gives a clear instruction instead of a raw
// ERR_MODULE_NOT_FOUND when the optional SDK was never installed.
const sdk = await import('@hiero-ledger/sdk').catch(() => {
  console.error('install the SDK first: npm install @hiero-ledger/sdk @x402/hedera @x402/core');
  process.exit(1);
});

const {
  Client,
  PrivateKey,
  TokenCreateTransaction,
  TokenType,
  TokenSupplyType,
  CustomFractionalFee,
  FeeAssessmentMethod,
  Hbar,
} = sdk;

// `Client.forName` takes `testnet`/`mainnet`, not our CAIP-2 `hedera:testnet`.
const networkName = (process.env.HEDERA_NETWORK ?? 'hedera:testnet').replace('hedera:', '');
const client = Client.forName(networkName);
client.setOperator(treasuryId, PrivateKey.fromStringECDSA(treasuryKey));

console.log(`creating OSOTIP on ${process.env.HEDERA_NETWORK ?? 'hedera:testnet'}`);
console.log(`  treasury : ${treasuryId}`);
console.log(`  artist   : ${artistId} (${(10_000 - agentBps) / 100}%)`);
console.log(`  compute  : ${computeId} (${agentBps / 100}% custom fee)`);

const fractional = new CustomFractionalFee()
  // the collector is the agent's own compute wallet — the 3.69% that pays for
  // its inference. Nobody else ever receives it.
  .setFeeCollectorAccountId(computeId)
  .setNumerator(feeNumerator)
  .setDenominator(feeDenominator)
  // Inclusive: the fee is taken OUT of the amount sent, so a 0.10 tip charges the
  // fan exactly 0.10 and splits it — rather than charging 0.10 and asking for more.
  .setAssessmentMethod(FeeAssessmentMethod.Inclusive)
  // A demo tip must never be swallowed by the fee cap. Hedera requires an explicit
  // max; 1_000_000 tinybars is far above any real tip of ours.
  .setMax(Hbar.fromTinybars(1_000_000).toTinybars())
  // Exempt collectors so the fee does not recurse onto itself when the agent
  // moves its own funds.
  .setAllCollectorsAreExempt(true);

const tx = await new TokenCreateTransaction()
  .setTokenName('OSO Artist Tip')
  .setTokenSymbol('OSOTIP')
  .setDecimals(decimals)
  // supply starts at 0: nothing is minted until an artist is actually onboarded
  .setInitialSupply(0)
  .setTreasuryAccountId(treasuryId)
  .setTokenType(TokenType.FungibleCommon)
  .setSupplyType(TokenSupplyType.Infinite)
  .setCustomFees([fractional])
  .freezeWith(client)
  .sign(PrivateKey.fromStringECDSA(treasuryKey));

const resp = await tx.execute(client);
const receipt = await resp.getReceipt(client);
const tokenId = receipt.tokenId?.toString();

if (!tokenId) {
  console.error('token creation did not return an id — check the receipt in HashScan');
  process.exit(1);
}

console.log('\ncreated ✔');
console.log(`  token id : ${tokenId}`);
console.log(`  HashScan : https://hashscan.io/${networkName}/token/${tokenId}`);
console.log(`\nnext: set HEDERA_ASSET=${tokenId} in payments/.env and restart.`);
console.log('      the artist account must be associated with the token before any tip.');
