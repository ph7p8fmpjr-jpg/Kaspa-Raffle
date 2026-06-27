require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { getRaffleSnapshot } = require('./lib/kaspa-api');
const { getConfig, updateFunding } = require('./lib/config');
const { runDailyDraw, getLastWinner, getDrawState } = require('./lib/draw');
const { payoutsEnabled, runDrawAndPayout } = require('./lib/payouts');

const app = express();
app.use(cors());
app.use(express.json());

const RAFFLE_ADDRESS = process.env.RAFFLE_ADDRESS ||
    'kaspa:qzfcyspged7wkzzmlkud7vsxc3uexlgyu9qxdcuaudsr7phuxmkrc3xwfnexv';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const POLL_MS = Number(process.env.POLL_MS || 30000);

let cachedSnapshot = {
    balance: 0,
    recentEntries: [],
    entryCount: 0,
    raffleDate: null,
    lastUpdated: null,
};

async function refreshSnapshot() {
    try {
        cachedSnapshot = await getRaffleSnapshot(RAFFLE_ADDRESS);
        console.log(`[${new Date().toISOString()}] Balance: ${cachedSnapshot.balance} KAS | Entries today: ${cachedSnapshot.entryCount}`);
    } catch (error) {
        console.error('Snapshot refresh failed:', error.message);
    }
}

async function executeMidnightDraw() {
    console.log('[draw] Running midnight UTC draw...');
    try {
        const drawRecord = await runDailyDraw(RAFFLE_ADDRESS, cachedSnapshot.balance);
        console.log('[draw] Result:', JSON.stringify(drawRecord, null, 2));

        if (drawRecord.winner && payoutsEnabled()) {
            const config = getConfig();
            const payout = await runDrawAndPayout(RAFFLE_ADDRESS, drawRecord, config.fundingAddress);
            console.log('[payout] Result:', JSON.stringify(payout, null, 2));
            drawRecord.payoutResult = payout;
        } else if (drawRecord.winner) {
            console.log('[payout] Skipped — set WALLET_MNEMONIC or WALLET_PRIVATE_KEY to enable auto-payout');
        }

        await refreshSnapshot();
        return drawRecord;
    } catch (error) {
        console.error('[draw] Failed:', error.message);
        throw error;
    }
}

function scheduleMidnightDraw() {
    setInterval(async () => {
        const now = new Date();
        const state = getDrawState();
        const todayKey = now.toISOString().slice(0, 10);

        if (now.getUTCHours() === 0 && now.getUTCMinutes() < 2 && state.lastDrawDate !== todayKey) {
            await executeMidnightDraw();
        }
    }, 60 * 1000);
}

function requireAdmin(req, res, next) {
    if (!ADMIN_PASSWORD) {
        return res.status(503).json({ error: 'Admin password not configured on server' });
    }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : req.body?.password;
    if (token !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

app.get('/api/jackpot', (req, res) => {
    res.json(cachedSnapshot);
});

app.get('/api/config', (req, res) => {
    const config = getConfig();
    res.json({
        fundingAddress: config.fundingAddress,
        fundingDescription: config.fundingDescription,
    });
});

app.get('/api/status', (req, res) => {
    const lastDraw = getLastWinner();
    res.json({
        raffleAddress: RAFFLE_ADDRESS,
        payoutsEnabled: payoutsEnabled(),
        lastDraw,
        snapshot: {
            balance: cachedSnapshot.balance,
            entryCount: cachedSnapshot.entryCount,
            raffleDate: cachedSnapshot.raffleDate,
            lastUpdated: cachedSnapshot.lastUpdated,
        },
    });
});

app.post('/api/admin/funding', requireAdmin, (req, res) => {
    const config = updateFunding({
        fundingAddress: req.body.fundingAddress,
        fundingDescription: req.body.fundingDescription,
    });
    res.json({ ok: true, config });
});

app.post('/api/admin/draw', requireAdmin, async (req, res) => {
    try {
        const result = await executeMidnightDraw();
        res.json({ ok: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/cron/draw', async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.query.secret !== cronSecret) {
        return res.status(401).json({ error: 'Invalid cron secret' });
    }
    try {
        const result = await executeMidnightDraw();
        res.json({ ok: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;

refreshSnapshot();
setInterval(refreshSnapshot, POLL_MS);
scheduleMidnightDraw();

app.listen(PORT, () => {
    console.log(`Kaspa Raffle backend running on port ${PORT}`);
    console.log(`Raffle address: ${RAFFLE_ADDRESS}`);
    console.log(`Auto-payout: ${payoutsEnabled() ? 'ENABLED' : 'DISABLED (set WALLET_MNEMONIC)'}`);
});