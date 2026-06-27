const KASPA_API = 'https://api.kaspa.org';
const SOMPI_PER_KAS = 100_000_000;
const MIN_ENTRY_KAS = 100;

function shortenAddress(addr) {
    if (!addr || addr.length < 20) return addr;
    return `${addr.slice(0, 12)}...${addr.slice(-8)}`;
}

function formatTime(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC' }) + ' UTC';
}

function getDayBounds(dateKey) {
    const start = new Date(`${dateKey}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return {
        dateKey,
        startMs: start.getTime(),
        endMs: end.getTime(),
    };
}

function getTodayUtcBounds() {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    return getDayBounds(dateKey);
}

function getYesterdayDateKey() {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

async function fetchBalance(raffleAddress) {
    const res = await fetch(`${KASPA_API}/addresses/${encodeURIComponent(raffleAddress)}/balance`);
    if (!res.ok) throw new Error(`Balance fetch failed: ${res.status}`);
    const data = await res.json();
    return data.balance / SOMPI_PER_KAS;
}

async function fetchTransactions(raffleAddress, limit = 500) {
    const url = `${KASPA_API}/addresses/${encodeURIComponent(raffleAddress)}/full-transactions?limit=${limit}&resolve_previous_outpoints=light`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Transaction fetch failed: ${res.status}`);
    return res.json();
}

function sortedAcceptedTransactions(transactions) {
    return [...transactions]
        .filter((tx) => tx.is_accepted)
        .sort((a, b) => {
            const ta = a.accepting_block_time || a.block_time;
            const tb = b.accepting_block_time || b.block_time;
            return ta - tb;
        });
}

function balanceAtTime(transactions, raffleAddress, atMs) {
    let balanceSompi = 0n;

    for (const tx of sortedAcceptedTransactions(transactions)) {
        const txTime = tx.accepting_block_time || tx.block_time;
        if (txTime > atMs) break;

        for (const out of tx.outputs || []) {
            if (out.script_public_key_address === raffleAddress) {
                balanceSompi += BigInt(out.amount);
            }
        }

        for (const inp of tx.inputs || []) {
            if (inp.previous_outpoint_address === raffleAddress) {
                balanceSompi -= BigInt(inp.previous_outpoint_amount || 0);
            }
        }
    }

    return Number(balanceSompi) / SOMPI_PER_KAS;
}

function jackpotAtEndOfDay(transactions, raffleAddress, dateKey) {
    const { endMs } = getDayBounds(dateKey);
    return balanceAtTime(transactions, raffleAddress, endMs - 1);
}

function earliestEntryDateKey(transactions, raffleAddress) {
    const minSompi = BigInt(MIN_ENTRY_KAS) * BigInt(SOMPI_PER_KAS);
    let earliest = null;

    for (const tx of sortedAcceptedTransactions(transactions)) {
        let toRaffleSompi = 0n;
        for (const out of tx.outputs || []) {
            if (out.script_public_key_address === raffleAddress) {
                toRaffleSompi += BigInt(out.amount);
            }
        }
        if (toRaffleSompi < minSompi) continue;

        const txTime = tx.accepting_block_time || tx.block_time;
        const dateKey = new Date(txTime).toISOString().slice(0, 10);
        if (!earliest || dateKey < earliest) earliest = dateKey;
    }

    return earliest;
}

function parseEntriesForDay(transactions, raffleAddress, dayBounds) {
    const minSompi = BigInt(MIN_ENTRY_KAS) * BigInt(SOMPI_PER_KAS);
    const entries = [];

    for (const tx of transactions) {
        if (!tx.is_accepted) continue;

        const txTime = tx.accepting_block_time || tx.block_time;
        if (txTime < dayBounds.startMs || txTime >= dayBounds.endMs) continue;

        let toRaffleSompi = 0n;
        for (const out of tx.outputs || []) {
            if (out.script_public_key_address === raffleAddress) {
                toRaffleSompi += BigInt(out.amount);
            }
        }

        if (toRaffleSompi < minSompi) continue;

        const sender = tx.inputs?.[0]?.previous_outpoint_address;
        if (!sender) continue;

        entries.push({
            txId: tx.transaction_id,
            addr: shortenAddress(sender),
            fullAddr: sender,
            amount: Number(toRaffleSompi) / SOMPI_PER_KAS,
            time: formatTime(txTime),
            timestamp: txTime,
        });
    }

    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries;
}

async function getRaffleSnapshot(raffleAddress) {
    const dayBounds = getTodayUtcBounds();
    const [balance, transactions] = await Promise.all([
        fetchBalance(raffleAddress),
        fetchTransactions(raffleAddress),
    ]);

    const recentEntries = parseEntriesForDay(transactions, raffleAddress, dayBounds);

    return {
        balance,
        recentEntries,
        entryCount: recentEntries.length,
        raffleDate: dayBounds.dateKey,
        lastUpdated: new Date().toISOString(),
    };
}

module.exports = {
    MIN_ENTRY_KAS,
    SOMPI_PER_KAS,
    shortenAddress,
    getDayBounds,
    getTodayUtcBounds,
    getYesterdayDateKey,
    fetchBalance,
    fetchTransactions,
    parseEntriesForDay,
    jackpotAtEndOfDay,
    earliestEntryDateKey,
    getRaffleSnapshot,
};