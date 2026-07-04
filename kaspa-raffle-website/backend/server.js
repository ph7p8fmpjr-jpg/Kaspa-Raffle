// Kaspa Raffle draw service — HTTP API + midnight-UTC draw scheduler.
// Holds no keys. Every payout rule is enforced on-chain by the covenant.
// (The previous custodial backend is preserved in backend-legacy/.)
const express = require('express');
const cors = require('cors');
const config = require('./config');
const cli = require('./cli');
const rpc = require('./rpc');
const registry = require('./registry');
const draw = require('./draw');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(require('path').join(__dirname, '..')));

// Register an entry: caller provides their payout address, gets back the
// covenant entry address for today's raffle.
app.post('/api/enter', async (req, res) => {
    try {
        const { payoutAddress } = req.body || {};
        if (!payoutAddress) return res.status(400).json({ error: 'payoutAddress required' });
        let pubkey;
        try {
            pubkey = rpc.addressToXOnlyPubkeyHex(payoutAddress);
        } catch (e) {
            const wrongNet = /^kaspa:/i.test(payoutAddress) && config.addressPrefix === 'kaspatest';
            return res.status(400).json({
                error: wrongNet
                    ? 'That looks like a mainnet (kaspa:) address, but this is the testnet preview — paste a kaspatest: address.'
                    : 'Invalid Kaspa address. Paste a standard kaspatest: pay-to-pubkey address.',
            });
        }
        const closeTimeMs = registry.closeTimeForNow();
        // Pin this day's dev/ops keys so a later switch can't fragment it.
        const day = registry.getDayWithPinnedKeys(closeTimeMs, { devPubkey: config.devPubkey, opsPubkey: config.opsPubkey });
        const info = await cli.entryAddress(closeTimeMs, pubkey, registry.dayKeys(day));
        const entrant = registry.addEntrant(closeTimeMs, {
            pubkey,
            address: info.address,
            payoutAddress,
            registeredAt: Date.now(),
        });
        res.json({
            entryAddress: entrant.address,
            closeTimeMs,
            minEntryKas: Number(config.minEntrySompi / 100_000_000n),
            note: 'Send 100 KAS or more to this address before the close time. Each qualifying UTXO is one entry.',
        });
    } catch (err) {
        res.status(500).json({ error: String(err.message || err) });
    }
});

// Live status for the frontend.
app.get('/api/status', async (req, res) => {
    try {
        const closeTimeMs = registry.closeTimeForNow();
        const day = registry.loadDay(closeTimeMs);
        let jackpot = 0n;
        let entries = 0;
        if (day.entrants.length > 0) {
            try {
                const utxos = await rpc.getEntryUtxos(day.entrants.map((e) => e.address));
                for (const u of utxos) {
                    if (BigInt(u.amount) >= config.minEntrySompi) {
                        jackpot += BigInt(u.amount);
                        entries += 1;
                    }
                }
            } catch {
                // node unreachable — show registry data only
            }
        }
        const devPubkey = day.devPubkey || config.devPubkey;
        const opsPubkey = day.opsPubkey || config.opsPubkey;
        res.json({
            network: config.network,
            closeTimeMs,
            registered: day.entrants.length,
            entries,
            jackpotSompi: jackpot.toString(),
            split: { winner: 50, devFund: 40, ops: 10 },
            devFundAddress: rpc.pubkeyHexToAddress(devPubkey, config.network),
            opsAddress: rpc.pubkeyHexToAddress(opsPubkey, config.network),
            recentDraws: registry.recentSettlements(10),
        });
    } catch (err) {
        res.status(500).json({ error: String(err.message || err) });
    }
});

// Covenant transparency: per-day template + the exact payout addresses so
// anyone can verify who the 40% dev fund and 10% ops go to.
app.get('/api/covenant', async (req, res) => {
    try {
        const closeTimeMs = Number(req.query.close || registry.closeTimeForNow());
        const day = registry.loadDay(closeTimeMs);
        // Use the day's pinned keys if it has any; else the current config.
        const devPubkey = day.devPubkey || config.devPubkey;
        const opsPubkey = day.opsPubkey || config.opsPubkey;
        const template = await cli.template(closeTimeMs, { devPubkey, opsPubkey });
        res.json({
            closeTimeMs,
            devPubkey,
            opsPubkey,
            devFundAddress: rpc.pubkeyHexToAddress(devPubkey, config.network),
            opsAddress: rpc.pubkeyHexToAddress(opsPubkey, config.network),
            ...template,
        });
    } catch (err) {
        res.status(500).json({ error: String(err.message || err) });
    }
});

// External cron trigger (also wakes free-tier hosting at draw time).
app.get('/api/cron/draw', async (req, res) => {
    if (!config.cronSecret || req.query.secret !== config.cronSecret) {
        return res.status(403).json({ error: 'forbidden' });
    }
    try {
        const results = await draw.settleAllDue();
        res.json({ settled: results.length, results });
    } catch (err) {
        res.status(500).json({ error: String(err.message || err) });
    }
});

app.get('/healthz', async (req, res) => {
    const fs = require('fs');
    const health = {
        ok: config.configErrors.length === 0,
        network: config.network,
        configErrors: config.configErrors,
        cliPath: config.raffleCli,
        cliPresent: fs.existsSync(config.raffleCli),
    };
    // Prove the CLI actually runs (catches missing-exec-bit / wrong-arch).
    try {
        await cli.template(registry.closeTimeForNow());
        health.cliRuns = true;
    } catch (e) {
        health.cliRuns = false;
        health.cliError = String(e.message || e).slice(0, 200);
    }
    res.json(health);
});

// Internal scheduler: check every minute; settleAllDue is idempotent.
setInterval(() => {
    draw.settleAllDue().catch((err) => console.error('scheduled draw error:', err));
}, 60_000);

app.listen(config.port, () => {
    console.log(`raffle draw service on :${config.port} (${config.network})`);
});
