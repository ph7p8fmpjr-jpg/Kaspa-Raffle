// Full-cycle covenant drill on testnet: creates (or loads) a throwaway test
// wallet, funds a covenant entry, waits for a short close time, then runs a
// real draw through the public node. This is the definitive probe for
// whether covenants are active on the target network.
//
// Usage:
//   node scripts/testnet-drill.js wallet            # create/show test wallet
//   node scripts/testnet-drill.js enter [closeMins] # send entry to covenant
//   node scripts/testnet-drill.js draw <closeTimeMs># settle the drill day
//
// State is kept in scripts/.drill-state.json (testnet throwaway keys only).
const fs = require('fs');
const path = require('path');
const kaspa = require('kaspa');
const cli = require('../backend/cli');
const config = require('../backend/config');

const STATE_FILE = path.join(__dirname, '.drill-state.json');

function loadState() {
    return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
}
function saveState(s) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function connect() {
    const rpc = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), networkId: config.network, encoding: kaspa.Encoding.Borsh });
    await rpc.connect({ timeoutDuration: 20000 });
    console.log('connected:', rpc.url);
    return rpc;
}

function getWallet() {
    const state = loadState();
    if (!state.privateKey) {
        const keypair = kaspa.Keypair.random();
        state.privateKey = keypair.privateKey;
        saveState(state);
    }
    const keypair = new kaspa.PrivateKey(state.privateKey).toKeypair();
    const address = keypair.toAddress(config.network);
    return { keypair, address: address.toString(), pubkey: keypair.xOnlyPublicKey };
}

async function cmdWallet() {
    const w = getWallet();
    console.log('drill wallet address:', w.address);
    console.log('fund it from the faucet, then run: node scripts/testnet-drill.js enter');
    const rpc = await connect();
    const { entries } = await rpc.getUtxosByAddresses({ addresses: [w.address] });
    const balance = entries.reduce((s, e) => s + BigInt(e.amount), 0n);
    console.log('balance:', Number(balance) / 1e8, 'tKAS across', entries.length, 'utxos');
    await rpc.disconnect();
}

async function cmdEnter(closeMins = 6) {
    const w = getWallet();
    const closeTimeMs = Date.now() + Number(closeMins) * 60_000;
    const info = await cli.entryAddress(closeTimeMs, w.pubkey);
    console.log('drill day close:', new Date(closeTimeMs).toISOString());
    console.log('covenant entry address:', info.address);

    const rpc = await connect();
    const { entries } = await rpc.getUtxosByAddresses({ addresses: [w.address] });
    const balance = entries.reduce((s, e) => s + BigInt(e.amount), 0n);
    const amount = 10_000_000_000n; // 100 tKAS = exactly one min entry
    if (balance < amount + 100_000n) {
        console.log(`insufficient balance (${Number(balance) / 1e8} tKAS) — fund ${w.address} from the faucet first`);
        await rpc.disconnect();
        return;
    }

    const { transactions, summary } = await kaspa.createTransactions({
        entries,
        outputs: [{ address: info.address, amount }],
        changeAddress: w.address,
        priorityFee: 0n,
        networkId: config.network,
    });
    for (const tx of transactions) {
        tx.sign([new kaspa.PrivateKey(loadState().privateKey)]);
        const txid = await tx.submit(rpc);
        console.log('entry tx submitted:', txid);
    }
    console.log('final txid:', summary.finalTransactionId?.toString());

    const state = loadState();
    state.drill = { closeTimeMs, entryAddress: info.address, pubkey: w.pubkey };
    saveState(state);
    console.log(`\nnow wait until close (${closeMins} min), then run:`);
    console.log(`  node scripts/testnet-drill.js draw ${closeTimeMs}`);
    await rpc.disconnect();
}

async function cmdDraw(closeTimeMsArg) {
    const state = loadState();
    const drill = state.drill || {};
    const closeTimeMs = Number(closeTimeMsArg || drill.closeTimeMs);
    if (!closeTimeMs) throw new Error('no drill day found — run enter first');
    if (Date.now() < closeTimeMs) {
        console.log(`close time not reached yet (${Math.ceil((closeTimeMs - Date.now()) / 1000)}s to go)`);
        return;
    }

    // Reuse the production draw engine against a synthetic registry day.
    const registry = require('../backend/registry');
    const day = registry.loadDay(closeTimeMs);
    if (!day.entrants.find((e) => e.pubkey === drill.pubkey)) {
        day.entrants.push({ pubkey: drill.pubkey, address: drill.entryAddress, payoutAddress: 'drill', registeredAt: Date.now() });
        registry.saveDay(day);
    }

    const draw = require('../backend/draw');
    const settlement = await draw.settleDay(registry.loadDay(closeTimeMs));
    console.log('\n=== DRAW SETTLED ===');
    console.log(JSON.stringify(settlement, null, 2));
}

const [cmd, arg] = process.argv.slice(2);
(async () => {
    if (cmd === 'wallet') await cmdWallet();
    else if (cmd === 'enter') await cmdEnter(arg);
    else if (cmd === 'draw') await cmdDraw(arg);
    else console.log('usage: testnet-drill.js wallet | enter [closeMins] | draw [closeTimeMs]');
    process.exit(0);
})().catch((e) => {
    console.error('drill failed:', e);
    process.exit(1);
});
