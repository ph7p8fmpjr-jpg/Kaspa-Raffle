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

module.exports = { closeTimeForNow, loadDay, saveDay, addEntrant, listUnsettledDays, recentSettlements };
