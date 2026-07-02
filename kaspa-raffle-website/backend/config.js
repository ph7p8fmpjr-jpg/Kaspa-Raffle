// Central configuration for the raffle draw service. Everything comes from
// env vars so cloud deploys are configured without code changes.
require('dotenv').config();

const path = require('path');

function req(name) {
    const v = process.env[name];
    if (!v) throw new Error(`missing required env var ${name}`);
    return v;
}

module.exports = {
    port: Number(process.env.PORT || 3000),

    // Network: 'testnet-10' during the trial phase. Mainnet only after the
    // exit criteria are met (see project docs).
    network: process.env.KASPA_NETWORK || 'testnet-10',
    // wRPC endpoint of a kaspad node. Public resolver is used when empty.
    rpcUrl: process.env.KASPA_RPC_URL || '',
    addressPrefix: process.env.ADDRESS_PREFIX || 'kaspatest',

    // 32-byte x-only pubkeys, hex. Baked into every entry covenant.
    devPubkey: req('DEV_PUBKEY'),
    opsPubkey: req('OPS_PUBKEY'),

    // Covenant constants — MUST mirror raffle_entry.sil.
    minEntrySompi: 10_000_000_000n, // 100 KAS
    maxEntriesPerDraw: 16,
    reclaimDelayMs: Number(process.env.RECLAIM_DELAY_MS || 86_400_000),

    // Fee for the draw tx, taken from the winner share. Covenant cap: 0.1 KAS.
    drawFeeSompi: BigInt(process.env.DRAW_FEE_SOMPI || 1_000_000),

    // Grace period after midnight close before the draw fires, letting
    // boundary entries confirm.
    drawDelayMs: Number(process.env.DRAW_DELAY_MS || 120_000),

    // Path to the raffle-cli binary (built from silverscript workspace).
    raffleCli: process.env.RAFFLE_CLI || path.join(__dirname, '..', 'bin', 'raffle-cli'),

    // Where day registries are persisted.
    dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

    // Shared secret for the external cron trigger (cron-job.org).
    cronSecret: process.env.CRON_SECRET || '',
};
