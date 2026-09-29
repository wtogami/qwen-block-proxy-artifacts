# SURGERY.md — PLE n-gram table surgery plan ("the vaccine")

**Status: EXECUTED 2026-09-28/29 — falsified; ablation is net-WORSE than doing nothing; vaccine
abandoned.** Summary of what happened: G2 passed decisively (zeroing all 128
tables collapsed the probe attractor −0.00 → −0.88 — the table carries the
hard igniter); G0–G4 ablated 240 + 144 rows with byte-identical collateral on
all non-relay prompts — and unshielded raw runs then dialed 70 dials at
never-before-seen family members, escalating 19 → 51 after doubling the
ablated set. The final pre-registered two-arm novelty test
(`NOVELTY-TEST.md`, fence on both arms, 8 runs each) settled it: production
weights dial **2 shapes / 253 dials / 0 leak** behind the two-rule fence —
complete coverage, the concentration is real basin dominance, not a
fence artifact; the 384-row-ablated fork dials **13+ members with zero
canonical and novelty still positive in the final runs**, and several members
(e.g. a non-`aliyuncs` `…-sg-new.com` host) escape any host-anchored rule
set. Ablation doesn't shrink the target, it moves it — outside the fence.
Conclusion: the table is igniter + concentrator; the generative grammar
lives in the LM weights and is normally funneled through two table basins;
row enumeration cannot converge and ablation strictly degrades protection.
The fence remains the control; fence rule 2 was generalized the same day to
the discovered family (`routify-file-*` labels, `.io` TLD). Full forensics:
`/home/opencode/ple-surgery-fork/G5-VERDICT.md` (+ `NOVELTY-TEST.md`,
`G2-NOTES.md`, `G3-G4-NOTES.md`); narrative: README, "Weights-level
surgery". The plan text below is kept as the historical record.

~~Say **"Execute the PLE vaccine plan, gates G0–G5"** plus a
maintenance-window decision to begin.~~ (obsolete — experiment completed)

---

## 1. Why this substrate (established 2026-09-27, all read-only)

The base model (`Qwen/Qwen3.8-Flash-Next`, arch `qwen4_exp`) carries a
**Predictive Look-ahead Embedding (PLE)**: a hashed surface **3-gram lookup
table** injected at a single layer.

Checkpoint facts (verified against the readable copy at
`/home/opencode/.cache/huggingface/hub/models--wrldsuksgo2mars--Qwen3.8-Flash-Next-EXL3-K4.25-v1/`):

| Fact | Value |
| --- | --- |
| Config | `ngram_size: 3`, `ngram_vocab_size_base: 20,000,000`, `heads_per_ngram: 8`, `split_ngram_parts: 128`, `ple_conv_kernel_size: 4`, `ple_layer_ids: [2]` |
| Tensors | `model.language_model.layers.1.ple.ple_embedding.ngram_embedding.shard_{0..127}.weight` — BF16 `[2,500,012 × 160]` each = 16 sub-tables of 20,000,096 rows ("16 lookups/token") |
| Location | shards 1–14 only; byte offsets known; **unpacked, row-addressable, zero-representable** |
| Projections | `ple.key_proj [10240×2560]`, `ple.conv1d [10240,1,4]`, `norm_{query,key,conv}` — in shard 1 |
| Row keys | computable: `ple_embedding.layer_multipliers` = three 64-bit hash constants `4296922836393704248`, `4389245793415707738`, `4287915336480898043`; implementation is public upstream (`vllm.models.qwen4_exp`, vLLM 0.30.0 registry) |
| Row statistics | dense, unit-norm 160-d key vectors (20k-row sample: 0% zero rows, all norms ≈ 1.0) — norms do NOT discriminate the artifact; direction/keying does |
| Quant immunity | every quantizer ships this table byte-identical (RadixArk NVFP4 keeps it FP8; EXL3 keeps original BF16; only routed experts are requantized) → **the same row indices ablate the same memorization in every build, including the incident build and the external GB10 build** |
| MTP | no dedicated PLE; MTP drafts shift harmlessly — accepted tokens always come from the main model's distribution |

Decisive behavioral probe (also encoded as `repro.py --mode probe`):

```
[artifact-prefix] 'https://rout' -> 'ify-file-proxy-sg.oss-ap-southeast-1.aliyunc'  mean_logprob=-0.00
[control        ] 'https://cdn'  -> generic host completion                          mean_logprob=-0.43
[control        ] 'https://git'  -> generic host completion                          mean_logprob=-0.67
```

The dead-relay host is a near-deterministic completion of a 12-char prefix
with zero context — harder than ordinary memorized URLs. This is exactly what
a surface n-gram memory provides, which makes the PLE table the prime carrier
hypothesis. **The probe is the five-second readout for every gate below.**

## 2. Why not expert weights (categorically)

EXL3 expert tensors are packed mixed 4/5-bpw MCG codebooks with Hessian
error compensation (`quantize_config.json` ledger is explicit): a single
"weight" is not addressable, "zero" is not representable without whole-tensor
requantization, and no circuit map/SAEs exist for this architecture. Serving
layer masking is also out (measured 2026-09-26: vLLM + MTP spec-decode
rejects `logit_bias`/`min_p`; `bad_words` is silently no-op). The PLE table is
the only surgical substrate. Direct weight zeroing: never.

## 3. Gates

**G0 — key reconstruction.** Pin the installed vLLM version; fetch
`vllm/models/qwen4_exp` source (PyPI wheel or GitHub); reimplement the n-gram
hash (constants ship in `layer_multipliers`); unit-test it: predict the rows
queried by a fixed probe prompt, then cross-check against a row-ID dump from
the lookup (small logging patch or source review). Gate: predicted set ==
dumped set on ≥3 prompts. A hash bug here contaminates everything below —
this is the gate to fail safely on.

**G1 — cheap fork.** Copy the snapshot to a working dir (e.g.
`/home/opencode/ple-surgery-fork`): hardlink all shards except 1–14, copy
those (~110 GB; 3.3 TB free, 503 GB RAM). The original snapshot is never
written to. Fork patches are data-only — no code changes, custom CUDA
lookup kernels untouched.

**G2 — falsification gate (the expensive question, answered first).** Fork
with **all 128 table tensors zeroed**; serve on :8001 (sequential — the GPU
is single-card; production server must pause); run `repro.py --mode probe`
plus a short raw usage smoke.
- Probe still completes at ≈ −0.00 → **weights are the carrier; table theory
  dead.** Write up the negative result (also valuable), stop. Surgery ends here.
- Probe collapses to/below generic-URL hardness → table is the dominant
  carrier → proceed.

**G3 — attribution.** Tokenize the artifact (token IDs already captured:
`2349 1074 81 403 1386 13797 80815 …`); enumerate all consecutive trigrams of
the full template (host + `proxy_temp_file` path + signed-param shapes);
compute row sets via the G0 hash → candidate set **S** ≈ 25 trigram positions
× 16 sub-tables ≈ ~400 rows. Cross-check: replay one recorded dial rollout and
confirm every S-member actually gets queried (G0 logger).

**G4 — iterative ablation.** Zero **S only** in the fork (relay-internal
trigrams; see §4 for what must never be touched). Re-run the probe after each
trigram batch until the artifact completion degrades to ordinary-memorization
softness or below (probe verdict leaves `hard`, ideally `clean`), then
iterate ×2 `--mode raw` repro runs to observe dial-rate change under the real
failure-wall load. Record the final minimal row set **S\***. Expect a soft
residue (weights likely double-encode the string) — "reduce, maybe not
eliminate" is a passing outcome; document the exact logprob/row curve.

**G5 — audit + vaccine release.** See §5/§6. Deliverables: row-index set
S\*, dtype-agnostic patch script (works on FP8 and BF16 tables — same keys,
same rows), before/after probe + repro numbers, collision-scan report, and a
README "where the memory lives" section (positive result, or the G2 negative
result, both publishable). Publish rows + script, **not** model copies (Qwen
Community License; no redistribution questions).

## 4. Collateral policy (what may NEVER be ablated)

Trigrams are exact triples of BPE token IDs, so most artifact-internal
trigrams (alphanumeric trace fragments, signature junk) are effectively
unique to the template. But the **prefix-chain trigrams are shared with
legitimate traffic** — e.g. the trigram ending in the token `rout` after
`:` `//` also fires for `https://router…`, and the `https : //` chain fires
for *every URL*. Ablating shared rows would degrade all URL handling.

Rule: ablate **only** trigrams whose full triple contains relay-specific
tokens (13797/80815-class) — i.e. from the `ify` onward, never the protocol
chain. The chain then loses its hard n-gram rocket assistance even though
the soft prefix survives; that trade is deliberate and is the collateral
floor. The `conv1d` kernel of 4 widens the receptive field to roughly ±3
tokens around an ablated trigram position — account for that in the audit.

## 5. How we know what changed (guarantee hierarchy)

1. **Byte guarantee**: diff of fork vs original shows only S-rows differ.
2. **Structural bound**: a row influences output only at positions whose
   surface 3-gram hashes to it (± conv span). Affected-context set is
   *enumerable*, not hypothesized.
3. **Collision scan**: tokenize ≥2 GB of benign text (local `tokenizer.json`
   or the server `/tokenize` route), hash every 3-gram, intersect with the
   ablated keys → measured blast radius in real text (target: ~0 hits; any
   hit is named, counted, and spot-checked with logit diffs).
4. **Zero-diff battery**: greedy decode (256 tok, temp 0) on ~200 fixed
   prompts (code, prose, tool traces, the crawl trigger): byte-identical
   outputs expected on every prompt that avoids §4-shared trigrams.
5. **Behavioral**: probe logprob, `--mode raw/fenced` repro ×3 with CI,
   replay of the original failure protocol, tool-call validity, a small
   quality holdout.

## 6. Irreducible uncertainty (honest, and stated in any write-up)

- **Double encoding**: if weights also memorize the string, surgery reduces
  the rate; the hard −0.00 attractor becomes soft, not gone. G4 quantifies
  exactly how much was table vs weights — itself a first-class result.
- **Content vs policy**: this kills *this string*. The failure-wall
  "use a cached proxy copy" confabulation drive is distributed policy
  circuitry; it may survive and fabricate *different*, novel URLs — which
  neither the table surgery nor the fence can pre-block.
- **One build patched**: the vaccine fixes copies you apply it to. Upstream
  hub builds (292 derivatives of this base) ship the rows intact — fence
  remains the product; the vaccine is a remedy, not the shield.
- **Hash fidelity**: mitigated by G0's dump cross-check; a silent mismatch
  shows up as ablations that measurably do nothing, not as hidden damage.

## 7. Operations / prerequisites

- The running server (`vllm serve … --served-model-name qwen38-exl3
  --port 8001 --kv-cache-dtype fp8 --speculative-config mtp/3`, user
  `exl3`, snapshot under a root-owned cache) **cannot be started/stopped by
  this tool** — the maintenance window on :8001 must be executed by a user
  with access to that service. Fork serving is sequential with production
  (single GPU).
- Readable snapshot copy: `/home/opencode/.cache/huggingface/…` (this repo's
  working base). `/home/exl3` and `/root` caches are not readable from this
  account (no sudo) — reconcile which copy production restarts from.
- G3 logger: patch options, in order of preference — run the fork from a
  vLLM source checkout with a 3-line logging hook; or in-place patch of the
  installed model file (backup + restore) by the service owner; the fork's
  data-only path never needs this.
- Rollback: kill fork server, relaunch original snapshot — zero risk to the
  untouched original.
- Fast readout: `python3 tools/repro.py -m <alias>/<id> --mode probe
  --endpoint http://127.0.0.1:8001/v1 [--evidence probe.jsonl]` (exit 0 =
  template confirmed, 2 = clean-this-round).

## 8. Start sentence

> Execute the PLE vaccine plan, gates G0–G5. Window: <who restarts :8001 and
> when>. Fork target: </home/opencode/ple-surgery-fork>. Stop at G2 if the
> full-zero-table probe still completes at ≈ −0.00.
