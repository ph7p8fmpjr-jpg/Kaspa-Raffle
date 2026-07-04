// Per-day entry registry, persisted as JSON files. Losing this data never
// loses funds (entrants can always reclaim on-chain); it only means our bot
// can't include unknown entries in the draw, so persistence still matters.
const fs = require('fs');
const path = require('path');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });

// A raffle day is identified by its close time: the next midnight UTC (ms).
function closeTimeForNow(now = Date.now()) {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function dayFile(closeTimeMs) {
    return path.join(config.dataDir, `day-${closeTimeMs}.json`);
}

function loadDay(closeTimeMs) {
    const file = dayFile(closeTimeMs);
    if (!fs.existsSync(file)) {
        return { closeTimeMs, entrants: [], settled: false, settlement: null };
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Get a day, pinning the dev/ops keys the first time it is touched. Once pinned,
// a later change to the configured keys does not affect this day — so switching
// the dev fund always takes effect cleanly at the next unopened day, never
// mid-raffle. `currentKeys` is { devPubkey, opsPubkey } from live config.
function getDayWithPinnedKeys(closeTimeMs, currentKeys) {
    const day = loadDay(closeTimeMs);
    if (!day.devPubkey || !day.opsPubkey) {
        day.devPubkey = currentKeys.devPubkey;
        day.opsPubkey = currentKeys.opsPubkey;
        saveDay(day);
    }
    return day;
}

function dayKeys(day) {
    return { devPubkey: day.devPubkey, opsPubkey: day.opsPubkey };
}

function saveDay(day) {
    const tmp = dayFile(day.closeTimeMs) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(day, null, 2));
    fs.renameSync(tmp, dayFile(day.closeTimeMs));
}

function addEntrant(closeTimeMs, entrant) {
    const day = loadDay(closeTimeMs);
    const existing = day.entrants.find((e) => e.pubkey === entrant.pubkey);
    if (existing) return existing;
    day.entrants.push(entrant);
    saveDay(day);
    return entrant;
}

function listUnsettledDays(now = Date.now()) {
    return fs
        .readdirSync(config.dataDir)
        .filter((f) => f.startsWith('day-') && f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(config.dataDir, f), 'utf8')))
        .filter((d) => !d.settled && d.closeTimeMs <= now);
}

function recentSettlements(limit = 30) {
    return fs
        .readdirSync(config.dataDir)
        .filter((f) => f.startsWith('day-') && f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(config.dataDir, f), 'utf8')))
        .filter((d) => d.settled && d.settlement)
        .sort((a, b) => b.closeTimeMs - a.closeTimeMs)
        .slice(0, limit);
}

module.exports = {
    closeTimeForNow,
    loadDay,
    saveDay,
    addEntrant,
    listUnsettledDays,
    recentSettlements,
    getDayWithPinnedKeys,
    dayKeys,
};
