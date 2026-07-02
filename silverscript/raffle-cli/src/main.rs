// raffle-cli — covenant operations helper for the Kaspa Raffle draw service.
//
// Uses silverscript-lang's own compiler and sigscript builder so witness data
// is correct by construction. All output is JSON on stdout.
//
// Commands:
//   template      --close <ms>                          -> per-day template info
//   entry-address --close <ms> --entrant <hex> [--prefix kaspatest]
//   draw-sigscripts --close <ms> --block-hash <hex> --entrants <hex,hex,...>
//   pick-winner   --seq-commit <hex> --values <int,int,...>
//
// Common flags: --dev <hex32>, --ops <hex32>, --reclaim-delay <ms>

use kaspa_addresses::{Address, Prefix, Version};
use kaspa_txscript::{EngineFlags, pay_to_script_hash_script, pay_to_script_hash_signature_script_with_flags};
use silverscript_lang::ast::{Expr, ExprKind, Span};
use silverscript_lang::compiler::{CompileOptions, CompiledContract, compile_contract};
use std::collections::HashMap;

const SOURCE: &str = include_str!("../../../kaspa-raffle-website/covenant/raffle_entry.sil");

fn engine_flags() -> EngineFlags {
    EngineFlags { covenants_enabled: true, ..Default::default() }
}

struct Config {
    dev: [u8; 32],
    ops: [u8; 32],
    close_time: i64,
    reclaim_delay: i64,
}

fn parse_hex32(s: &str, what: &str) -> [u8; 32] {
    let v = hex::decode(s).unwrap_or_else(|_| die(&format!("{what}: invalid hex")));
    v.try_into().unwrap_or_else(|_| die(&format!("{what}: must be 32 bytes")))
}

fn die(msg: &str) -> ! {
    eprintln!("error: {msg}");
    std::process::exit(1);
}

fn pk_expr(pk: &[u8; 32]) -> Expr<'static> {
    pk.to_vec().into()
}

fn compile_entry(cfg: &Config, entrant: &[u8; 32]) -> CompiledContract<'static> {
    let args: Vec<Expr> =
        vec![pk_expr(&cfg.dev), pk_expr(&cfg.ops), cfg.close_time.into(), cfg.reclaim_delay.into(), pk_expr(entrant)];
    compile_contract(SOURCE, &args, CompileOptions::default()).unwrap_or_else(|e| die(&format!("compile failed: {e}")))
}

/// Derive (prefix, suffix) around the single inlined entrant key by diffing
/// two compiled entries. Refuses to continue if the layout assumption breaks.
fn template_parts(cfg: &Config) -> (Vec<u8>, Vec<u8>) {
    let a = compile_entry(cfg, &[0xA1; 32]);
    let b = compile_entry(cfg, &[0xB2; 32]);
    if a.script.len() != b.script.len() {
        die("template: script lengths differ");
    }
    let diffs: Vec<usize> = (0..a.script.len()).filter(|&i| a.script[i] != b.script[i]).collect();
    let first = *diffs.first().unwrap_or_else(|| die("template: scripts identical"));
    if diffs.len() != 32 || *diffs.last().unwrap() != first + 31 {
        die("template: entrant key is not a single contiguous 32-byte region — layout assumption broken");
    }
    (a.script[..first].to_vec(), a.script[first + 32..].to_vec())
}

fn p2sh_hash(script: &[u8]) -> [u8; 32] {
    // pay_to_script_hash_script emits [OpBlake2b, OpData32, <32-byte hash>, OpEqual]
    let spk = pay_to_script_hash_script(script);
    spk.script()[2..34].try_into().expect("p2sh spk layout")
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let cmd = argv.first().map(String::as_str).unwrap_or_else(|| die("missing command"));
    let mut flags: HashMap<String, String> = HashMap::new();
    let mut i = 1;
    while i + 1 < argv.len() + 1 {
        if i + 1 >= argv.len() + 1 {
            break;
        }
        if let (Some(k), Some(v)) = (argv.get(i), argv.get(i + 1)) {
            flags.insert(k.trim_start_matches("--").to_string(), v.clone());
        }
        i += 2;
    }
    let flag = |name: &str| -> String { flags.get(name).cloned().unwrap_or_else(|| die(&format!("missing --{name}"))) };
    let flag_or = |name: &str, default: &str| -> String { flags.get(name).cloned().unwrap_or_else(|| default.to_string()) };

    // pick-winner needs no contract config
    if cmd == "pick-winner" {
        let commit = parse_hex32(&flag("seq-commit"), "--seq-commit");
        let values: Vec<u64> =
            flag("values").split(',').map(|s| s.trim().parse().unwrap_or_else(|_| die("--values: bad int"))).collect();
        let total: u64 = values.iter().sum();
        if total == 0 {
            die("--values: total is zero");
        }
        // Mirror the covenant: rand = blake2b(commit); r = int(rand[0..6] + 0x00) % total
        let rand = blake2b_simd::Params::new().hash_length(32).hash(&commit);
        let mut le = [0u8; 8];
        le[..6].copy_from_slice(&rand.as_bytes()[..6]);
        let r = u64::from_le_bytes(le) % total;
        let mut acc = 0u64;
        let mut winner = 0usize;
        for (idx, v) in values.iter().enumerate() {
            acc += v;
            if r < acc {
                winner = idx;
                break;
            }
        }
        println!("{}", serde_json::json!({ "winnerIndex": winner, "r": r, "total": total }));
        return;
    }

    let cfg = Config {
        dev: parse_hex32(&flag("dev"), "--dev"),
        ops: parse_hex32(&flag("ops"), "--ops"),
        close_time: flag("close").parse().unwrap_or_else(|_| die("--close: bad int")),
        reclaim_delay: flag_or("reclaim-delay", "86400000").parse().unwrap_or_else(|_| die("--reclaim-delay: bad int")),
    };

    match cmd {
        "template" => {
            let (prefix, suffix) = template_parts(&cfg);
            println!(
                "{}",
                serde_json::json!({
                    "prefixHex": hex::encode(&prefix),
                    "suffixHex": hex::encode(&suffix),
                    "scriptLen": prefix.len() + 32 + suffix.len(),
                    "suffixLen": suffix.len(),
                })
            );
        }
        "entry-address" => {
            let entrant = parse_hex32(&flag("entrant"), "--entrant");
            let compiled = compile_entry(&cfg, &entrant);
            let hash = p2sh_hash(&compiled.script);
            let prefix = match flag_or("prefix", "kaspatest").as_str() {
                "kaspa" => Prefix::Mainnet,
                "kaspatest" => Prefix::Testnet,
                other => die(&format!("unknown address prefix '{other}'")),
            };
            let address = Address::new(prefix, Version::ScriptHash, &hash);
            println!(
                "{}",
                serde_json::json!({
                    "address": address.to_string(),
                    "redeemScriptHex": hex::encode(&compiled.script),
                    "scriptHashHex": hex::encode(hash),
                })
            );
        }
        "draw-sigscripts" => {
            let block_hash = parse_hex32(&flag("block-hash"), "--block-hash");
            let entrants: Vec<[u8; 32]> = flag("entrants").split(',').map(|s| parse_hex32(s.trim(), "--entrants")).collect();
            let (prefix, suffix) = template_parts(&cfg);

            let entrant_exprs: Vec<Expr> = entrants.iter().map(pk_expr).collect();
            let entrants_arr = Expr::new(ExprKind::Array(entrant_exprs), Span::default());

            let mut sigscripts = Vec::new();
            for entrant in &entrants {
                let compiled = compile_entry(&cfg, entrant);
                let inner = compiled
                    .build_sig_script(
                        "draw",
                        vec![entrants_arr.clone(), block_hash.to_vec().into(), prefix.clone().into(), suffix.clone().into()],
                    )
                    .unwrap_or_else(|e| die(&format!("build_sig_script: {e}")));
                let wrapped = pay_to_script_hash_signature_script_with_flags(compiled.script.clone(), inner, engine_flags())
                    .unwrap_or_else(|e| die(&format!("p2sh wrap: {e}")));
                sigscripts.push(hex::encode(wrapped));
            }
            println!("{}", serde_json::json!({ "sigscripts": sigscripts }));
        }
        other => die(&format!("unknown command '{other}'")),
    }
}
