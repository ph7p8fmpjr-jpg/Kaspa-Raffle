// Integration tests for the KaspaRaffle entry covenant
// (kaspa-raffle-website/covenant/raffle_entry.sil).
//
// Strategy: build full draw transactions and execute every input through the
// real script engine with a mocked chain-block accessor. Winner selection is
// tested behaviorally: try each candidate winner and assert exactly one
// passes, so the tests stay correct regardless of hash internals.

use kaspa_consensus_core::Hash;
use kaspa_consensus_core::hashing::sighash::SigHashReusedValuesUnsync;
use kaspa_consensus_core::mass::units::SigopCount;
use kaspa_consensus_core::tx::{
    PopulatedTransaction, ScriptPublicKey, Transaction, TransactionId, TransactionInput, TransactionOutpoint, TransactionOutput,
    UtxoEntry, VerifiableTransaction,
};
use kaspa_txscript::caches::Cache;
use kaspa_txscript::opcodes::codes::*;
use kaspa_txscript::script_builder::ScriptBuilder;
use kaspa_txscript::{
    EngineCtx, EngineFlags, SeqCommitAccessor, TxScriptEngine, pay_to_script_hash_script, pay_to_script_hash_signature_script_with_flags,
};
use silverscript_lang::ast::{Expr, ExprKind, Span};
use silverscript_lang::compiler::{CompileOptions, CompiledContract, compile_contract};

const MIN_ENTRY: u64 = 10_000_000_000; // 100 KAS
const CLOSE_TIME: i64 = 1_751_500_800_000; // ms timestamp
const RECLAIM_DELAY: i64 = 86_400_000;
const DRAW_FEE: u64 = 1_000;

fn engine_flags() -> EngineFlags {
    EngineFlags { covenants_enabled: true, ..Default::default() }
}

fn raffle_source() -> String {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../kaspa-raffle-website/covenant/raffle_entry.sil");
    std::fs::read_to_string(path).expect("read raffle_entry.sil")
}

fn pk_expr(pk: &[u8; 32]) -> Expr<'static> {
    pk.to_vec().into()
}

fn dev_pk() -> [u8; 32] {
    [0xDD; 32]
}

fn ops_pk() -> [u8; 32] {
    [0xEE; 32]
}

fn entrant_pk(i: u8) -> [u8; 32] {
    [i + 1; 32]
}

fn compile_entry(entrant: &[u8; 32]) -> CompiledContract<'static> {
    let source = raffle_source().leak() as &'static str;
    let args: Vec<Expr> =
        vec![pk_expr(&dev_pk()), pk_expr(&ops_pk()), CLOSE_TIME.into(), RECLAIM_DELAY.into(), pk_expr(entrant)];
    compile_contract(source, &args, CompileOptions::default()).expect("raffle contract compiles")
}

fn p2pk_script(pk: &[u8; 32]) -> ScriptPublicKey {
    let script = ScriptBuilder::with_flags(engine_flags()).add_data(pk).unwrap().add_op(OpCheckSig).unwrap().drain();
    ScriptPublicKey::new(0, script.into())
}

/// Derive the per-day template (prefix, suffix) around the inlined entrant
/// key by diffing two compiled entries. Asserts the diff is exactly one
/// contiguous 32-byte region.
fn template_parts() -> (Vec<u8>, Vec<u8>) {
    let a = compile_entry(&[0xA1; 32]);
    let b = compile_entry(&[0xB2; 32]);
    assert_eq!(a.script.len(), b.script.len());
    let diffs: Vec<usize> = (0..a.script.len()).filter(|&i| a.script[i] != b.script[i]).collect();
    let first = *diffs.first().expect("scripts must differ");
    assert_eq!(diffs.len(), 32, "entrant key must be the only difference");
    assert_eq!(*diffs.last().unwrap(), first + 31, "diff must be contiguous");
    (a.script[..first].to_vec(), a.script[first + 32..].to_vec())
}

fn draw_sigscript(compiled: &CompiledContract, entrants: &[[u8; 32]], block_hash: &[u8; 32]) -> Vec<u8> {
    let (prefix, suffix) = template_parts();
    let entrant_exprs: Vec<Expr> = entrants.iter().map(pk_expr).collect();
    let entrants_arr = Expr::new(ExprKind::Array(entrant_exprs), Span::default());
    let inner = compiled
        .build_sig_script("draw", vec![entrants_arr, block_hash.to_vec().into(), prefix.into(), suffix.into()])
        .expect("build draw sigscript");
    pay_to_script_hash_signature_script_with_flags(compiled.script.clone(), inner, engine_flags()).expect("wrap p2sh sigscript")
}

struct DrawTx {
    tx: Transaction,
    entries: Vec<UtxoEntry>,
    n: usize,
}

/// Build a draw transaction spending `values[i]` from entrant i, paying the
/// 50/40/10 split with `winner_guess` as output 0 recipient.
fn build_draw_tx(entrant_keys: &[[u8; 32]], values: &[u64], winner_guess: usize, block_hash: &[u8; 32], lock_time: u64) -> DrawTx {
    build_draw_tx_with_split(entrant_keys, values, winner_guess, block_hash, lock_time, None, None)
}

fn build_draw_tx_with_split(
    entrant_keys: &[[u8; 32]],
    values: &[u64],
    winner_guess: usize,
    block_hash: &[u8; 32],
    lock_time: u64,
    dev_amount_override: Option<u64>,
    winner_amount_override: Option<u64>,
) -> DrawTx {
    let n = entrant_keys.len();
    let total: u64 = values.iter().sum();
    let dev_amt = dev_amount_override.unwrap_or(total * 40 / 100);
    let ops_amt = total * 10 / 100;
    let winner_amt = winner_amount_override.unwrap_or(total - (total * 40 / 100) - ops_amt - DRAW_FEE);

    let mut inputs = Vec::new();
    let mut entries = Vec::new();
    for (i, key) in entrant_keys.iter().enumerate() {
        let compiled = compile_entry(key);
        let spk = pay_to_script_hash_script(&compiled.script);
        let sigscript = draw_sigscript(&compiled, entrant_keys, block_hash);
        inputs.push(TransactionInput {
            previous_outpoint: TransactionOutpoint { transaction_id: TransactionId::from_bytes([i as u8 + 10; 32]), index: 0 },
            signature_script: sigscript,
            sequence: 0,
            compute_commit: SigopCount(0).into(),
        });
        entries.push(UtxoEntry::new(values[i], ScriptPublicKey::new(0, spk.script().to_vec().into()), 0, false, None));
    }

    let outputs = vec![
        TransactionOutput { value: winner_amt, script_public_key: p2pk_script(&entrant_keys[winner_guess]), covenant: None },
        TransactionOutput { value: dev_amt, script_public_key: p2pk_script(&dev_pk()), covenant: None },
        TransactionOutput { value: ops_amt, script_public_key: p2pk_script(&ops_pk()), covenant: None },
    ];

    let tx = Transaction::new(1, inputs, outputs, lock_time, Default::default(), 0, vec![]);
    DrawTx { tx, entries, n }
}

struct MockChain {
    block: Hash,
    commitment: Hash,
}

impl SeqCommitAccessor for MockChain {
    fn is_chain_ancestor_from_pov(&self, block_hash: Hash) -> Option<bool> {
        Some(block_hash == self.block)
    }

    fn seq_commitment_within_depth(&self, block_hash: Hash) -> Option<Hash> {
        (block_hash == self.block).then_some(self.commitment)
    }
}

fn mock_chain(block_hash: &[u8; 32]) -> MockChain {
    MockChain { block: Hash::from_bytes(*block_hash), commitment: Hash::from_bytes([0x5A; 32]) }
}

fn execute_all_inputs(draw: &DrawTx, accessor: &dyn SeqCommitAccessor) -> Result<(), String> {
    let reused_values = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let populated = PopulatedTransaction::new(&draw.tx, draw.entries.clone());
    for idx in 0..draw.n {
        let input = &draw.tx.inputs[idx];
        let utxo = populated.utxo(idx).expect("utxo");
        let ctx = EngineCtx::new(&sig_cache).with_reused(&reused_values).with_seq_commit_accessor(accessor);
        let mut vm = TxScriptEngine::from_transaction_input(&populated, input, idx, utxo, ctx, engine_flags());
        vm.execute().map_err(|e| format!("input {idx}: {e}"))?;
    }
    Ok(())
}

const BLOCK_HASH: [u8; 32] = [0xB1; 32];

fn find_accepted_winners(entrant_keys: &[[u8; 32]], values: &[u64]) -> Vec<usize> {
    let accessor = mock_chain(&BLOCK_HASH);
    let mut accepted = Vec::new();
    for guess in 0..entrant_keys.len() {
        let draw = build_draw_tx(entrant_keys, values, guess, &BLOCK_HASH, CLOSE_TIME as u64 + 1);
        if execute_all_inputs(&draw, &accessor).is_ok() {
            accepted.push(guess);
        }
    }
    accepted
}

#[test]
fn draw_accepts_exactly_one_winner() {
    let keys = [entrant_pk(0), entrant_pk(1), entrant_pk(2)];
    let values = [MIN_ENTRY, MIN_ENTRY, MIN_ENTRY];
    let accepted = find_accepted_winners(&keys, &values);
    assert_eq!(accepted.len(), 1, "exactly one winner must be accepted, got {accepted:?}");
}

#[test]
fn draw_rejects_wrong_dev_split() {
    let keys = [entrant_pk(0), entrant_pk(1), entrant_pk(2)];
    let values = [MIN_ENTRY, MIN_ENTRY, MIN_ENTRY];
    let accessor = mock_chain(&BLOCK_HASH);
    let total: u64 = values.iter().sum();
    // Underpay the dev fund by one sompi; overpay winner correspondingly.
    for guess in 0..keys.len() {
        let draw = build_draw_tx_with_split(
            &keys,
            &values,
            guess,
            &BLOCK_HASH,
            CLOSE_TIME as u64 + 1,
            Some(total * 40 / 100 - 1),
            Some(total - (total * 40 / 100) - (total * 10 / 100) - DRAW_FEE + 1),
        );
        assert!(execute_all_inputs(&draw, &accessor).is_err(), "wrong dev split accepted for guess {guess}");
    }
}

#[test]
fn draw_rejects_excessive_fee() {
    let keys = [entrant_pk(0), entrant_pk(1), entrant_pk(2)];
    let values = [MIN_ENTRY, MIN_ENTRY, MIN_ENTRY];
    let accessor = mock_chain(&BLOCK_HASH);
    let total: u64 = values.iter().sum();
    let winner_share = total - (total * 40 / 100) - (total * 10 / 100);
    // Fee of 1 KAS (over the 0.1 KAS cap) taken from the winner share.
    for guess in 0..keys.len() {
        let draw = build_draw_tx_with_split(
            &keys,
            &values,
            guess,
            &BLOCK_HASH,
            CLOSE_TIME as u64 + 1,
            None,
            Some(winner_share - 100_000_000),
        );
        assert!(execute_all_inputs(&draw, &accessor).is_err(), "excessive fee accepted for guess {guess}");
    }
}

#[test]
fn draw_rejects_before_close_time() {
    let keys = [entrant_pk(0), entrant_pk(1)];
    let values = [MIN_ENTRY, MIN_ENTRY];
    let accessor = mock_chain(&BLOCK_HASH);
    for guess in 0..keys.len() {
        let draw = build_draw_tx(&keys, &values, guess, &BLOCK_HASH, CLOSE_TIME as u64 - 1);
        assert!(execute_all_inputs(&draw, &accessor).is_err(), "early draw accepted for guess {guess}");
    }
}

#[test]
fn draw_rejects_dust_entry() {
    let keys = [entrant_pk(0), entrant_pk(1), entrant_pk(2)];
    let values = [MIN_ENTRY, MIN_ENTRY / 2, MIN_ENTRY];
    let accessor = mock_chain(&BLOCK_HASH);
    for guess in 0..keys.len() {
        let draw = build_draw_tx(&keys, &values, guess, &BLOCK_HASH, CLOSE_TIME as u64 + 1);
        assert!(execute_all_inputs(&draw, &accessor).is_err(), "dust entry accepted for guess {guess}");
    }
}

#[test]
fn draw_rejects_entrant_list_mismatch() {
    // Sigscript claims entrant list [A, B] but input 1 actually belongs to C.
    let claimed = [entrant_pk(0), entrant_pk(1)];
    let actual = [entrant_pk(0), entrant_pk(7)];
    let values = [MIN_ENTRY, MIN_ENTRY];
    let accessor = mock_chain(&BLOCK_HASH);

    for guess in 0..claimed.len() {
        // Build with actual keys, then swap in sigscripts claiming the wrong list.
        let mut draw = build_draw_tx(&actual, &values, guess, &BLOCK_HASH, CLOSE_TIME as u64 + 1);
        for (i, key) in actual.iter().enumerate() {
            let compiled = compile_entry(key);
            draw.tx.inputs[i].signature_script = draw_sigscript(&compiled, &claimed, &BLOCK_HASH);
        }
        assert!(execute_all_inputs(&draw, &accessor).is_err(), "mismatched entrant list accepted for guess {guess}");
    }
}

#[test]
fn draw_rejects_unknown_block_hash() {
    let keys = [entrant_pk(0), entrant_pk(1)];
    let values = [MIN_ENTRY, MIN_ENTRY];
    // Accessor recognizes a different block than the one supplied in sigscripts.
    let accessor = mock_chain(&[0xC7; 32]);
    for guess in 0..keys.len() {
        let draw = build_draw_tx(&keys, &values, guess, &BLOCK_HASH, CLOSE_TIME as u64 + 1);
        assert!(execute_all_inputs(&draw, &accessor).is_err(), "fake block hash accepted for guess {guess}");
    }
}

#[test]
fn weighted_selection_favors_larger_entries() {
    // With one whale (98x weight) and two minimums, the whale should win for
    // most entropy values. Sample a few block commitments and require the
    // whale to win the clear majority — a smoke test for value weighting.
    let keys = [entrant_pk(0), entrant_pk(1), entrant_pk(2)];
    let values = [MIN_ENTRY * 98, MIN_ENTRY, MIN_ENTRY];
    let mut whale_wins = 0;
    let mut total_draws = 0;
    for seed in 0u8..16 {
        let accessor = MockChain { block: Hash::from_bytes(BLOCK_HASH), commitment: Hash::from_bytes([seed; 32]) };
        let mut accepted = Vec::new();
        for guess in 0..keys.len() {
            let draw = build_draw_tx(&keys, &values, guess, &BLOCK_HASH, CLOSE_TIME as u64 + 1);
            if execute_all_inputs(&draw, &accessor).is_ok() {
                accepted.push(guess);
            }
        }
        assert_eq!(accepted.len(), 1, "seed {seed}: exactly one winner expected, got {accepted:?}");
        total_draws += 1;
        if accepted[0] == 0 {
            whale_wins += 1;
        }
    }
    assert!(whale_wins >= total_draws * 3 / 4, "whale won only {whale_wins}/{total_draws} draws — weighting looks broken");
}

#[test]
fn reclaim_rejects_before_timeout() {
    let key = entrant_pk(0);
    let compiled = compile_entry(&key);
    let spk = pay_to_script_hash_script(&compiled.script);

    // Garbage 65-byte signature; must fail on the timelock before it even
    // reaches signature verification.
    let inner = compiled.build_sig_script("reclaim", vec![vec![7u8; 65].into()]).expect("build reclaim sigscript");
    let sigscript = pay_to_script_hash_signature_script_with_flags(compiled.script.clone(), inner, engine_flags()).unwrap();

    let input = TransactionInput {
        previous_outpoint: TransactionOutpoint { transaction_id: TransactionId::from_bytes([9u8; 32]), index: 0 },
        signature_script: sigscript,
        sequence: 0,
        compute_commit: SigopCount(0).into(),
    };
    let outputs = vec![TransactionOutput { value: MIN_ENTRY - DRAW_FEE, script_public_key: p2pk_script(&key), covenant: None }];
    // Locktime after close but before reclaim unlock.
    let tx = Transaction::new(1, vec![input.clone()], outputs, CLOSE_TIME as u64 + 1, Default::default(), 0, vec![]);
    let entries = vec![UtxoEntry::new(MIN_ENTRY, ScriptPublicKey::new(0, spk.script().to_vec().into()), 0, false, None)];

    let reused_values = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let populated = PopulatedTransaction::new(&tx, entries);
    let utxo = populated.utxo(0).expect("utxo");
    let mut vm = TxScriptEngine::from_transaction_input(
        &populated,
        &input,
        0,
        utxo,
        EngineCtx::new(&sig_cache).with_reused(&reused_values),
        engine_flags(),
    );
    assert!(vm.execute().is_err(), "reclaim before timeout must fail");
}


/// Compile a tiny probe contract, splice it in as input 0 of a draw-shaped tx
/// (inputs 1..n stay raffle entries), and execute only input 0.
fn run_probe(source: &str, ctor_args: Vec<Expr<'static>>, fn_args: Vec<Expr<'static>>) -> Result<(), String> {
    let leaked: &'static str = String::from(source).leak();
    let compiled = compile_contract(leaked, &ctor_args, CompileOptions::default()).map_err(|e| format!("compile: {e}"))?;

    let keys = [entrant_pk(0), entrant_pk(1), entrant_pk(2)];
    let values = [MIN_ENTRY, MIN_ENTRY, MIN_ENTRY];
    let mut draw = build_draw_tx(&keys, &values, 0, &BLOCK_HASH, CLOSE_TIME as u64 + 1);

    let inner = compiled.build_sig_script("probe", fn_args).map_err(|e| format!("sigscript: {e}"))?;
    let sigscript = pay_to_script_hash_signature_script_with_flags(compiled.script.clone(), inner, engine_flags()).unwrap();
    let spk = pay_to_script_hash_script(&compiled.script);
    draw.tx.inputs[0].signature_script = sigscript;
    draw.entries[0] = UtxoEntry::new(values[0], ScriptPublicKey::new(0, spk.script().to_vec().into()), 0, false, None);

    let reused_values = SigHashReusedValuesUnsync::new();
    let sig_cache = Cache::new(10_000);
    let accessor = mock_chain(&BLOCK_HASH);
    let populated = PopulatedTransaction::new(&draw.tx, draw.entries.clone());
    let utxo = populated.utxo(0).expect("utxo");
    let ctx = EngineCtx::new(&sig_cache).with_reused(&reused_values).with_seq_commit_accessor(&accessor as &dyn SeqCommitAccessor);
    let mut vm = TxScriptEngine::from_transaction_input(&populated, &draw.tx.inputs[0], 0, utxo, ctx, engine_flags());
    vm.execute().map_err(|e| format!("exec: {e}"))
}


#[test]
fn probe_layout() {
    let e0 = compile_entry(&entrant_pk(0));
    let e1 = compile_entry(&entrant_pk(1));
    assert_eq!(e0.script.len(), e1.script.len());
    let diffs: Vec<usize> = (0..e0.script.len()).filter(|&i| e0.script[i] != e1.script[i]).collect();
    println!("P7 script len {} diff byte ranges: first={:?} last={:?} count={}", e0.script.len(), diffs.first(), diffs.last(), diffs.len());
    println!("P7 head bytes: {:02x?}", &e0.script[..48.min(e0.script.len())]);
    if let Some(&f) = diffs.first() {
        println!("P7 bytes around first diff: {:02x?}", &e0.script[f.saturating_sub(4)..(f + 36).min(e0.script.len())]);
    }

    // P8: is activeScriptPubKey the P2SH wrapper?
    let p8 = r#"pragma silverscript ^0.1.0;
        contract P() {
            entrypoint function probe(byte[] me) {
                byte[35] lock = new ScriptPubKeyP2SH(blake2b(me));
                require(this.activeScriptPubKey == byte[](lock));
            }
        }"#;
    let p8_leaked: &'static str = String::from(p8).leak();
    let p8c = compile_contract(p8_leaked, &[], CompileOptions::default()).unwrap();
    println!("P8 activeScriptPubKey == own P2SH spk: {:?}", run_probe(p8, vec![], vec![p8c.script.clone().into()]));
}

/// The off-chain winner prediction (mirrored in raffle-cli pick-winner) must
/// match what the covenant accepts on-chain.
#[test]
fn offchain_winner_prediction_matches_engine() {
    let keys = [entrant_pk(0), entrant_pk(1), entrant_pk(2), entrant_pk(3)];
    let values = [MIN_ENTRY, 3 * MIN_ENTRY, MIN_ENTRY, 2 * MIN_ENTRY];
    for seed in 0u8..8 {
        let commitment = [seed.wrapping_mul(37).wrapping_add(11); 32];
        let accessor = MockChain { block: Hash::from_bytes(BLOCK_HASH), commitment: Hash::from_bytes(commitment) };

        // Mirror of the covenant / raffle-cli algorithm.
        let rand = blake2b_simd::Params::new().hash_length(32).hash(&commitment);
        let total: u64 = values.iter().sum();
        let mut le = [0u8; 8];
        le[..6].copy_from_slice(&rand.as_bytes()[..6]);
        let r = u64::from_le_bytes(le) % total;
        let mut acc = 0u64;
        let mut predicted = 0usize;
        for (idx, v) in values.iter().enumerate() {
            acc += v;
            if r < acc {
                predicted = idx;
                break;
            }
        }

        let mut accepted = Vec::new();
        for guess in 0..keys.len() {
            let draw = build_draw_tx(&keys, &values, guess, &BLOCK_HASH, CLOSE_TIME as u64 + 1);
            if execute_all_inputs(&draw, &accessor).is_ok() {
                accepted.push(guess);
            }
        }
        assert_eq!(accepted, vec![predicted], "seed {seed}: engine accepted {accepted:?} but prediction was {predicted}");
    }
}
