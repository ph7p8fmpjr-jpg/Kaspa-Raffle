// Central configuration for the raffle draw service. Everything comes from
// env vars so cloud deploys are configured without code changes.
require('dotenv').config();

const path = require('path');

// Collect config problems instead of throwing at require time: a cloud deploy
// with a missing env var should still boot and REPORT the problem on /healthz,
// not crash-loop invisibly.
const configErrors = [];
function req(name) {
    const v = process.env[name];
    if (!v) {
        configErrors.push(`missing required env var ${name}`);
        return '';
    }
    return v;
}
const hex32 = /^[0-9a-fA-F]{64}$/;
function reqPubkey(name) {
    const v = req(name);
    if (v && !hex32.test(v)) configErrors.push(`${name} must be 64 hex chars (32-byte x-only pubkey)`);
    return v;
}

module.exports = {
    port: Number(process.env.PORT || 3000),
    configErrors,

    // Network: 'testnet-10' during the trial phase. Mainnet only after the
    // exit criteria are met (see project docs).
    network: process.env.KASPA_NETWORK || 'testnet-10',
    // wRPC endpoint of a kaspad node. Public resolver is used when empty.
    rpcUrl: process.env.KASPA_RPC_URL || '',
    addressPrefix: process.env.ADDRESS_PREFIX || 'kaspatest',

    // 32-byte x-only pubkeys, hex. Baked into every entry covenant.
    devPubkey: reqPubkey('DEV_PUBKEY'),
    opsPubkey: reqPubkey('OPS_PUBKEY'),

    // Covenant constants — MUST mirror raffle_entry.sil.
    minEntrySompi: 10_000_000_000n, // 100 KAS
    maxEntriesPerDraw: 16,
    reclaimDelayMs: Number(process.env.RECLAIM_DELAY_MS || 86_400_000),

    // Fee for the draw tx, taken from the winner share. Covenant cap: 0.1 KAS.
    drawFeeSompi: BigInt(process.env.DRAW_FEE_SOMPI || 1_000_000),

    // Grace period after midnight close before the draw fires. Must exceed the
    // DAG's past-median-time lag (~1-3 min) so the finalization check passes;
    // the scheduler also retries "not finalized" every 60s as a backstop.
    drawDelayMs: Number(process.env.DRAW_DELAY_MS || 240_000),

    // Path to the raffle-cli binary (built from silverscript workspace).
    raffleCli: process.env.RAFFLE_CLI || path.join(__dirname, '..', 'bin', 'raffle-cli'),

    // Where day registries are persisted.
    dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

    // Shared secret for the external cron trigger (cron-job.org).
    cronSecret: process.env.CRON_SECRET || '',
};
