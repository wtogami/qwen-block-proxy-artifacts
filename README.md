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

## Why this exists (the incident)

In a real research session (Qwen 3.8 Flash Next served through a local
gateway), the agent started issuing `webfetch` calls to URLs of that form.
Forensics of the session database showed:

- The URLs were **model-generated tool inputs**. No stored tool output, user
  message, or config contained that host. (The model's *view* of its context
  can differ from stored transcripts — the gateway's output-rewriting
  middleware is analyzed under Validation; in some sessions it really did
  place genuine relay links in context.)
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
   fabrications (sometimes copied from real gateway headers that appeared in
   context).
2. **Unverified outbound-request primitive → SSRF.** A model in this state
   will equally "remember" `http://169.254.169.254/...` (cloud metadata) or
   `http://127.0.0.1:<port>/...` (your local gateway). One fabricated URL that
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
| `routify[-]file[-]proxy[-]sg[.]oss-ap-southeast-1[.]aliyuncs[.]com` | the exact incident host — matched by all 232 recorded dials (as of 2026-09-26) |

A match throws — the tool never executes — with an error written to break the
retry loop, not just fail the call:

> `Blocked by block-proxy-artifacts policy (observed incident host (dead relay bucket)). This URL is
> a dead upload-proxy artifact from a third-party gateway, not a real content
> source: it cannot be fetched and retrying leaks trace identifiers. Do NOT retry
> it. Go back to the original publisher URL (doi.org, pubmed.ncbi.nlm.nih.gov,
> pmc.ncbi.nlm.nih.gov, europepmc, or the publisher site) and fetch that instead.`

The **first** block per session carries that full guidance (in the field it
reliably produced one-step self-correction); repeats get a one-liner that keeps
"Do NOT retry" without re-injecting ~200 tokens into the very context the
plugin protects.

**Why the exact host only.** Every recorded dial — incidents, field catches,
controlled crawl-burst repros — targeted this one host, re-synthesizing only
the trace/request/hash segments. A broader relay-host-token rule shipped
earlier and was **removed 2026-09-26**: it never caught anything the exact-host
rule missed, while over-firing on tool calls that merely mentioned the token
(gateway-ops code, incident writeups). If your gateway mutates the template
(new region, bucket, separators), re-add it in the `BLOCKED` array of
`plugin/block-proxy-artifacts.ts`:

```ts
{ pattern: /routify[-_.]file[-_.]proxy/i, why: "relay host token (template variant)" },
```

The trade-off is deliberate under-inclusion of novel shapes — with the opposite
bias on the measurement side: `tools/blocks-by-session.py` still counts every
token-shaped dial and leak, so anything the narrowed fence lets through
surfaces in the tracker instead of accumulating silently. A generic path rule
(any Aliyun OSS bucket path containing the gateway temp-file segment) was
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
tested:

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
3. **Calibration: rate, not cause.** Every incident and repro came from an
   aggressively quantized build of one model family (nvfp4 on sglang;
   EXL3 K4.25 on vLLM). Surviving two unrelated quantizers and engines means
   the memorized template is weights-level — quantization sets the leak rate
   and rigidity. Higher precision should **reduce but not eliminate**
   spontaneous regurgitation (untested on the full-precision original).

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
  either: the gateway-bypass control (below) saw the same attempts with no
  gateway in the path. Relay hygiene remains worth doing — a gateway that
  rewrites tool outputs into signed bucket links puts your conversation in
  third-party storage — but that is the privacy concern in The risk, not a
  cause of the attempts.
- **It gates opencode's tool pipeline only.** A server-side relay rewriting
  long outputs into signed links does that upstream; the plugin stops
  re-dialing but can't remove links from context. Defense in depth: sinkhole
  the host — `0.0.0.0 routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com` in `/etc/hosts`.
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

Measured against the real incidents plus controlled test runs (ledger: 232
dials, 196 blocked, 36 reached the network, as of 2026-09-26):

| Scenario | Dials reaching network | Blocked by plugin |
| --- | --- | --- |
| Incidents, pre-plugin (3 sessions, real agent behavior) | **31, all 403** (URL + IP + timestamp leaked each time) | — |
| Enforcement probes post-install (fetch, bash, a `question` call quoting the host) | 0 | **4/4** |
| **Live field catch** — successor research session, spontaneous (no priming) | **0** | **5/5** |
| Narrowed single-rule build probes (09-26) | 0 (deliberate variant-host probe passed through, NXDOMAIN, by design) | **1/1** incident-shape blocked |
| **Gateway-bypass control (09-26)** — opencode straight to vLLM, LiteLLM off the path (all 64 LLM steps log-confirmed `provider=vllm`); 2 crawl runs incl. subagents | **0** | **61/61** |

**Attribution.** In the bypass control the model spontaneously fabricated 61
relay-shaped dials with no gateway anywhere near the traffic — every one a
fresh decode-layer generation, zero proxy-shaped traces in any session's
stored history before the first dial. Attempts come from the model weights
under context pressure, not from any proxy or middleware. That, plus the
0-of-187 provenance scans, is why an agent-layer fence is the right place for
this defense.

**Field catch and the false memory.** A long-lived research session re-entered
the failure mode on its own: five fresh proxy URLs over six hours, new
trace/hash segments each, today's date baked into every path; all five blocked,
zero same-URL retries, publisher fetches succeeding after each block — then a
new fabrication at the *next* long-page need, the last block rationalized as
"webfetch proxy is getting unreliable". Forensics on *why* such models believe
the relay "worked earlier": the local gateway really does inject relay links
next to successful fetches when rewriting overlong outputs, and compaction
strips the failure annotations — in the transcript the model conditions on,
the links sit beside successes. The model's inference was reasonable; its
attribution was wrong.

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
Ledger 2026-09-26: 232 dials / 196 blocked / **36 leaked** — 31 during the real
incidents, 5 in test/diagnostic windows (including one deliberate acceptance
probe against an unroutable host). Watch the leaked column stay flat; blocked
counts track exposure, not decay. The script docstring lists heuristic caveats
(analysis heredocs quoting "curl" can self-count as dials).

## Development

Requires Node.js ≥ 23.6 (the test suite runs `.ts` directly via type
stripping; no build step — opencode transpiles the plugin itself at load
time). See the [opencode plugin docs](https://opencode.ai/docs/plugins) for
`tool.execute.before`.

```bash
npm install        # dev deps: typescript + @opencode-ai/plugin types
npm test           # node --test
npm run typecheck  # tsc --noEmit
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
