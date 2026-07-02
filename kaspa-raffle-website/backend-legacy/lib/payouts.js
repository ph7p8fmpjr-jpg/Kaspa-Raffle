const { readJson, writeJson } = require('./store');

const KASPA_SDK_PATH = require('path').join(
    __dirname,
    '..',
    '..',
    'kaspa-sdk-v2.0.1',
    'kaspa-wasm32-sdk',
    'nodejs',
    'kaspa',
    'kaspa.js'
);

let kaspaModule = null;

function payoutsEnabled() {
    return Boolean(process.env.WALLET_MNEMONIC || process.env.WALLET_PRIVATE_KEY);
}

async function loadKaspa() {
    if (kaspaModule) return kaspaModule;
    globalThis.WebSocket = require('websocket').w3cwebsocket;
    kaspaModule = require(KASPA_SDK_PATH);
    return kaspaModule;
}

function isValidAddress(kaspa, address) {
    if (!address || address.includes('fundingaddresshere')) return false;
    try {
        new kaspa.Address(address);
        return true;
    } catch {
        return false;
    }
}

async function connectRpc(kaspa) {
    const { RpcClient, Encoding } = kaspa;
    const network = process.env.KASPA_NETWORK || 'mainnet';
    const host = process.env.KASPA_RPC_URL || '127.0.0.1';
    const rpc = new RpcClient({
        url: host,
        encoding: Encoding.Borsh,
        networkId: network,
    });
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
        const hex = process.env.WALLET_PRIVATE_KEY.trim();
        if (hex.includes(' ')) {
            throw new Error('WALLET_PRIVATE_KEY looks like a seed phrase - use WALLET_MNEMONIC instead');
        }
        if (hex.length < 64) {
            throw new Error('WALLET_PRIVATE_KEY is too short - export the full hex from your wallet');
        }
        return new PrivateKey(hex);
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

function buildOutputs(kaspa, { winnerAddress, fundingAddress, opsAddress, balanceKas }) {
    const { Address, kaspaToSompi } = kaspa;
    const winnerKas = balanceKas * 0.5;
    const fundingKas = balanceKas * 0.4;
    const opsKas = balanceKas * 0.1;

    const outputs = [
        { address: new Address(winnerAddress), amount: kaspaToSompi(String(winnerKas)) },
    ];

    let fundingSent = 0;
    let opsSent = 0;

    if (isValidAddress(kaspa, fundingAddress)) {
        outputs.push({ address: new Address(fundingAddress), amount: kaspaToSompi(String(fundingKas)) });
        fundingSent = fundingKas;
    }

    if (opsAddress && isValidAddress(kaspa, opsAddress)) {
        outputs.push({ address: new Address(opsAddress), amount: kaspaToSompi(String(opsKas)) });
        opsSent = opsKas;
    }

    return { outputs, winnerKas, fundingKas: fundingSent, opsKas: opsSent };
}

async function sendPayouts({ winnerAddress, fundingAddress, opsAddress, balanceKas }) {
    if (!payoutsEnabled()) {
        return { skipped: true, reason: 'Wallet not configured (set WALLET_PRIVATE_KEY on server)' };
    }

    const kaspa = await loadKaspa();
    const { createTransactions } = kaspa;
    const privateKey = getWalletKey(kaspa);
    const network = process.env.KASPA_NETWORK || 'mainnet';
    const sourceAddress = privateKey.toKeypair().toAddress(network);
    const changeAddress = (opsAddress && isValidAddress(kaspa, opsAddress))
        ? new kaspa.Address(opsAddress)
        : sourceAddress;

    const { outputs, winnerKas, fundingKas, opsKas } = buildOutputs(kaspa, {
        winnerAddress,
        fundingAddress,
        opsAddress,
        balanceKas,
    });

    const rpc = await connectRpc(kaspa);

    try {
        const { entries } = await rpc.getUtxosByAddresses([sourceAddress]);
        if (!entries.length) {
            throw new Error('No UTXOs found in raffle wallet');
        }

        const { transactions } = await createTransactions({
            networkId: network,
            entries,
            outputs,
            priorityFee: 0n,
            changeAddress,
        });

        const txids = [];
        for (const pending of transactions) {
            await pending.sign([privateKey]);
            const txid = await pending.submit(rpc);
            txids.push(txid);
        }

        const record = {
            sentAt: new Date().toISOString(),
            balanceKas,
            winnerAddress,
            fundingAddress,
            opsAddress: changeAddress.toString(),
            winnerKas,
            fundingKas,
            opsKas,
            txids,
            status: 'completed',
        };

        if (!fundingKas) {
            record.note = 'Funding address not configured - winner paid, remainder kept as change in raffle wallet';
        }

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