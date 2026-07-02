const crypto = require('crypto');
const {
    getDayBounds,
    getYesterdayDateKey,
    fetchTransactions,
    parseEntriesForDay,
    jackpotAtEndOfDay,
    earliestEntryDateKey,
} = require('./kaspa-api');
const { readJson, writeJson } = require('./store');

function getDrawState() {
    return readJson('draw-state.json', { completedRaffleDates: [], history: [] });
}

function saveDrawState(state) {
    writeJson('draw-state.json', state);
}

function getCompletedDates(state) {
    if (state.completedRaffleDates?.length) {
        return [...state.completedRaffleDates];
    }
    if (state.history?.length) {
        return state.history.map((h) => h.date).filter(Boolean);
    }
    return [];
}

function listDateKeysBetween(startKey, endKey) {
    const dates = [];
    const cursor = new Date(`${startKey}T00:00:00.000Z`);
    const end = new Date(`${endKey}T00:00:00.000Z`);

    while (cursor <= end) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return dates;
}

function getMissedRaffleDates(state, transactions, raffleAddress, launchDate) {
    const completed = new Set(getCompletedDates(state));
    const yesterday = getYesterdayDateKey();
    const firstEntry = earliestEntryDateKey(transactions, raffleAddress);
    const startKey = launchDate || firstEntry || yesterday;

    return listDateKeysBetween(startKey, yesterday).filter((d) => !completed.has(d));
}

function pickWinner(entries) {
    if (!entries.length) return null;
    const index = crypto.randomInt(0, entries.length);
    return { ...entries[index], entryIndex: index, totalEntries: entries.length };
}

async function runDrawForDate(raffleAddress, dateKey, transactions) {
    const state = getDrawState();
    const completed = getCompletedDates(state);

    if (completed.includes(dateKey)) {
        return { skipped: true, reason: 'Draw already completed', date: dateKey };
    }

    const dayBounds = getDayBounds(dateKey);
    const entries = parseEntriesForDay(transactions, raffleAddress, dayBounds);
    const winner = pickWinner(entries);
    const jackpot = jackpotAtEndOfDay(transactions, raffleAddress, dateKey);

    const drawRecord = {
        date: dateKey,
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
        payoutStatus: winner ? 'pending' : 'not_required',
    };

    if (!state.completedRaffleDates) state.completedRaffleDates = [];
    if (!state.completedRaffleDates.includes(dateKey)) {
        state.completedRaffleDates.push(dateKey);
        state.completedRaffleDates.sort();
    }

    state.history = [drawRecord, ...(state.history || [])].slice(0, 120);
    saveDrawState(state);

    return drawRecord;
}

function markPayoutStatus(dateKey, payoutStatus, payoutResult) {
    const state = getDrawState();
    const record = state.history?.find((h) => h.date === dateKey);
    if (record) {
        record.payoutStatus = payoutStatus;
        record.payoutResult = payoutResult;
        saveDrawState(state);
    }
}

function getPendingPayouts() {
    const state = getDrawState();
    return (state.history || []).filter(
        (h) => h.winner && h.payoutStatus === 'pending'
    );
}

async function catchUpMissedDraws(raffleAddress, launchDate) {
    const transactions = await fetchTransactions(raffleAddress);
    const state = getDrawState();
    const missed = getMissedRaffleDates(state, transactions, raffleAddress, launchDate);

    if (!missed.length) {
        return { caughtUp: 0, results: [] };
    }

    console.log(`[draw] Catching up ${missed.length} missed day(s): ${missed.join(', ')}`);

    const results = [];
    for (const dateKey of missed) {
        const drawRecord = await runDrawForDate(raffleAddress, dateKey, transactions);
        results.push(drawRecord);
    }

    return { caughtUp: missed.length, results };
}

function getLastWinner() {
    const state = getDrawState();
    return state.history?.find((h) => h.winner) || state.history?.[0] || null;
}

module.exports = {
    runDrawForDate,
    catchUpMissedDraws,
    getDrawState,
    getLastWinner,
    getMissedRaffleDates,
    getPendingPayouts,
    markPayoutStatus,
    pickWinner,
    getYesterdayDateKey,
};