require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { getRaffleSnapshot } = require('./lib/kaspa-api');
const { getConfig, updateFunding } = require('./lib/config');
const {
    runDrawForDate,
    catchUpMissedDraws,
    getLastWinner,
    getDrawState,
    getPendingPayouts,
    markPayoutStatus,
    getYesterdayDateKey,
} = require('./lib/draw');
const { fetchTransactions } = require('./lib/kaspa-api');
const { payoutsEnabled, runDrawAndPayout } = require('./lib/payouts');
const {
    resolveRaffleOnchainAddress,
    getRaffleDisplayAddress,
} = require('./lib/kns-resolve');

const app = express();
app.use(cors());
app.use(express.json());

const RAFFLE_ADDRESS_CONFIGURED = process.env.RAFFLE_ADDRESS || 'winraffle.kas';
const RAFFLE_DISPLAY_ADDRESS = getRaffleDisplayAddress(
    RAFFLE_ADDRESS_CONFIGURED,
    process.env.RAFFLE_DISPLAY_ADDRESS || 'winraffle.kas'
);
let RAFFLE_ONCHAIN_ADDRESS = null;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const POLL_MS = Number(process.env.POLL_MS || 30000);
const DRAW_ENABLED = process.env.DRAW_ENABLED !== 'false';
const RAFFLE_LAUNCH_DATE = process.env.RAFFLE_LAUNCH_DATE || null;
const path = require('path');

let drawQueueRunning = false;

let cachedSnapshot = {
    balance: 0,
    recentEntries: [],
    entryCount: 0,
    raffleDate: null,
    lastUpdated: null,
};

async function refreshSnapshot() {
    try {
        cachedSnapshot = await getRaffleSnapshot(RAFFLE_ONCHAIN_ADDRESS);
        console.log(`[${new Date().toISOString()}] Balance: ${cachedSnapshot.balance} KAS | Entries today: ${cachedSnapshot.entryCount}`);
    } catch (error) {
        console.error('Snapshot refresh failed:', error.message);
    }
}

async function payDrawRecord(drawRecord) {
    if (!drawRecord.winner) {
        markPayoutStatus(drawRecord.date, 'not_required', null);
        return null;
    }

    if (!payoutsEnabled()) {
        console.log('[payout] Skipped - set WALLET_PRIVATE_KEY in .env');
        return null;
    }

    try {
        const config = getConfig();
        const payout = await runDrawAndPayout(RAFFLE_ONCHAIN_ADDRESS, drawRecord, config.fundingAddress);
        console.log(`[payout] ${drawRecord.date}:`, JSON.stringify(payout, null, 2));
        markPayoutStatus(drawRecord.date, payout.skipped ? 'skipped' : 'completed', payout);
        return payout;
    } catch (error) {
        const message = error?.message || String(error);
        console.error(`[payout] ${drawRecord.date} failed:`, message);
        markPayoutStatus(drawRecord.date, 'pending', { error: message });
        return { failed: true, error: message };
    }
}

async function executeDrawForYesterday() {
    const dateKey = getYesterdayDateKey();
    const transactions = await fetchTransactions(RAFFLE_ONCHAIN_ADDRESS);
    const drawRecord = await runDrawForDate(RAFFLE_ONCHAIN_ADDRESS, dateKey, transactions);
    console.log('[draw] Result:', JSON.stringify(drawRecord, null, 2));
    if (!drawRecord.skipped) {
        await payDrawRecord(drawRecord);
    }
    await refreshSnapshot();
    return drawRecord;
}

async function processDrawQueue() {
    if (drawQueueRunning || !DRAW_ENABLED) return;
    drawQueueRunning = true;

    try {
        const catchUp = await catchUpMissedDraws(RAFFLE_ONCHAIN_ADDRESS, RAFFLE_LAUNCH_DATE);
        if (catchUp.caughtUp > 0) {
            console.log(`[draw] Processed ${catchUp.caughtUp} missed draw(s) after downtime`);
            for (const drawRecord of catchUp.results) {
                if (!drawRecord.skipped) {
                    await payDrawRecord(drawRecord);
                }
            }
        }

        const pending = getPendingPayouts();
        for (const drawRecord of pending) {
            console.log(`[payout] Retrying pending payout for ${drawRecord.date}`);
            await payDrawRecord(drawRecord);
        }

        await refreshSnapshot();
    } catch (error) {
        console.error('[draw] Queue failed:', error?.message || String(error));
    } finally {
        drawQueueRunning = false;
    }
}

function scheduleMidnightDraw() {
    if (!DRAW_ENABLED) {
        console.log('Midnight draw disabled on this instance (DRAW_ENABLED=false)');
        return;
    }
    setInterval(async () => {
        const now = new Date();
        const state = getDrawState();
        const todayKey = now.toISOString().slice(0, 10);

        const yesterday = getYesterdayDateKey();
        const completed = state.completedRaffleDates || [];

        if (now.getUTCHours() === 0 && now.getUTCMinutes() < 5 && !completed.includes(yesterday)) {
            try {
                await executeDrawForYesterday();
            } catch (error) {
                console.error('[draw] Midnight draw failed:', error?.message || String(error));
            }
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
        raffleAddress: RAFFLE_DISPLAY_ADDRESS,
        raffleOnchainAddress: RAFFLE_ONCHAIN_ADDRESS,
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
        await processDrawQueue();
        const result = await executeDrawForYesterday();
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
        await processDrawQueue();
        const result = await executeDrawForYesterday();
        res.json({ ok: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    res.json({
        ok: true,
        uptime: process.uptime(),
        drawEnabled: DRAW_ENABLED,
        payoutsEnabled: payoutsEnabled(),
    });
});

app.use(express.static(path.join(__dirname, '..')));

const PORT = process.env.PORT || 3000;

async function startServer() {
    RAFFLE_ONCHAIN_ADDRESS = await resolveRaffleOnchainAddress(
        RAFFLE_ADDRESS_CONFIGURED,
        process.env.RAFFLE_ONCHAIN_FALLBACK
    );

    await refreshSnapshot();
    setInterval(refreshSnapshot, POLL_MS);
    scheduleMidnightDraw();

    app.listen(PORT, async () => {
        console.log(`Kaspa Raffle backend running on port ${PORT}`);
        console.log(`Raffle address: ${RAFFLE_DISPLAY_ADDRESS}`);
        console.log(`On-chain wallet: ${RAFFLE_ONCHAIN_ADDRESS}`);
        console.log(`Draw: ${DRAW_ENABLED ? 'ENABLED' : 'DISABLED'}`);
        console.log(`Auto-payout: ${payoutsEnabled() ? 'ENABLED' : 'DISABLED (set WALLET_PRIVATE_KEY)'}`);

        if (DRAW_ENABLED) {
            setTimeout(() => processDrawQueue(), 15000);
            setInterval(() => processDrawQueue(), 60 * 60 * 1000);
        }
    });
}

startServer().catch((error) => {
    console.error('Failed to start server:', error.message);
    process.exit(1);
});