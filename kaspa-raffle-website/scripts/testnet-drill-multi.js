// Multi-entry testnet drill: funds N distinct entrants into one raffle day,
// then settles it through the production draw engine. Validates the v2
// leader/delegate covenant on-chain and reports the leader's actual compute
// units (so we can confirm the 16-entry cap fits the 500k-gram mass limit).
//
// Usage:
//   node scripts/testnet-drill-multi.js fund <N> [closeMins]
//   node scripts/testnet-drill-multi.js draw <closeTimeMs>
//
// State: scripts/.drill-multi-state.json (throwaway testnet keys).
const fs = require('fs');
const path = require('path');
const kaspa = require('kaspa');
const cli = require('../backend/cli');
const config = require('../backend/config');
const registry = require('../backend/registry');
const draw = require('../backend/draw');

const STATE = path.join(__dirname, '.drill-multi-state.json');
const FUNDER = path.join(__dirname, '.drill-state.json'); // reuse funded wallet

function load(f, d = {}) {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d;
}
function save(f, o) {
    fs.writeFileSync(f, JSON.stringify(o, null, 2));
}

async function connect() {
    const rpc = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), networkId: config.network, encoding: kaspa.Encoding.Borsh });
    await rpc.connect({ timeoutDuration: 20000 });
    return rpc;
}

function funderKey() {
    const s = load(FUNDER);
    if (!s.privateKey) throw new Error('fund the base drill wallet first (scripts/testnet-drill.js wallet)');
    return new kaspa.PrivateKey(s.privateKey);
}

async function cmdFund(n, closeMins = 6) {
    n = Number(n);
    const closeTimeMs = Date.now() + Number(closeMins) * 60_000;
    const keys = { devPubkey: config.devPubkey, opsPubkey: config.opsPubkey };
    const funder = funderKey();
    const funderAddr = funder.toKeypair().toAddress(config.network).toString();

    // Create N entrants + their entry addresses for this day.
    const entrants = [];
    for (let i = 0; i < n; i++) {
        const kp = kaspa.Keypair.random();
        const pubkey = kp.xOnlyPublicKey;
        const info = await cli.entryAddress(closeTimeMs, pubkey, keys);
        entrants.push({ pubkey, address: info.address, priv: kp.privateKey });
    }

    // Pin the day and register all entrants so the draw engine sees them.
    const day = registry.getDayWithPinnedKeys(closeTimeMs, keys);
    for (const e of entrants) registry.addEntrant(closeTimeMs, { pubkey: e.pubkey, address: e.address, payoutAddress: 'drill', registeredAt: Date.now() });

    // Fund each entry with exactly one min-entry (100 tKAS).
    const rpc = await connect();
    const { entries } = await rpc.getUtxosByAddresses({ addresses: [funderAddr] });
    const amount = 10_000_000_000n;
    const outputs = entrants.map((e) => ({ address: e.address, amount }));
    const { transactions } = await kaspa.createTransactions({
        entries,
        outputs,
        changeAddress: funderAddr,
        priorityFee: 100000n,
        networkId: config.network,
    });
    for (const tx of transactions) {
        tx.sign([funder]);
        const txid = await tx.submit(rpc);
        console.log('funding tx:', txid);
    }
    await rpc.disconnect();

    save(STATE, { closeTimeMs, entrants });
    console.log(`\nfunded ${n} entrants for day ${closeTimeMs} (close ${new Date(closeTimeMs).toISOString()})`);
    console.log(`wait for close + ~3 min finalization, then:\n  node scripts/testnet-drill-multi.js draw ${closeTimeMs}`);
}

async function cmdDraw(closeTimeMs) {
    closeTimeMs = Number(closeTimeMs || load(STATE).closeTimeMs);
    if (!closeTimeMs) throw new Error('no drill day; run fund first');
    if (Date.now() < closeTimeMs) {
        console.log(`close not reached (${Math.ceil((closeTimeMs - Date.now()) / 1000)}s to go)`);
        return;
    }
    // Capture the leader's reported compute units from draw-engine logs.
    let leaderUnits = null;
    const log = {
        info: (m) => {
            const u = /script used (\d+)/.exec(String(m));
            if (u) leaderUnits = Number(u[1]);
            console.log('[draw]', m);
        },
        error: (m) => console.error('[draw]', m),
    };
    const day = registry.loadDay(closeTimeMs);
    const settlement = await draw.settleDay(day, log);
    console.log('\n=== MULTI-ENTRY DRAW SETTLED ===');
    console.log(JSON.stringify(settlement, null, 2));
    if (leaderUnits != null) {
        const budgetUnits = Math.ceil(leaderUnits / 10000) + 1;
        const massGrams = budgetUnits * 100;
        console.log(`\nleader script units: ${leaderUnits} -> ~${massGrams} grams mass (cap 500000)`);
    }
}

const [cmd, a, b] = process.argv.slice(2);
(async () => {
    if (cmd === 'fund') await cmdFund(a, b);
    else if (cmd === 'draw') await cmdDraw(a);
    else console.log('usage: testnet-drill-multi.js fund <N> [closeMins] | draw [closeTimeMs]');
    process.exit(0);
})().catch((e) => {
    console.error('drill failed:', e);
    process.exit(1);
});
