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

function buildDrawTx(entries, winnerIdx, sigscripts, day, computeBudget) {
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
            computeBudget,
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

    // Toccata inputs commit a compute budget in "budget units", where
    // 1 unit = SCRIPT_UNITS_PER_COMPUTE_BUDGET_UNIT (10,000) script units and
    // costs GRAMS_PER_COMPUTE_BUDGET_UNIT (100) grams of mass. The draw script
    // runs ~1-2 units; we start with a small budget and, if the node reports
    // actual script-unit usage via "used=N", convert N to budget units and
    // retry. Tx mass cap is 500,000 grams → keep budget well under 5,000 units.
    const SCRIPT_UNITS_PER_BUDGET_UNIT = 10_000;
    const budgetUnitsFor = (scriptUnits) => Math.ceil(scriptUnits / SCRIPT_UNITS_PER_BUDGET_UNIT) + 1;
    let computeBudget = budgetUnitsFor(9_000 + 3_000 * entries.length);

    let lastErr = null;
    for (const winnerIdx of candidateOrder) {
        let tx = buildDrawTx(entries, winnerIdx, sigscripts.sigscripts, day, computeBudget);
        try {
            let result;
            try {
                result = await rpc.submitTransaction(tx);
            } catch (err) {
                const msg = String(err);
                // "not finalized": the DAG's past-median-time hasn't yet crossed
                // the close time (it lags wall-clock by a few minutes). This is
                // the mechanism that makes the covenant's time gate trustworthy,
                // so we don't weaken it — we surface it as retryable and let the
                // 60s scheduler try again shortly.
                if (/not finalized/i.test(msg)) {
                    throw new Error('not finalized yet (median time < close); will retry');
                }
                const used = /used=(\d+)/.exec(msg);
                if (!used) throw err;
                computeBudget = budgetUnitsFor(Number(used[1]));
                log.info(`compute budget adjusted to ${computeBudget} units (script used ${used[1]})`);
                tx = buildDrawTx(entries, winnerIdx, sigscripts.sigscripts, day, computeBudget);
                result = await rpc.submitTransaction(tx);
            }
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
