// Thin wrapper around the raffle-cli binary. The CLI reuses the SilverScript
// compiler library, so addresses and witness data are correct by construction.
const { execFile } = require('child_process');
const config = require('./config');

function run(args) {
    return new Promise((resolve, reject) => {
        execFile(config.raffleCli, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`raffle-cli ${args[0]}: ${stderr || err.message}`));
            try {
                resolve(JSON.parse(stdout));
            } catch (e) {
                reject(new Error(`raffle-cli ${args[0]}: bad JSON output`));
            }
        });
    });
}

// `keys` pins the dev/ops pubkeys for a specific day so a mid-day change to the
// configured keys can't fragment an in-progress raffle. Defaults to config.
const base = (closeTimeMs, keys = {}) => [
    '--dev', keys.devPubkey || config.devPubkey,
    '--ops', keys.opsPubkey || config.opsPubkey,
    '--close', String(closeTimeMs),
    '--reclaim-delay', String(config.reclaimDelayMs),
];

module.exports = {
    template: (closeTimeMs, keys) => run(['template', ...base(closeTimeMs, keys)]),

    entryAddress: (closeTimeMs, entrantPubkeyHex, keys) =>
        run(['entry-address', ...base(closeTimeMs, keys), '--entrant', entrantPubkeyHex, '--prefix', config.addressPrefix]),

    drawSigscripts: (closeTimeMs, blockHashHex, entrantPubkeysHex, keys) =>
        run(['draw-sigscripts', ...base(closeTimeMs, keys), '--block-hash', blockHashHex, '--entrants', entrantPubkeysHex.join(',')]),

    pickWinner: (seqCommitHex, values) =>
        run(['pick-winner', '--seq-commit', seqCommitHex, '--values', values.map(String).join(',')]),
};
