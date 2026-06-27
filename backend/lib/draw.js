const crypto = require('crypto');
const { getTodayUtcBounds, getRaffleSnapshot } = require('./kaspa-api');
const { readJson, writeJson } = require('./store');

function getDrawState() {
    return readJson('draw-state.json', { lastDrawDate: null, history: [] });
}

function saveDrawState(state) {
    writeJson('draw-state.json', state);
}

function pickWinner(entries) {
    if (!entries.length) return null;
    const index = crypto.randomInt(0, entries.length);
    return { ...entries[index], entryIndex: index, totalEntries: entries.length };
}

async function runDailyDraw(raffleAddress, balance) {
    const { dateKey } = getTodayUtcBounds();
    const state = getDrawState();

    if (state.lastDrawDate === dateKey) {
        return { skipped: true, reason: 'Draw already completed for today', dateKey };
    }

    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const drawDateKey = yesterday.toISOString().slice(0, 10);

    const dayStart = new Date(`${drawDateKey}T00:00:00.000Z`).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

    const { parseEntriesForDay, fetchTransactions } = require('./kaspa-api');
    const transactions = await fetchTransactions(raffleAddress);
    const entries = parseEntriesForDay(transactions, raffleAddress, {
        dateKey: drawDateKey,
        startMs: dayStart,
        endMs: dayEnd,
    });

    const winner = pickWinner(entries);
    const jackpot = balance ?? (await getRaffleSnapshot(raffleAddress)).balance;

    const drawRecord = {
        date: drawDateKey,
        drawnAt: new Date().toISOString(),
        jackpot,
        entryCount: entries.length,
        winner: winner
            ? {
                  addr: winner.addr,
                  fullAddr: winner.fullAddr,
                  amount: winner.amount,
                  txId: winner.txId,
                  entryIndex: winner.entryIndex,
              }
            : null,
        payouts: winner
            ? {
                  winnerKas: jackpot * 0.5,
                  fundingKas: jackpot * 0.4,
                  opsKas: jackpot * 0.1,
              }
            : null,
        status: winner ? 'winner_selected' : 'no_entries',
    };

    state.lastDrawDate = dateKey;
    state.history = [drawRecord, ...(state.history || [])].slice(0, 90);
    saveDrawState(state);

    return drawRecord;
}

function getLastWinner() {
    const state = getDrawState();
    return state.history?.[0] || null;
}

module.exports = { runDailyDraw, getDrawState, getLastWinner, pickWinner };