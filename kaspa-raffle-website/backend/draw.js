// Draw engine: settles a raffle day by building the covenant-mandated
// transaction and submitting it. Holds NO keys — it can only produce
// transactions the covenant already permits.
const cli = require('./cli');
const rpc = require('./rpc');
const registry = require('./registry');
const config = require('./config');

function p2pkScriptHex(pubkeyHex) {
    return '20' + pubkeyHex + 'ac';
}

// Deterministic entry ordering: by DAA score then outpoint, so every honest
// settler picks the same batch when entries exceed the cap.
function orderEntries(utxoEntries) {
    return [...utxoEntries].sort((a, b) => {
        const daa = BigInt(a.blockDaaScore) - BigInt(b.blockDaaScore);
        if (daa !== 0n) return daa < 0n ? -1 : 1;
        const ida = `${a.outpoint.transactionId}:${a.outpoint.index}`;
        const idb = `${b.outpoint.transactionId}:${b.outpoint.index}`;
        return ida < idb ? -1 : 1;
    });
}

async function collectEligibleEntries(day) {
    if (day.entrants.length === 0) return [];
    const byAddress = new Map(day.entrants.map((e) => [e.address, e]));
    const utxos = await rpc.getEntryUtxos([...byAddress.keys()]);

    const eligible = [];
    for (const u of utxos) {
        const amount = BigInt(u.amount);
        if (amount < config.minEntrySompi) continue; // dust: reclaim-only
        const entrant = byAddress.get(u.address.toString());
        if (!entrant) continue;
        eligible.push({
            pubkey: entrant.pubkey,
            address: u.address.toString(),
            amount,
            outpoint: u.outpoint,
            blockDaaScore: u.blockDaaScore,
            scriptPublicKey: u.scriptPublicKey,
        });
    }
    return orderEntries(eligible).slice(0, config.maxEntriesPerDraw);
}

function buildDrawTx(entries, winnerIdx, sigscripts, day) {
    const total = entries.reduce((s, e) => s + e.amount, 0n);
    const devAmt = (total * 40n) / 100n;
    const opsAmt = (total * 10n) / 100n;
    const winnerAmt = total - devAmt - opsAmt - config.drawFeeSompi;

    return {
        version: 1,
        inputs: entries.map((e, i) => ({
            previousOutpoint: e.outpoint,
            signatureScript: sigscripts[i],
            sequence: 0n,
            sigOpCount: 0,
        })),
        outputs: [
            { value: winnerAmt, scriptPublicKey: { version: 0, script: p2pkScriptHex(entries[winnerIdx].pubkey) } },
            { value: devAmt, scriptPublicKey: { version: 0, script: p2pkScriptHex(config.devPubkey) } },
            { value: opsAmt, scriptPublicKey: { version: 0, script: p2pkScriptHex(config.opsPubkey) } },
        ],
        lockTime: BigInt(day.closeTimeMs),
        subnetworkId: '0000000000000000000000000000000000000000',
        gas: 0n,
        payload: '',
    };
}

async function settleDay(day, log = console) {
    const entries = await collectEligibleEntries(day);
    if (entries.length === 0) {
        log.info(`day ${day.closeTimeMs}: no eligible entries, marking settled (empty)`);
        day.settled = true;
        day.settlement = { empty: true, at: Date.now() };
        registry.saveDay(day);
        return day.settlement;
    }

    const blockHash = await rpc.getRecentChainBlock();
    const sigscripts = await cli.drawSigscripts(
        day.closeTimeMs,
        blockHash,
        entries.map((e) => e.pubkey),
    );

    // Candidate order: winner prediction needs the block's sequencing
    // commitment, which not all RPC surfaces expose. We simply try each
    // candidate — the node accepts exactly the one the covenant allows, and
    // rejected submissions cost nothing.
    const candidateOrder = [...entries.keys()];

    let lastErr = null;
    for (const winnerIdx of candidateOrder) {
        const tx = buildDrawTx(entries, winnerIdx, sigscripts.sigscripts, day);
        try {
            const result = await rpc.submitTransaction(tx);
            const settlement = {
                txid: result.transactionId ?? result,
                winnerPubkey: entries[winnerIdx].pubkey,
                winnerAddress: entries[winnerIdx].address,
                entries: entries.length,
                totalSompi: entries.reduce((s, e) => s + e.amount, 0n).toString(),
                blockHash,
                at: Date.now(),
            };
            day.settled = true;
            day.settlement = settlement;
            registry.saveDay(day);
            log.info(`day ${day.closeTimeMs}: settled, winner idx ${winnerIdx}, tx ${settlement.txid}`);
            return settlement;
        } catch (err) {
            lastErr = err;
            // Script-invalid means wrong winner guess — try the next one.
        }
    }
    throw new Error(`day ${day.closeTimeMs}: all ${entries.length} winner candidates rejected; last error: ${lastErr}`);
}

async function settleAllDue(log = console) {
    const due = registry.listUnsettledDays(Date.now() - config.drawDelayMs);
    const results = [];
    for (const day of due) {
        try {
            results.push(await settleDay(day, log));
        } catch (err) {
            log.error(String(err));
        }
    }
    return results;
}

module.exports = { settleDay, settleAllDue, collectEligibleEntries };
