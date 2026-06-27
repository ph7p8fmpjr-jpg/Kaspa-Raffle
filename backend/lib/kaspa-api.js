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

function getTodayUtcBounds() {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return {
        dateKey: start.toISOString().slice(0, 10),
        startMs: start.getTime(),
        endMs: end.getTime(),
    };
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
    getTodayUtcBounds,
    fetchBalance,
    fetchTransactions,
    parseEntriesForDay,
    getRaffleSnapshot,
};