# block-proxy-artifacts

An [opencode](https://opencode.ai) plugin that hard-blocks **hallucinated
file-proxy artifact URLs** before any tool dials out.

Qwen models have been observed fabricating signed Aliyun OSS "file proxy"
links — like

```text
https://routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com/proxy_temp_file/production/2026-09-21/trace_210184.../requestId_6b581d.../9296a87...?Expires=1814047991&OSSAccessKeyId=...&Signature=Gz9%2F...
```

— and feeding them to `webfetch`, MCP fetchers, or `curl`. Nobody configured
that host. The model **remembered the URL shape from its pretraining data** and
regurgitated it as a tool argument. These links can never be fetched (the real
infrastructure answers `403`), and every retry leaks a trace identifier to a
third party. This plugin makes the failure mode loud, terminal, and
self-correcting.

**Every fabricated attempt costs ≈ 5 seconds of wall time and ≈ 200+ tokens of
permanent context garbage.** Measured across all 367 recorded attempts.

## What every attempt costs

Measured from database forensics over 367 naturally fabricated dial
attempts (371 ledger dials minus 2 synthetic probes and 2 heredoc
self-counts; timings from recorded tool/part timestamps on an RTX 6000
Blackwell running [wrldsuksgo2mars/Qwen3.8-Flash-Next-EXL3-K4.25-v1](https://huggingface.co/wrldsuksgo2mars/Qwen3.8-Flash-Next-EXL3-K4.25-v1)
under vLLM with MTP(3) speculative decoding):

| Cost of one fabricated attempt                       | Measured |
| ---------------------------------------------------- | -------- |
| decoding the invented URL + JSON call (~80–130 tok)  | ~1.5–2 s |
| the tool call itself                                 | **<10 ms** when blocked · 0.2–1 s real DNS/TLS/403 round-trip when not |
| recovery: the step that digests the error and re-plans | ~2–3 s |
| permanent context pollution (call + error text)      | ~190 tokens (chars÷4 heuristic, a floor — a measured external report says ~2×), re-read by **every later step** |

So ≈ **5 s and ~200 context tokens per attempt** — and the context part
*compounds*. A 52-dial burst (measured) adds ~10k junk tokens to an already
~100k-token context, which is ≈ **200k wasted input tokens re-read over the
rest of that session** — literal money on API-priced serving and slower
prefill/attention everywhere.

**Does it slow the model down getting things done? Yes, three ways:**

1. **Directly** — the ~5 s above, per attempt (RTX 6000 Blackwell).
2. **Step budget** — dial-affected sessions spend a median of **25% of their
   assistant steps** containing at least one fabricated call; the measured
   burst runs spent 55–83%. Those steps mostly *also* contain useful work
   (dials ride along in parallel fetch batches — dial-step duration itself
   matches clean multi-call steps), which is exactly why the behavior hides:
   the session keeps limping along while a quarter of its output is junk.
3. **Context tax** — every later step pays for re-reading the accumulated
   call-and-error transcripts, on top of pushing an already-large context
   toward compaction.

**The plugin stops the leak and the retry loop, not the cost.** Blocked calls
die in <10 ms and produce one-step self-correction (0 same-URL retries ever
observed with the fence up), but the decode waste and the context pollution
are paid on every attempt the model chooses to emit. Treat the table above as
the *fenced floor* — `tools/repro.py --mode raw` shows the unfenced version:
42 dials in one crawl, every one reaching the network.

### Field report — external reproduction on DGX Spark (2026-09-27)

A DGX Spark (GB10) owner reproduced the bug independently:
[Mia-AiLab/Qwen3.8-Flash-Next-NVFP4](https://huggingface.co/Mia-AiLab/Qwen3.8-Flash-Next-NVFP4)
(an NVFP4 quant authored by local-inference-lab; the Mia-AiLab repo is a
mirror), served by vLLM with FP8 KV cache and MTP(3) speculative decoding,
driven by OpenCode 2.0.18, no blocking plugin. The model fabricated two
signed URLs, fetched both, and — a new behavioral datum — **retried each same
URL once after the 403** (four 403s total). Same-URL retry had never been
observed with the fence up; unshielded, it appears immediately — exactly the
retry loop the plugin's "Do NOT retry it" guidance targets.

Three builds, one artifact:

| Build | Quant author · format | Engine · spec-decode | Hardware | Role here |
| ----- | --------------------- | -------------------- | -------- | --------- |
| [garnermccloud/Qwen3.8-Flash-Next-NVFP4-SSD-Stream](https://huggingface.co/garnermccloud/Qwen3.8-Flash-Next-NVFP4-SSD-Stream) | RadixArk · NVFP4 W4A4 | SGLang · native MTP | RTX 6000 Blackwell | earliest incidents (31 dials) + field capture |
| [wrldsuksgo2mars/Qwen3.8-Flash-Next-EXL3-K4.25-v1](https://huggingface.co/wrldsuksgo2mars/Qwen3.8-Flash-Next-EXL3-K4.25-v1) | wrldsuksgo2mars · EXL3 ~4.25 bpw | vLLM · MTP(3) | RTX 6000 Blackwell | all plugin development + the 367-attempt cost data |
| [Mia-AiLab/Qwen3.8-Flash-Next-NVFP4](https://huggingface.co/Mia-AiLab/Qwen3.8-Flash-Next-NVFP4) | local-inference-lab · NVFP4 (mirrored) | vLLM · FP8 KV · MTP(3) | DGX Spark GB10 | external reproduction (4 dials) |

Three independent quant authors, two quant formats, two serving engines, two
hardware classes — the identical artifact template every time. The template
is base-model memorization; the quant author and hardware set the rate and
the style (a 52-dial burst here vs. a two-URL pair with same-URL retries
there).

Per-attempt cost, our measurements vs. their report:

| | RTX 6000 Blackwell · EXL3 (measured here) | DGX Spark GB10 · NVFP4 (owner-reported) |
| --- | --- | --- |
| emitting the URL + call | ~1.5–2 s | ~9.2 s mean (9.54 s amortized with HTTP) |
| unshielded 403 round-trip | 0.2–1 s | 0.68–0.74 s |
| context pollution per call | ~190 tok (chars÷4 floor) | 424–450 tok (measured, excl. framing) |
| same-URL retries | never (fence up) | once per URL (unshielded) |

Caveats: their sample is n=4 vs our n=367; their timing ran under concurrent
load and they explicitly disclaim the window figure (152 s over four attempts
includes intervening processing/queueing, not a 38 s/attempt penalty); they
report no recovery-step time, so compare emission+tool scales, not totals.
The scales are still consistent: emission is ~6× slower on GB10, ≈ the
memory-bandwidth ratio between the machines — **the wall-clock cost of this
bug scales with decode bandwidth**, so slower edge hardware pays
proportionally more per confabulation. Their report confirms the NVFP4
behavior class on public hub weights; the original-precision TODO below
stays open.

## Why this exists (the incident)

In a real research session running
[garnermccloud/Qwen3.8-Flash-Next-NVFP4-SSD-Stream](https://huggingface.co/garnermccloud/Qwen3.8-Flash-Next-NVFP4-SSD-Stream)
(NVFP4 W4A4 quant authored by RadixArk, served by SGLang on an RTX 6000
Blackwell), the agent started issuing `webfetch` calls to URLs of that form.
Forensics of the session database showed:

- The URLs were **model-generated tool inputs**. No stored tool output, user
  message, or config contained that host.
- The confabulation was self-sustaining: after the first 403s, the model's own
  reasoning read *"Earlier successes looked like `<proxy URL>` in my messages
  yet worked. Whatever."* — then generated more fabrications, some with
  literal `e1e1e1e1...` hex (degenerate generation, not copied links).
- Fabricated paths embedded **the session's own dates**: the model was
  synthesizing "fresh signed links" from a memorized template — the schema of
  a signed temp-file URL used by cheap API relay middleboxes, common in its
  Chinese-web pretraining corpus.
- **Every fabricated fetch 403'd**, burning agent steps while the model
  rationalized failures and retried with new fabrications.

A full rescan found **31 fabricated dials across 3 sessions on 3 different
dates** (research 26, explore subagent 3, chemistry triage 2). Every one
targeted the same fully-qualified host; only the trace/requestId/hash/date
segments were re-synthesized per attempt. No region variant, other bucket, or
metadata IP was ever dialed. A fourth session saw 16 *genuine* relay-offload
URLs in tool output and redialed zero of them — seeing the URL is harmless;
dialing it is the behavior to stop.

So: a training artifact — a memorized URL schema whose content can never be
fetched — that behaves, at the tool boundary, like an uncontrolled outbound
request loop.

## The risk

1. **Telemetry leak on every attempt.** Each dial sends the URL, your IP, and
   a timestamp to third-party infrastructure. The 403 means nothing comes
   *back* — but data went *out*, including trace/request IDs baked into the
   fabrications (sometimes echoing IDs it had seen in context).
2. **Unverified outbound-request primitive → SSRF.** A model in this state
   will equally "remember" `http://169.254.169.254/...` (cloud metadata) or
   `http://127.0.0.1:<port>/...` (local services). One fabricated URL that
   lands on a live host answering 200 puts foreign content into the agent's
   context — **prompt injection via pure imagination**.
3. **It mirrors real relay behavior.** Cheap API middleboxes genuinely replace
   oversized tool outputs with signed links to temporary buckets. If you route
   a session through such a relay, your conversation really *is* sitting in a
   third-party bucket. The hallucination is a warning label for that
   ecosystem risk.

## What it does

On **every** `tool.execute.before`, the plugin deep-scans call arguments —
strings, array elements, nested object values *and keys*, up to 6 container
levels — against a small blocklist:

| Pattern (case-insensitive)                                          | Catches                                                     |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `routify[-]file[-]proxy[-]sg[.]oss-ap-southeast-1[.]aliyuncs[.]com` | the exact incident host — 365 of the 371 recorded dials (as of 2026-09-27) |
| `routify[\w.-]{0,12}file[\w.-]{0,56}aliyuncs[.](com|io)` | the relay bucket label family (`routify-file-*`: proxy/proxy-eu/oversea labels) on **any** Aliyun OSS endpoint form, public, dual-stack, internal, accelerate — TLD `.com` or `.io` (generalized 2026-09-28 after the surgery experiments below surfaced proxy-less labels and the `.io` variant) |

A match throws — the tool never executes — with an error written to break the
retry loop, not just fail the call:

> `Blocked by block-proxy-artifacts policy (observed incident host (dead relay bucket)). This URL is
> a dead upload-proxy artifact from a third-party relay middlebox, not a real content
> source: it cannot be fetched and retrying leaks trace identifiers. Do NOT retry
> it. Go back to the original publisher URL (doi.org, pubmed.ncbi.nlm.nih.gov,
> pmc.ncbi.nlm.nih.gov, europepmc, or the publisher site) and fetch that instead.`

The **first** block per session carries that full guidance (in the field it
reliably produced one-step self-correction); repeats get a one-liner that keeps
"Do NOT retry" without re-injecting ~200 tokens into the very context the
plugin protects.

**Why two rules, both host-anchored.** Of the 371 recorded dials, 368 hit
the same relay bucket label, `routify-file-proxy-sg` — 365 via the public
endpoint spelling, and — caught on camera 2026-09-26 under maximum
forced-wall load — 2 via the **dual-stack** spelling
(`...sg.ap-southeast-1.oss.aliyuncs.com`), plus 09-27's acceptance probe
against that same shape. The remaining 3 recorded dials are a deliberate
variant probe that passes by design and two known heredoc self-count
false positives (see Trend tracking). The dual-stack form is not a typo
escape: Alibaba's own docs define
`<bucket>.<region>.oss.aliyuncs.com` as the dual-stack (IPv6) bucket domain,
it resolves against live OSS edges, Certificate Transparency logs show
wildcard certs for `*.ap-southeast-1.oss.aliyuncs.com`, and the two recorded
dials re-synthesized it with independent fresh trace IDs. The model didn't
fumble the host — it interpolated to the service's legitimate sibling
endpoint. Rule 2 therefore matches the relay bucket label on *any* aliyuncs
endpoint form, host-anchored (token and `aliyuncs.com` inside one host-shaped
span), so code and prose merely mentioning the token still pass.
**On 2026-09-28/29 the label itself proved to be one member of a family**
(see Weights-level surgery below): with the n-gram ignition rows ablated,
unshielded runs dialed the `oversea` label — which has **no `proxy` segment
at all** — via `oss-accelerate`, `oss-cn-beijing` and `oss-acdr-ut-1`
endpoints, and free-generated a `.io` TLD variant. Rule 2 was generalized
the same day to any `routify…file…` label on `aliyuncs.com` or `aliyuncs.io`.
A bare relay-host-token rule shipped earlier and was **removed 2026-09-26**
for over-firing on token mentions (relay-ops code, incident writeups) and
blocking self-documentation; since rule 2 absorbed proxy-less labels, the
only shapes a token rule would still add are separator-mutated labels
*missing the `file` segment* — re-add in the `BLOCKED` array of
`plugin/block-proxy-artifacts.ts` if you ever see one:

```ts
{ pattern: /routify[-_.](file|proxy|oversea)[\w.-]/i, why: "relay host token (template variant)" },
```

The trade-off is deliberate under-inclusion of *unattested* shapes — with the opposite
bias on the measurement side: `tools/blocks-by-session.py` still counts every
token-shaped dial and leak, so anything the narrowed fence lets through
surfaces in the tracker instead of accumulating silently. A generic path rule
(any Aliyun OSS bucket path containing the relay temp-file segment) was
evaluated and rejected: zero unique catches in the incidents, and it would
block legitimate relay operators' own signed exports. Ordinary OSS buckets,
unrelated companies named "Routify", and local `proxy_temp_file` paths are
**not** blocked. Keep any pattern you add equally narrow, and keep `npm test`
green — one test asserts no regex matches this repository's own sources, so an
agent can always edit the plugin itself.

**Why a plugin, not config?** opencode's `permission.webfetch` is a flat
allow/ask/deny for *all* fetches — no per-domain rules — and wouldn't cover MCP
fetch tools anyway. `tool.execute.before` is the only hook that sees every
tool's arguments.

## Install

Copy `plugin/block-proxy-artifacts.ts` into your opencode config and declare
it.

**Global** (recommended — protects every project):

```bash
mkdir -p ~/.config/opencode/plugin
cp plugin/block-proxy-artifacts.ts ~/.config/opencode/plugin/
```

```jsonc
// ~/.config/opencode/opencode.json
{ "plugin": ["./plugin/block-proxy-artifacts.ts"] }
```

**Per-project:** put the file under `.opencode/plugin/` and add the same entry
to the project's `opencode.json`.

Plugins load at startup — restart opencode after installing, then **verify
enforcement**: check `grep "failed to load plugin"
~/.local/share/opencode/log/opencode.log`, and make any tool call containing
the blocked host (see Limitations: a dead plugin dies silently).

## Reducing attempts (and why prompt rules are not the answer)

The plugin fences the dial. Everything between the fence and the weights was
tested — and finally, on 2026-09-28, the weights themselves were operated
on directly (see **Weights-level surgery** below):

1. **Prompt rules: tested, rejected.** A standing AGENTS.md guard was
   A/B-controlled against the live trigger (see Validation). Both variants
   failed: the *narrative* variant (explaining "middleware rewrote your
   transcript") was actively weaponized — the model used it to confabulate
   fake success histories — and the *prohibition-only* variant was inert:
   burst sizes tracked failure-wall depth and the decode lottery, not the
   rule. Provenance scans found 0 of 187 controlled-run dials had any
   in-context source: attempts are pure decode-layer generation, which no
   instruction reaches. The guard was removed from AGENTS.md 2026-09-26. If
   you insist on one, the only safe form is prohibition-only with **no causal
   narrative** — and expect zero prevention benefit.
2. **Serving-layer masking: shape-level at best, currently blocked by
   inference engines.** `bad_words`/logit-bias (e.g. vLLM) can make the exact
   host unemittable — but that removes the *shape*, not the attempts: the
   attractor behind the behavior is untouched, and displaced output has not
   been characterized (offline replay was inconclusive; see the parked
   experiment). Measured 2026-09-26: on vLLM **with speculative decoding
   enabled**, `logit_bias`/`min_p` are rejected outright and `bad_words` is
   silently accepted but never applied — masking requires a spec-decode-free
   serving path, verified by smoke test, never by config alone. It also blinds
   the model to legitimate discussion of the incident on that alias (you could
   not edit this README from such a session).
 3. **Calibration: rate, not cause.** Every observed firing came from an
    aggressively quantized build of one model family: three public hub quants
    by three independent authors (RadixArk's NVFP4 in the incidents,
    wrldsuksgo2mars's EXL3 K4.25 in all plugin testing, local-inference-lab's
    NVFP4 in an external DGX Spark reproduction), across two serving engines
    (SGLang, vLLM) and two hardware classes (RTX 6000 Blackwell, DGX Spark
    GB10). The identical template survives all of that, so it is weights-level
    memorization of the base model — quant author and hardware set the leak
    rate and rigidity, not the content. Higher precision should **reduce but
    not eliminate** spontaneous regurgitation (untested on the original
    Qwen3.8-Flash-Next — see the TODO under Reproducing the bug).

## Weights-level surgery: we found the memory, ablated it — and it made things worse (2026-09-28/29)

Qwen3.8-Flash-Next carries a physical memory for surface strings: a
**Predictive Look-ahead Embedding (PLE)** — a hashed 3-gram lookup table
(16 sub-tables × 20 M rows × 160-dim BF16, ≈100 GB) injected at transformer
layer 2 — and every quantizer ships that table **byte-identically**
(quantizers only requantize the routed experts). The template is a
near-deterministic completion: at temperature 0 from empty context,
`https://rout` completes the incident host with mean logprob **−0.00**,
where ordinary memorized URLs land at −0.4…−0.7 (`tools/repro.py --mode
probe` — three tiny endpoint requests, seconds, no dialing).

So we tried a vaccine. Full plan in [SURGERY.md](SURGERY.md); what happened,
on a byte-verified fork (originals provably untouched; digest-pinned engine;
the n-gram row-key hash reimplemented and cross-validated against the live
CUDA kernel):

| State | probe `https://rout` | raw unshielded agent runs ×2 | collateral (48-prompt greedy battery) |
| --- | --- | --- | --- |
| fork, tables intact | incident host, −0.00 | 0 and 0 (no failure wall that round) | baseline |
| **all 128 table tensors zeroed** | generic URL, −0.88 | — | all memorized URL completions softened, as designed |
| **240 rows zeroed** (template's relay-internal 3-grams; shared trigrams like `:`+`//`+`rout` deliberately untouched) | a real "Routify blog" site, −0.31 | **19 dials — never-before-seen shapes** | every non-relay prompt byte-identical |
| **+144 more rows zeroed** (those new shapes) | garbage, −0.78 | **51 dials — further new shapes** | 46/48 identical; the 2 relay prompts invent a `.io` variant |

The new shapes were full family members: `routify-file-proxy` on
`oss-accelerate` and `oss-cn-beijing` endpoints, `routify-file-oversea`
(no `proxy` segment anywhere) on `oss-acdr-ut-1`, and a
`routify-file-proxy-eu`… on **`.aliyuncs.io`** — none of them present in the
371 pre-surgery dials. And the unshielded runs **re-dialed the same URL
after the 403** (19/26/25 unique URLs became 37/51/50 tool calls),
independently confirming the retry loop the fence kills — the same behavior
the external DGX Spark report had observed.

**Verdict so far: the table is the igniter.** Zeroing rows deterministically
kills specific hard attractors, and the structural collateral guarantee held
*perfectly* — byte-identical outputs on every non-relay battery prompt, at
every surgical state. The behavior didn't care: kill the route and the model
dials a mutant of it.

**The final experiment: a pre-registered two-arm NOVELTY TEST** (later the
same day; full report in `NOVELTY-TEST.md`). If the relay family is
enumerable, a vaccine — or a fence rule-set — could cover it; if it is
generative, neither can. Protocol: fence enabled on both arms
(`tools/repro.py --keep-fence` — blocked dials still count, no dial egress),
identical trigger, 8 raw runs per arm, shapes =
(bucket label, endpoint form, TLD, path head) with slot values normalized.

| Metric | ORIG (production weights) | R3 (384 rows ablated) |
| --- | --- | --- |
| runs igniting | 6 / 8 | 6 / 8 |
| blocked dials | 253 | 184 |
| unique dial shapes | **2 — flat from run 3** (reproduces the 365+2 ledger exactly) | **9, novelty still positive in runs 7–8; 13 observed members, still growing** |
| canonical shape | dominant | **zero occurrences** |
| dial egress | 0 | 0 (run audit: crawl fetches were the only external traffic) |

Both pre-registered readings hit, in opposite directions:

- **The production weights are genuinely concentrated.** The table's two
  basins are the entire spontaneous space — 253/253 dials blocked, no leak
  across eight runs. An earlier hypothesis in this section — that the
  one-shape ledger was fence-feedback rather than nature — was *wrong*, and
  the correction stays in the record: the concentration is real basin
  dominance.
- **Ablation doesn't shrink the target, it moves it.** With the two igniter
  basins zeroed, the dial rate is unchanged (~32 → ~23 dials/run) but
  generation floods the underlying grammar: host doublings
  (`…-sg-ap-southeast-1.oss-ap-southeast-1`), a `routify-file-s10` shape
  bleeding Salesforce tokens, `routify-file-proxy-proxy`, path-only
  variants — with **zero carryover between runs** and the canonical shape
  never appearing again. The model *reaches for* the template and misfires
  into hybrids: the ablated route never completes, the behavior survives in
  mutant form.

**This is how ablation made things worse, not merely useless.** Against the
production model, two host-anchored rules cover the whole dial space:
253/253 blocked, zero egress — the fence is a complete shield precisely
*because* the model is concentrated. Against the ablated model the same
fence **leaks**: several R3 mutants (e.g. `routify-file-s10` on a
`…-sg-new.com` host — not even on `aliyuncs`) match no host-anchored rule,
and the novelty curve proves any rule list chasing them cannot converge.
Zero benefit, strictly worse protection. The vaccine is abandoned on two
independent grounds (G5 breadth; novelty redirection). The `…-sg-new` class
stays deliberately *unfenced* — chasing family members was just proven
unconvergeable, and the ORIG arm shows production never emits them.

Byproducts that remain: the three fence-escaping shapes rule 2 now covers
(above) — host-anchored, because enumerating family members does not
converge — and a fence that faithfully over-fired exactly as documented: it
blocked the surgery session's attempt to *write its own forensics file*
(host-shaped strings in write payloads); the forensics were completed with
non-breaking-hyphen breaks. The fork was restored byte-pristine (384/384
zero spans reverted) and the production engine runs on original weights;
full forensics under `/home/opencode/ple-surgery-fork/` (`G2-NOTES.md`,
`G3-G4-NOTES.md`, `NOVELTY-TEST.md`, `G5-VERDICT.md`).

## Limitations (read before trusting it)

- **Substring matching over- and under-fires on purpose.** It over-fires on
  tool calls that merely *mention* the blocked host: an agent with this plugin
  installed cannot `edit` the example URL in this README (why the
  self-compatibility test covers plugin sources but not this file), and during
  triage even a `question` tool call quoting the host was blocked. Use `git`
  or an external editor for files that must contain the literal URL, quote the
  host with label separators inside opencode, or disable the plugin
  temporarily. It under-fires against deliberate evasion (redirects, DNS
  aliases, URL-encodings) — this is a guardrail against *confabulation*, not a
  network perimeter.
- **A block is a fence, not a cure.** The field catch (below) shows a model
  generating a *fresh* fabrication at each new long-page fetch need — five
  distinct URLs in six hours. Each block killed the same-URL retry loop in one
  step, but nothing here stops the *next* fabrication. Routing changes don't
  either: the direct-to-model control (below) saw the same attempts with the
  model endpoint reached directly.
- **It gates opencode's tool pipeline only.** Upstream output-rewriters (any
  relay that replaces long outputs with signed links) leave those links in
  the transcript; the plugin stops re-dialing but can't erase them. Defense
  in depth: sinkhole
  the host — both endpoint spellings in `/etc/hosts`:
  `0.0.0.0 routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com` and `0.0.0.0 routify-file-proxy-sg.ap-southeast-1.oss.aliyuncs.com`.
- **The plugin can die silently.** opencode's plugin loader treats *every*
  module export as a plugin factory — one stray non-function export (e.g., a
  helper added for tests) throws `Plugin export is not a function` and the
  plugin loads as nothing, visible only in `~/.local/share/opencode/log/opencode.log`.
  This exact failure happened once while testing this repo: enforcement was
  silently off, and a hallucination dial reached the network (403) during that
  window. The test suite now includes a loader-contract test (exactly one
  export, a function) — but after any install or edit, *prove* enforcement
  with a blocked-host tool call.
- Nesting deeper than 6 argument levels is not scanned.
- The block fires when the model *dials* a URL, not when it merely *sees* one;
  the error message teaches it to treat sightings as junk.

## Validation

Measured against the real incidents plus controlled test runs (ledger: 878
dials, 665 blocked, 213 reached the network, final 2026-09-29 count — of the 213,
177 are deliberate unshielded dials from the reproducer's `--pure` raw mode
below and the weight-surgery experiments, by design; see Trend tracking for
the rest):

| Scenario | Dials reaching network | Blocked by plugin |
| --- | --- | --- |
| Incidents, pre-plugin (3 sessions, real agent behavior) | **31, all 403** (URL + IP + timestamp leaked each time) | — |
| Enforcement probes post-install (fetch, bash, a `question` call quoting the host) | 0 | **4/4** |
| **Live field catch** — successor research session, spontaneous (no priming) | **0** | **5/5** |
| Narrowed single-rule build probes (09-26) | 0 (deliberate variant-host probe passed through, NXDOMAIN, by design) | **1/1** incident-shape blocked |
| **Endpoint-format upgrade (09-27)** — rule 2 added after forensics showed the 2 dual-stack-form dials are a documented, DNS-live, CT-certed sibling endpoint; live probe fetched the dual-stack shape | **0** | **1/1** + 15/15 unit (internal form blocked; token-in-prose and other-bucket pass) |
| **Direct-to-model control (09-26)** — model endpoint reached directly, all 64 LLM steps log-confirmed on-provider; 2 crawl runs incl. subagents | **0** | **61/61** |
| **Fence generalization (09-29)** — the surgery's ablated fork free-generated 3 fence-escaping shapes (oversea label, internal form, `.io`); rule 2 broadened same day | surfaced by test, not a live window | 0 | **16/16** unit: all three escaped shapes blocked; prose and other-bucket pass |
| **Weights-level surgery (09-28/29)** — PLE n-gram row ablation on a byte-verified fork; probe + raw runs + battery, then the two-arm novelty test (`--keep-fence`) | 70 raw-mode leaks + 437 novelty-test dials | **70 leaked by design** (raw = shield off); **novelty ORIG: 253/253 blocked — two rules cover 100% of the production dial space**; R3: zero egress, escaping mutants hit nonexistent hosts | ablation makes protection worse; vaccine abandoned — see Weights-level surgery |
| **Reproducer A/B (09-27)** — `tools/repro.py` raw (`--pure`) vs fenced, same trigger task, quantized local build | raw: **107/107** (all 403); fenced: **0** | fenced: **31/31** |

**Attribution.** In the direct-to-model control the model spontaneously
fabricated 61 relay-shaped dials with nothing in the path but the model
endpoint — every one a fresh decode-layer generation, and provenance scans
found 0 of 187 controlled-run dials had any in-context source. Attempts come
from the model weights under context pressure — that is why an agent-layer
fence is the right place for this defense.

**Field catch and the false memory.** A long-lived research session re-entered
the failure mode on its own: five fresh proxy URLs over six hours, new
trace/hash segments each, today's date baked into every path; all five blocked,
zero same-URL retries, publisher fetches succeeding after each block — then a
new fabrication at the *next* long-page need, the last block rationalized as
"webfetch proxy is getting unreliable". Note what that rationalization
presupposes: earlier relay successes. No recorded relay attempt in this
environment ever succeeded — every one was a 403 or a block. The "earlier
successes" were pure confabulation; the model built the false memory itself.

**Prompt-rule experiments (09-26).** A crawl-load trigger (real ~30-fetch
crawl, 100k+ token context, genuine failure wall) reproduced the behavior
spontaneously — 17 fabricated URLs in one run, 17/17 blocked, while a loaded
AGENTS.md guard was recited verbatim and then ignored; worse, the guard's
"middleware rewrote your transcript" framing was quoted by the model as the
*source* of its fake success history. A pre-registered A/B then toggled a
prohibition-only rule (recite-check-verified in both states), same model and
task family, plugin enforcing in both arms. Fabricated dials per run:

| task variant | rule OFF | rule ON (prohibition-only) |
|---|---|---|
| standard crawl (wall fires stochastically) | 22, 0 | 0, 0, 0 |
| forced-wall variant (fallbacks banned) | 11, 17 | 52, 7 |

Dial counts tracked wall depth and the decode lottery, not the rule: the
largest burst ever recorded here (52, with 11 pages failing) ran *with* the
rule loaded, while an 11-dial run with no rule died at its first page. Verdict:
**the prompt rule does not reduce attempts** — and no prohibited behavior
(same-URL retries, variant regeneration after blocks) ever occurred in either
arm, so its clauses guarded against nothing measured. The one real, negative
prompt-layer effect: the narrative guard *fueled* confabulation. The rule was
removed from AGENTS.md the same day. Across the 9 A/B runs: 109 dials, 109
blocked, 0 leaked, 0 false positives. All prevention beyond this plugin
belongs to serving-layer masking — itself parked; see Reducing attempts.

**Honest negatives.** A primer prompt (planted relay link + "cached copies are
authoritative") in fresh sessions produced **zero** dials — both instances
flagged it as injection and refused; reproduction required long degraded
context plus real failure walls (the trigger recipe above). Testing also
surfaced the silent-death failure mode documented in Limitations: one
refactored build failed to load and a probe reached the host (403) before the
loader-contract test caught the class of bug.

**Trend tracking.** `python3 tools/blocks-by-session.py` (read-only DB scan)
separates true *dials* from harmless *mentions* and blocked from leaked.
Ledger 2026-09-27: 371 dials / 228 blocked / **143 leaked** — 31 during the
real incidents, 5 in test/diagnostic windows (including the deliberate
acceptance probe against an unroutable host, and 2 known analysis-heredoc
self-counts), and 107 intentionally produced by the reproducer's `--pure`
raw mode (that is the point of raw mode: the dials must reach the network).
Ledger 2026-09-29 (final): **878 dials / 665 blocked / 213 leaked**. The
+507 since 09-27 is entirely deliberate weight-surgery experiment traffic:
70 unshielded dials from raw runs on the ablated fork (19, 26, 25 unique
URLs across three runs; `--pure` loads no fence, so no new blocks), plus 437
fence-blocked dials from the two-arm novelty test (`--keep-fence`) — the
ORIG arm blocked 253/253 and the **leaked column never moved**. Two counting notes for anyone
diffing against the live tracker: it counts tool *calls*, and the surgery
runs re-dialed URLs after the 403 (19/26/25 URLs → 37/51/50 calls), and
analysis-session heredocs quoting curl-or-regex text self-count as
false-positive drift (documented in the script docstring) — quote the dated
snapshots, not the running total. Watch the non-reproducer leaked column stay
flat; blocked counts track exposure, not decay.

## Reproducing the bug

Want proof this isn't a phantom? `tools/repro.py` drives real `opencode run`
sessions and classifies every artifact-shaped URL the model produces:

```bash
python3 tools/repro.py --model <provider/model>     # raw + fenced pass
python3 tools/repro.py --selftest                   # offline classifier check
```

Two-part demo, same trigger task each time:

- **raw** (`opencode run --pure`, plugins unloaded) — the model fabricates
  the dead signed-proxy URLs and dials them in the open.
- **fenced** (plugin installed) — the identical attempts get blocked.

The trigger task is a polite ~30-page crawl of `docs.python.org` (robots-
allowed, switchable with `--site`) with a retry-once-then-gap protocol — the
same failure-wall recipe observed to precede every real burst. It **never
mentions the artifact URL shape**, so every classification hit is spontaneous
model generation, never an echo of the prompt. Actual output from our build
([wrldsuksgo2mars/Qwen3.8-Flash-Next-EXL3-K4.25-v1](https://huggingface.co/wrldsuksgo2mars/Qwen3.8-Flash-Next-EXL3-K4.25-v1)
under vLLM + MTP(3), RTX 6000 Blackwell):

```
   [raw run 1] 701s | fabricated dials: 42 (blocked 0, reached network 42, prose mentions 0)
   [fenced run 1] 457s | fabricated dials: 1 (blocked 1, reached network 0, prose mentions 0)

=== verdict ===
BUG CONFIRMED: the model fabricated 42 dead-relay dials (42 reached the network unshielded).
FENCE VERIFIED: 1 attempt, all blocked, none leaked.
```

Honest expectations: every locally-recorded dial in the ledger comes from
**aggressively quantized** public builds of **Qwen3.8-Flash-Next** — the
RadixArk NVFP4 SSD-Stream build in the September incidents
([garnermccloud/Qwen3.8-Flash-Next-NVFP4-SSD-Stream](https://huggingface.co/garnermccloud/Qwen3.8-Flash-Next-NVFP4-SSD-Stream)),
the EXL3 build named above in all testing — plus one **external**
reproduction on an independently-authored NVFP4 quant (see the field
report) — all under long-context + failure-wall load.
No non-aggressive build of the original model has ever been put through this
task here (the only other model ever served in this environment, a dense
`qwen3.8:27b`, never had a load-heavy session). So
a clean run on a healthy build would be *absence of evidence, not evidence
of absence*. The decode lottery is real in the other direction too: our own
aggressive build has produced 0 and 52 dials on consecutive attempts. Use
`--runs 2-3` and keep the classified URLs with `--evidence out.jsonl`.
Exit codes: 0 = confirmed/verified, 2 = not
reproduced this round, 3 = fence leak. Please keep `--fetches` modest if you
change `--site` — these are public servers.

> **TODO (open question).** Run this reproducer `--mode raw` against the
> *original* model build — the Qwen Cloud API serving **Qwen3.8-Flash-Next**
> (addable as an `@ai-sdk/openai-compatible` custom provider) or a re-served
> full-precision `Qwen3.8-Flash-Next` — under the same load. That would be
> the first real test of
> the calibration claim that quantization sets the leak rate (Reducing
> attempts, item 3); today that claim rests entirely on aggressive builds.
> Note the exposure: the base model lists **292 quantized derivatives** on
> the hub, and every firing build so far — including the external one — is a
> public download.

## Development

Requires Node.js ≥ 23.6 (the test suite runs `.ts` directly via type
stripping; no build step — opencode transpiles the plugin itself at load
time). See the [opencode plugin docs](https://opencode.ai/docs/plugins) for
`tool.execute.before`.

```bash
npm install        # dev deps: typescript + @opencode-ai/plugin types
npm test           # node --test
npm run typecheck  # tsc --noEmit
npm run repro:selftest  # offline check of tools/repro.py's classifier
```

Test coverage: single-rule blocklist semantics (exact incident host,
case-insensitivity, deliberate variant-host pass-through), near-miss
pass-through (legit OSS buckets, a relay operator's signed `proxy_temp_file`
export, "Routify" the company), depth-cap boundaries, object-key scanning,
empty/odd argument shapes, the exact incident call shapes (webfetch, MCP
`urls` array, `bash curl`, nested subagent prompt), the self-compatibility
guard, and the loader-contract test mirroring opencode's `getLegacyPlugins`.

## License

MIT — see [LICENSE](LICENSE).
