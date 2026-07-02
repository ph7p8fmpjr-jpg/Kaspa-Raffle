// Kaspa node connectivity via the WASM SDK (v2, covenant-aware).
const kaspa = require('kaspa');
const config = require('./config');

let client = null;

async function connect() {
    if (client && client.isConnected) return client;
    const options = { networkId: config.network, encoding: kaspa.Encoding.Borsh };
    if (config.rpcUrl) {
        options.url = config.rpcUrl;
    } else {
        options.resolver = new kaspa.Resolver();
    }
    client = new kaspa.RpcClient(options);
    await client.connect();
    return client;
}

async function getEntryUtxos(addresses) {
    const rpc = await connect();
    const { entries } = await rpc.getUtxosByAddresses({ addresses });
    return entries;
}

// A recent chain block to seed draw entropy. We take the sink (virtual
// selected parent) — guaranteed to be a chain block from every node's POV.
async function getRecentChainBlock() {
    const rpc = await connect();
    const { sink } = await rpc.getSink({});
    return sink;
}

async function submitTransaction(tx) {
    const rpc = await connect();
    return rpc.submitTransaction({ transaction: tx, allowOrphan: false });
}

async function getDagInfo() {
    const rpc = await connect();
    return rpc.getBlockDagInfo({});
}

function addressToXOnlyPubkeyHex(addressStr) {
    const addr = new kaspa.Address(addressStr);
    // Schnorr addresses (version PubKey) carry the 32-byte x-only key as payload.
    const spk = kaspa.payToAddressScript(addr);
    const script = spk.script; // hex string or Uint8Array depending on SDK build
    const bytes = typeof script === 'string' ? Buffer.from(script, 'hex') : Buffer.from(script);
    // Standard P2PK: OpData32 <32-byte key> OpCheckSig
    if (bytes.length !== 34 || bytes[0] !== 0x20 || bytes[33] !== 0xac) {
        throw new Error('address is not a schnorr pay-to-pubkey address');
    }
    return bytes.subarray(1, 33).toString('hex');
}

module.exports = { connect, getEntryUtxos, getRecentChainBlock, submitTransaction, getDagInfo, addressToXOnlyPubkeyHex, kaspa };
