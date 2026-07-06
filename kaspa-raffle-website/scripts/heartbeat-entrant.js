// Heartbeat entrant: places 2 small testnet entries into today's raffle so the
// automated midnight draw always has something to settle. This is what makes
// the "30 consecutive clean automated draws" streak accumulate on testnet.
//
// Run daily (well before the midnight UTC close), e.g. via cron-job.org or a
// second Render cron. Idempotent per day: it will not double-enter if today's
// heartbeat entries already exist and are funded.
//
// Requires a funded testnet wallet key in HEARTBEAT_WALLET_KEY (hex) — a
// throwaway testnet wallet topped up from the faucet. NEVER a mainnet key.
const kaspa = require('kaspa');
const cli = require('../backend/cli');
const config = require('../backend/config');
const registry = require('../backend/registry');

const ENTRIES = Number(process.env.HEARTBEAT_ENTRIES || 2);
const ENTRY_SOMPI = 10_000_000_000n; // exactly one min entry each

async function main() {
    if (config.network !== 'testnet-10') {
        throw new Error(`heartbeat refuses to run on ${config.network} — testnet only`);
    }
    const keyHex = process.env.HEARTBEAT_WALLET_KEY;
    if (!keyHex) throw new Error('HEARTBEAT_WALLET_KEY not set');

    const funder = new kaspa.PrivateKey(keyHex);
    const funderAddr = funder.toKeypair().toAddress(config.network).toString();
    const closeTimeMs = registry.closeTimeForNow();
    const keys = { devPubkey: config.devPubkey, opsPubkey: config.opsPubkey };
    const day = registry.getDayWithPinnedKeys(closeTimeMs, keys);

    // Skip if this day already has heartbeat entries registered.
    const already = day.entrants.filter((e) => e.payoutAddress === 'heartbeat').length;
    if (already >= ENTRIES) {
        console.log(`heartbeat: day ${closeTimeMs} already has ${already} entries, skipping`);
        return;
    }

    const rpc = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), networkId: config.network, encoding: kaspa.Encoding.Borsh });
    await rpc.connect({ timeoutDuration: 20000 });

    const need = ENTRIES - already;
    const outputs = [];
    for (let i = 0; i < need; i++) {
        const kp = kaspa.Keypair.random();
        const info = await cli.entryAddress(closeTimeMs, kp.xOnlyPublicKey, keys);
        registry.addEntrant(closeTimeMs, { pubkey: kp.xOnlyPublicKey, address: info.address, payoutAddress: 'heartbeat', registeredAt: Date.now() });
        outputs.push({ address: info.address, amount: ENTRY_SOMPI });
    }

    const { entries } = await rpc.getUtxosByAddresses({ addresses: [funderAddr] });
    const balance = entries.reduce((s, e) => s + BigInt(e.amount), 0n);
    if (balance < ENTRY_SOMPI * BigInt(need) + 1_000_000n) {
        throw new Error(`heartbeat wallet low: ${Number(balance) / 1e8} tKAS — top up ${funderAddr} from the faucet`);
    }
    const { transactions } = await kaspa.createTransactions({ entries, outputs, changeAddress: funderAddr, priorityFee: 100000n, networkId: config.network });
    for (const tx of transactions) {
        tx.sign([funder]);
        const txid = await tx.submit(rpc);
        console.log(`heartbeat: entered ${need} for day ${closeTimeMs}, tx ${txid}`);
    }
    await rpc.disconnect();
}

main().then(() => process.exit(0)).catch((e) => { console.error('heartbeat failed:', e.message || e); process.exit(1); });
