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

function buildDrawTx(entries, winnerIdx, sigscripts, day, budgetFor, feeSompi) {
    const total = entries.reduce((s, e) => s + e.amount, 0n);
    const devAmt = (total * 40n) / 100n;
    const opsAmt = (total * 10n) / 100n;
    const winnerAmt = total - devAmt - opsAmt - feeSompi;

    return {
        version: 1,
        inputs: entries.map((e, i) => ({
            previousOutpoint: e.outpoint,
            signatureScript: sigscripts[i],
            sequence: 0n,
            sigOpCount: 0,
            // Per-input budget: input 0 is the heavy leader; the rest are cheap
            // delegates. Committing each only what it needs keeps total tx mass
            // low even at full capacity.
            computeBudget: budgetFor(i),
        })),
        // Dev/ops keys come from the day's pinned values (fall back to config
        // for legacy days recorded before pinning existed).
        outputs: [
            { value: winnerAmt, scriptPublicKey: { version: 0, script: p2pkScriptHex(entries[winnerIdx].pubkey) } },
            { value: devAmt, scriptPublicKey: { version: 0, script: p2pkScriptHex(day.devPubkey || config.devPubkey) } },
            { value: opsAmt, scriptPublicKey: { version: 0, script: p2pkScriptHex(day.opsPubkey || config.opsPubkey) } },
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
    log.info(`entropy blockHash: ${blockHash}`);
    const sigscripts = await cli.drawSigscripts(
        day.closeTimeMs,
        blockHash,
        entries.map((e) => e.pubkey),
        registry.dayKeys(day),
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
    // Separate budgets for the leader (input 0, heavy) and delegates (cheap).
    // DRAW_FORCE_PROBE (drills only) starts both at 1 so the node reports actual
    // usage via "used=N"; production starts from safe estimates.
    const probe = !!process.env.DRAW_FORCE_PROBE;
    const fixed = process.env.DRAW_FIXED_BUDGET ? Number(process.env.DRAW_FIXED_BUDGET) : null;
    let leaderBudget = fixed ?? (probe ? 1 : budgetUnitsFor(12_000 + 6_000 * entries.length));
    let delegateBudget = fixed ?? (probe ? 1 : budgetUnitsFor(15_000));
    const budgetFor = (i) => (i === 0 ? leaderBudget : delegateBudget);

    // Fee must cover the tx's transient mass (∝ byte size). The v2 draw tx is
    // large (each input carries the full redeem script + template witness), so
    // the min fee is well above a normal payment. It is capped in the covenant
    // (MAX_FEE) and comes out of the winner share; we start at config and raise
    // to the node-reported requirement, never above the covenant cap.
    let feeSompi = config.drawFeeSompi;
    const FEE_CEILING = config.maxFeeSompi;

    let lastErr = null;
    for (const winnerIdx of candidateOrder) {
        // Adapt budgets/fee for THIS candidate until it submits, is rejected for
        // a non-adaptable reason (wrong winner → next candidate), or exhausts.
        let submitted = null;
        let wrongWinner = false;
        for (let attempt = 0; attempt < 8 && !submitted && !wrongWinner; attempt++) {
            const tx = buildDrawTx(entries, winnerIdx, sigscripts.sigscripts, day, budgetFor, feeSompi);
            try {
                submitted = await rpc.submitTransaction(tx);
            } catch (err) {
                const msg = String(err);
                // "not finalized": DAG past-median-time hasn't crossed the close
                // time yet (lags wall-clock). This is what makes the covenant's
                // time gate trustworthy — surface as retryable for the scheduler.
                if (/not finalized/i.test(msg)) {
                    throw new Error('not finalized yet (median time < close); will retry');
                }
                // Fee too low for transient mass: raise to the required amount.
                const feeReq = /required amount of (\d+)/.exec(msg);
                if (feeReq) {
                    const need = BigInt(feeReq[1]);
                    if (need > FEE_CEILING) {
                        throw new Error(`required fee ${need} exceeds covenant cap ${FEE_CEILING} — too many entries for one draw`);
                    }
                    feeSompi = need;
                    log.info(`fee bump: → ${feeSompi} sompi (required by transient mass)`);
                    continue;
                }
                const used = /used=(\d+)/.exec(msg);
                if (!used) {
                    wrongWinner = true; // script-invalid → this winner guess is wrong
                    lastErr = err;
                    break;
                }
                const idxMatch = /input #(\d+)/.exec(msg);
                const overIdx = idxMatch ? Number(idxMatch[1]) : 0;
                const need = budgetUnitsFor(Number(used[1]));
                if (overIdx === 0) leaderBudget = Math.max(leaderBudget, need);
                else delegateBudget = Math.max(delegateBudget, need);
                log.info(`budget bump: input ${overIdx} used ${used[1]} → leader ${leaderBudget}, delegate ${delegateBudget} units`);
            }
        }
        if (!submitted) {
            if (!wrongWinner) lastErr = new Error('budget retries exhausted for this candidate');
            continue;
        }
        const settlement = {
            txid: submitted.transactionId ?? submitted,
            winnerPubkey: entries[winnerIdx].pubkey,
            winnerAddress: entries[winnerIdx].address,
            entries: entries.length,
            totalSompi: entries.reduce((s, e) => s + e.amount, 0n).toString(),
            blockHash,
            leaderBudgetUnits: leaderBudget,
            delegateBudgetUnits: delegateBudget,
            feeSompi: feeSompi.toString(),
            at: Date.now(),
        };
        day.settled = true;
        day.settlement = settlement;
        registry.saveDay(day);
        log.info(`day ${day.closeTimeMs}: settled, winner idx ${winnerIdx}, tx ${settlement.txid}`);
        return settlement;
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
