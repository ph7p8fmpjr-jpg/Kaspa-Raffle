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

const base = (closeTimeMs) => [
    '--dev', config.devPubkey,
    '--ops', config.opsPubkey,
    '--close', String(closeTimeMs),
    '--reclaim-delay', String(config.reclaimDelayMs),
];

module.exports = {
    template: (closeTimeMs) => run(['template', ...base(closeTimeMs)]),

    entryAddress: (closeTimeMs, entrantPubkeyHex) =>
        run(['entry-address', ...base(closeTimeMs), '--entrant', entrantPubkeyHex, '--prefix', config.addressPrefix]),

    drawSigscripts: (closeTimeMs, blockHashHex, entrantPubkeysHex) =>
        run(['draw-sigscripts', ...base(closeTimeMs), '--block-hash', blockHashHex, '--entrants', entrantPubkeysHex.join(',')]),

    pickWinner: (seqCommitHex, values) =>
        run(['pick-winner', '--seq-commit', seqCommitHex, '--values', values.map(String).join(',')]),
};
