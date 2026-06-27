const { SOMPI_PER_KAS } = require('./kaspa-api');
const { readJson, writeJson } = require('./store');

let kaspaModule = null;

function payoutsEnabled() {
    return Boolean(process.env.WALLET_MNEMONIC || process.env.WALLET_PRIVATE_KEY);
}

async function loadKaspa() {
    if (kaspaModule) return kaspaModule;
    globalThis.WebSocket = require('websocket').w3cwebsocket;
    kaspaModule = require('kaspa');
    return kaspaModule;
}

async function connectRpc(kaspa) {
    const { RpcClient, Encoding } = kaspa;
    const network = process.env.KASPA_NETWORK || 'mainnet';
    const host = process.env.KASPA_RPC_URL || '127.0.0.1';
    const url = RpcClient.parseUrl(host, Encoding.Borsh, network);
    const rpc = new RpcClient(url, Encoding.Borsh, network);
    await rpc.connect();
    const info = await rpc.getServerInfo();
    if (!info.isSynced) {
        throw new Error('Kaspa node is not synced');
    }
    return rpc;
}

function getWalletKey(kaspa) {
    const { PrivateKey, Mnemonic, XPrv, XPrivateKey } = kaspa;

    if (process.env.WALLET_PRIVATE_KEY) {
        return new PrivateKey(process.env.WALLET_PRIVATE_KEY);
    }

    if (process.env.WALLET_MNEMONIC) {
        const mnemonic = new Mnemonic(process.env.WALLET_MNEMONIC.trim());
        const xprv = new XPrv(mnemonic.toSeed());
        const derived = xprv.derivePath("m/44'/111111'/0'/0/0");
        const account = new XPrivateKey(derived.intoString('xprv'), false, 0n);
        return account.receiveKey(0);
    }

    throw new Error('WALLET_MNEMONIC or WALLET_PRIVATE_KEY required for payouts');
}

async function sendPayouts({ winnerAddress, fundingAddress, opsAddress, balanceKas }) {
    if (!payoutsEnabled()) {
        return { skipped: true, reason: 'Wallet not configured (set WALLET_PRIVATE_KEY on server)' };
    }

    const kaspa = await loadKaspa();
    const { Generator, kaspaToSompi } = kaspa;
    const privateKey = getWalletKey(kaspa);
    const network = process.env.KASPA_NETWORK || 'mainnet';
    const sourceAddress = privateKey.toKeypair().toAddress(network);

    const winnerKas = balanceKas * 0.5;
    const fundingKas = balanceKas * 0.4;
    const opsKas = balanceKas * 0.1;
    const changeAddress = opsAddress || sourceAddress;

    const outputs = [
        [kaspaToSompi(winnerKas), winnerAddress],
        [kaspaToSompi(fundingKas), fundingAddress],
    ];

    if (opsAddress) {
        outputs.push([kaspaToSompi(opsKas), opsAddress]);
    }

    const rpc = await connectRpc(kaspa);

    try {
        const utxoResponse = await rpc.getUtxosByAddresses({ addresses: [sourceAddress] });
        const entries = utxoResponse.entries || utxoResponse;
        if (!entries.length) {
            throw new Error('No UTXOs found in raffle wallet');
        }

        const generator = new Generator({
            utxoEntries: entries,
            changeAddress,
            outputs,
            priorityFee: 0n,
        });

        const txids = [];
        while (true) {
            const transaction = await generator.next();
            if (!transaction) break;
            await transaction.sign([privateKey]);
            const txid = await transaction.submit(rpc);
            txids.push(txid);
        }

        const record = {
            sentAt: new Date().toISOString(),
            balanceKas,
            winnerAddress,
            fundingAddress,
            opsAddress: changeAddress,
            winnerKas,
            fundingKas,
            opsKas,
            txids,
            status: 'completed',
        };

        const payoutHistory = readJson('payout-history.json', []);
        payoutHistory.unshift(record);
        writeJson('payout-history.json', payoutHistory.slice(0, 90));

        return record;
    } finally {
        await rpc.disconnect();
    }
}

async function runDrawAndPayout(raffleAddress, drawRecord, fundingAddress) {
    if (!drawRecord.winner) {
        return { skipped: true, reason: 'No winner to pay' };
    }

    return sendPayouts({
        winnerAddress: drawRecord.winner.fullAddr,
        fundingAddress,
        opsAddress: process.env.OPS_ADDRESS || null,
        balanceKas: drawRecord.jackpot,
    });
}

module.exports = { payoutsEnabled, sendPayouts, runDrawAndPayout };