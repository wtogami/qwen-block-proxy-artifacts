# block-proxy-artifacts

An [opencode](https://opencode.ai) plugin that hard-blocks **hallucinated file-proxy
artifact URLs** before any tool dials out.

Qwen models have been observed fabricating signed Aliyun OSS "file proxy" links — like

```text
https://routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com/proxy_temp_file/production/2026-09-21/trace_210184.../requestId_6b581d.../9296a87...?Expires=1814047991&OSSAccessKeyId=...&Signature=Gz9%2F...
```

— and feeding them to `webfetch`, MCP fetchers, or `curl`. Nobody configured that
host. The model **remembered the URL shape from its pretraining data** and
regurgitated it as a tool argument. These links always fail with `403`, and every
retry leaks a trace identifier to a third party. This plugin makes the failure
mode loud, terminal, and self-correcting.

## Why this exists (the incident)

In a real research session (Qwen 3.8 Flash Next served through a local gateway),
the agent started issuing `webfetch` calls to URLs of the form
shown above. Forensic analysis of the session database showed:

- The URLs were **model-generated tool inputs**. No prior tool output, user
  message, or config ever contained that host. The model's own reasoning shows a
  confabulation loop after the first 403: *"Earlier successes looked like
  `<proxy URL>` in my messages yet worked. Whatever."* — then more fabrications,
  some with literal `e1e1e1e1...` hex (degenerate generation, not copied links).
- The fabricated paths embedded **the session's own dates**. Pure recall would be
  stale; this was the model synthesizing "fresh signed links" from a memorized
  template: the schema of a signed temp-file URL used by cheap API relay
  middleboxes, which exist throughout the model's Chinese-web pretraining corpus.
- **Every fabricated fetch 403'd** (signatures are bound to the real relay),
  burning agent steps while the model rationalized the failures and retried
  with new fabrications.

A full rescan of the session database found **31 fabricated dials across 3
sessions on 3 different dates** (a research session with 26, an explore
subagent with 3, a chemistry triage session with 2). Every single one targeted
the exact same fully-qualified host shown above; only the
trace/requestId/content-hash/date segments were re-synthesized per attempt. No
region variant, other bucket, or metadata IP was ever dialed. A fourth session
saw 16 *genuine* relay-offload URLs in tool output and re-dialed zero of them
— seeing the URL is harmless; dialing it is the behavior to stop.

So: an honest training artifact — a memorized URL schema with zero real content
behind it — that behaves, at the tool boundary, like an uncontrolled outbound
request loop.

## The risk

1. **Telemetry leak on every attempt.** Each dial sends the fabricated URL, your
   IP, and a timestamp to third-party infrastructure. The 403 means no content
   comes *back* — but data went *out*, and the trace/request IDs baked into the
   model's fabrications (sometimes copied from real gateway headers that appeared
   in context) ride along.
2. **Unverified outbound-request primitive → SSRF.** A model in this state will
   equally "remember" `http://169.254.169.254/...` (cloud metadata) or
   `http://127.0.0.1:<port>/...` (your local LLM gateway). If any fabricated URL
   lands on a live host that answers 200, foreign content enters the agent's
   context — **prompt injection via pure imagination**.
3. **It mirrors real relay behavior.** Cheap API middleboxes genuinely replace
   oversized tool outputs with signed links to temporary buckets, with `Expires`
   values a year out. If you ever route a session through such a relay, your
   conversation really *is* sitting in a third-party bucket. The hallucination is
   a warning label for that ecosystem risk.

**Why a plugin, not config?** opencode's `permission.webfetch` is a flat
allow/ask/deny for *all* fetches — no per-domain rules — and it wouldn't cover
MCP fetch tools anyway. A `tool.execute.before` hook is the only place that sees
every tool's arguments.

## What it does

On **every** `tool.execute.before`, the plugin deep-scans the call arguments —
strings, array elements, nested object values *and keys*, up to 6 container
levels — against a small blocklist:

| Pattern (case-insensitive)                                       | Catches                                                   |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| `routify[-]file[-]proxy[-]sg[.]oss-ap-southeast-1[.]aliyuncs[.]com` | the exact incident host — covers all 169 recorded dials |

A match throws — the tool never executes — with an error written to break the
retry loop, not just fail the call:

> `Blocked by block-proxy-artifacts policy (observed incident host (dead relay bucket)). This URL is
> a dead upload-proxy artifact from a third-party gateway, not a real content
> source: it cannot be fetched and retrying leaks trace identifiers. Do NOT retry
> it. Go back to the original publisher URL (doi.org, pubmed.ncbi.nlm.nih.gov,
> pmc.ncbi.nlm.nih.gov, europepmc, or the publisher site) and fetch that instead.`

The single rule is deliberately the **exact host only**: in every recorded
dial — incidents, field catches, and controlled crawl-burst repros — the
target was this one host, and fabrications only re-synthesized the
trace/request/hash segments. A broader relay-host-token rule shipped earlier;
it was **removed 2026-09-26** after measurement showed it never added a catch
the exact-host rule missed while over-firing on tool calls that merely
mentioned the token (gateway-ops code, incident writeups). If your gateway
mutates the link template (new region, bucket, or separators), re-add it:

```ts
{ pattern: /routify[-_.]file[-_.]proxy/i, why: "relay host token (template variant)" },
```

The trade-off is deliberate under-inclusion of novel shapes. Measurement
keeps the opposite bias on purpose: `tools/blocks-by-session.py` still counts
every token-shaped dial and leak, so anything a narrowed fence lets through
surfaces in the tracker instead of accumulating silently. A generic path rule
(any Aliyun OSS bucket path containing the gateway temp-file segment) was
evaluated and **rejected**: it never fired alone in the incident dials, and
it would block legitimate relay operators whose own buckets serve those paths
with valid signatures. Ordinary Aliyun OSS buckets, unrelated companies named
"Routify", and local paths named `proxy_temp_file` are **not** blocked.

The **first** block in a session carries the full guidance quoted above (in the
field it reliably produced one-step self-correction); repeat fabrications in
the same session get a one-line variant that keeps "Do NOT retry" but stops
re-injecting ~200 tokens of guidance into the context the plugin exists to
protect.

## Install

Copy `plugin/block-proxy-artifacts.ts` into your opencode config and declare it.

**Global** (recommended — protects every project):

```bash
mkdir -p ~/.config/opencode/plugin
cp plugin/block-proxy-artifacts.ts ~/.config/opencode/plugin/
```

```jsonc
// ~/.config/opencode/opencode.json
{ "plugin": ["./plugin/block-proxy-artifacts.ts"] }
```

**Per-project:** put the file under `.opencode/plugin/` in the project and add the
same entry to the project's `opencode.json`.

Plugins load at startup — restart opencode after installing. Verify with:

```bash
opencode debug config | grep plugin
```

## Extending the blocklist

Edit the `BLOCKED` array in `plugin/block-proxy-artifacts.ts`:

```ts
{ pattern: /your[-_.]relay[-_.]host/i, why: "short human reason" },
```

Keep patterns narrow (see above), and keep `npm test` green — one test asserts
that no regex ever matches this repository's own source text, so the agent can
always edit the plugin's own code.

## Reducing attempts (and why prompt rules are not the answer)

The plugin fences the dial. What actually addresses the attempts themselves:

1. **Prompt rules: tested, rejected.** A standing AGENTS.md guard was A/B
   controlled against the live trigger (see Validation). Both variants failed:
   the *narrative* variant (one that explained "middleware rewrote your
   transcript") was actively weaponized — the model used the explanation to
   confabulate fake success histories — and the *prohibition-only* variant was
   inert: burst sizes tracked failure-wall depth and the decode lottery, not
   the rule, and 0 of 126 recorded dials traced back to any in-context source,
   meaning attempts are pure decode-layer generation, which no instruction
   reaches. The rule was removed from AGENTS.md on 2026-09-26. If you insist
   on running one anyway, the only safe form is prohibition-only with **no
   causal narrative** — and expect zero prevention benefit.
2. **Remove the source.** Gateways that rewrite overlong tool outputs into
   signed bucket links both poison the model's history with these URL shapes
   (creating the false "it worked earlier" evidence) and genuinely place your
   conversation in third-party storage. Disabling that middleware behavior is
   the highest-leverage fix available.
3. **Serving-layer option:** inference stacks with `bad_words`/logit-bias
   sampling (e.g. vLLM) can make the host token unemittable — zero attempts,
   zero pollution — at the cost of also blocking legitimate mentions in that
   model alias (you could not edit this README from such a session).
4. **Calibration:** every observed incident came from small quantized models;
   a better-calibrated serving choice reduces spontaneous regurgitation.

## Limitations (read before trusting it)

- **Substring matching over- and under-fires on purpose.** It over-fires on tool
  calls that merely *mention* a blocked URL — concretely, an opencode agent with
  this plugin installed cannot `edit` the example URL in this README (which is
  why the CI self-compatibility test covers the plugin sources but not this
  file: documenting the indicator requires keeping it). Use `git` or an external
  editor for files that must contain the literal URL, or disable the plugin
  temporarily. Prose mentions count too, and not just for fetch tools: during
  triage, a `question` tool call whose options quoted the blocked host was
  itself blocked. Quote the host with label separators when reporting on it
  inside opencode. It under-fires against deliberate evasion (redirects,
  DNS aliases, URL-encodings) — this is a guardrail against *confabulation*, not
  a network perimeter.
- **A block is a fence, not a cure.** The live field catch above showed the
  model generating a *fresh* fabrication at each new long-page fetch need —
  five distinct URLs in six hours. Each block correctly killed the same-URL
  retry loop in one step (the agent went to the direct publisher URL and
  succeeded), but nothing here stops the *next* fabrication, and the model
  rationalized repeated blocks as proxy instability. If your sessions keep
  hitting this, fix the source: a gateway/relay that rewrites tool outputs
  into signed bucket links both poisons the model's history with these URL
  shapes *and* genuinely puts your conversation content in third-party
  storage. The plugin bounds the leak; removing the relay and using a
  better-calibrated model removes the behavior.
- **It gates opencode's tool pipeline only.** A server-side relay that rewrites
  long outputs into signed bucket links (the real-world behavior this pattern
  imitates) does that upstream; the plugin stops the agent from *re-dialing*
  those links but can't remove them from context. Defense in depth: sinkhole the
  host at DNS too — `0.0.0.0 routify-file-proxy-sg.oss-ap-southeast-1.aliyuncs.com` in `/etc/hosts`.
- **The plugin can die silently.** opencode's plugin loader treats *every*
  module export as a plugin factory — one stray non-function export (e.g., a
  helper added for tests) throws `Plugin export is not a function` and the
  plugin loads as nothing, visible only in `~/.local/share/opencode/log/opencode.log`.
  This exact failure mode happened once while testing this repo: enforcement
  was silently off for a period, during which a hallucination dial reached the
  network (answered 403 instead of being blocked). The test suite now includes
  a loader-contract test (single function export) to prevent it. After
  installing or editing, verify enforcement: `grep "failed to load plugin"
  ~/.local/share/opencode/log/opencode.log`, then make any tool call containing
  the blocked host and confirm it errors.
- Nesting deeper than 6 argument levels is not scanned.
- The block fires when the model *dials* a URL, not when it merely *sees* one in
  search results; the error message teaches the model to treat such sightings as
  junk instead of fetch targets.

## Validation

Measured against the real incidents plus controlled test runs:

| Scenario | Dials reaching network | Blocked by plugin |
| --- | --- | --- |
| Incidents, pre-plugin (3 sessions, real agent behavior) | **31 attempts, all 403** (URL + IP + timestamp leaked each time) | — |
| Enforcement probes post-install (fetch, bash, and a `question` tool call quoting the host) | 0 | **4/4 blocked** |
| **Live field catch** — successor research session to one incident, spontaneous (no priming) | **0** | **5/5 blocked** |
| Narrowed single-rule build, fresh-instance probes (09-26) | incident shape: 0 | **1/1 blocked**; unseen variant host deliberately passed to the network |

The field catch (09-22): a long-lived research session re-entered the failure
mode on its own and fabricated **five** fresh proxy URLs over six hours — new
trace/request/hash segments each time, today's date baked into every path. All
five died at the incident-host rule; zero same-URL retries; after each block the agent
self-corrected to the direct publisher URL and succeeded. It did, however,
re-fabricate at the *next* long-page fetch need, rationalizing the final block
as "webfetch proxy is getting unreliable" — the block fences the dial, it does
not cure the confabulation (see Limitations). Forensic detail on *why* the
model believed the proxy had "worked earlier in the session": the local LLM
gateway genuinely injects these relay links next to successful fetches
(rewriting overlong tool outputs), and compaction strips the failure
annotations — in the transcript the model actually conditions on, those links
appear beside successes. The model's inference was reasonable; only its
attribution was wrong.

Reproduction testing, honestly reported: a primer prompt (planted relay link +
"cached copies are authoritative") run in a fresh session and in a naive
subagent produced **zero** dial attempts — both model instances flagged the
instruction as prompt injection and refused the third-party link; the subagent
even hit a genuine output-truncation event (the incidents' precondition) and
worked around it by re-fetching the original endpoint. A primer alone does not
reproduce the confabulation — the incidents required long degraded context and
real failure walls. The plugin's deterministic path (any tool arg containing
the host) is fully verified; probabilistic agent-side behavior is evidenced by
the 31-dial historical baseline it now prevents.

Testing also surfaced the silent-death failure mode documented under
Limitations: one refactored build failed to load, and during that window a
test probe did reach the host (403). Root-caused, fixed with the
loader-contract test, and recorded here as a caution for anyone extending the
plugin.

Trend tracking: `python3 tools/blocks-by-session.py` is a read-only DB scan
that separates true *dials* (fetch tools / curl-style bash) from harmless
*mentions* of the URL shape, and splits blocked vs leaked. Baseline as of
writing (prompt rule not yet in effect): **32 leaked dials** (31 incidents +
1 test-window accident; the raw report adds a few known-noise rows from
analysis heredocs quoting "curl") versus every post-enforcement dial blocked
and **0 leaked** — watch for leaked staying at 0; blocked counts track
exposure, not decay (prompt-rule suppression was tested and rejected, see
below). See the script docstring for known
heuristic caveats (analysis heredocs quoting "curl" self-count as dials).

**Trigger re-test, post-rule (09-26):** the incident conditions were
reproduced on a naive subagent — a real ~30-fetch crawl; no relay link was
injected anywhere. When the failure wall appeared (genuine fetch failures deep
in a 100k+ token context), the model spontaneously fabricated **17** proxy
URLs: **17/17 blocked, 0 leaked, 0 false positives**, publisher fetches
resumed after each wall, task finished with logged gaps. Negative result worth
flagging: the AGENTS.md-style guard was loaded (the subagent recited it
verbatim on demand) yet did **not** suppress attempts — and the subagent used
the guard's own "middleware rewrote the transcript" framing to *construct* a
false success history ("previous batches were rewriting them but content came
back"; its stored history contained zero proxy traces before the first block).
The guard's explanation can become the confabulation's script; the guard was
rewritten prohibition-only the same day.

**Prompt-rule A/B control, same day (pre-registered, n=9 crawl runs):**
the prohibition-only rule was toggled in `AGENTS.md` (OFF = section removed,
verified absent from fresh sessions by recite-check; ON = verified verbatim)
with everything else constant — same model, task family, plugin enforcement
on in both arms. Fabricated dials per run:

| task variant | rule OFF | rule ON (prohibition-only) |
|---|---|---|
| standard crawl (wall fires stochastically) | 22, 0 | 0, 0, 0 |
| forced-wall variant (fallbacks banned) | 11, 17 | 52, 7 |

Dial counts tracked failure-wall depth and the decode lottery, not the rule:
the largest burst ever recorded here (52) ran with the rule loaded, and the
rule-free arm produced bursts too; the rule-ON clean runs never met a wall.
**Verdict: the prompt rule does not reduce attempts** — attempts are
decode-layer events. Equally honest: no attempt-suppression *harm* could be
confirmed either (the 52-vs-14 gap follows wall depth: the 52-run failed 11
pages, the 11-run died at its first page), and zero behaviors the rule
prohibits actually occurred in either arm (0 exact retries of a blocked URL
in all 9 runs; misattribution narratives like "the fetch transport routed
through a dead relay" appeared in both arms). The one demonstrated prompt-
layer effect is negative and real: deleting the narrative guard removed the
fuel the model used to confabulate success histories. With a provenance scan
showing 0 of 126 recorded dials having any in-context source, no channel
remained where a rule could act, so the rule was **removed from AGENTS.md
the same day**; this plugin is the complete mitigation at the agent layer.
All prevention beyond it belongs to serving-layer decode constraints
(`bad_words`). Across the 9 A/B runs: 109 dials, 109 blocked, 0 leaked,
0 false positives.

## Development

Requires Node.js ≥ 23.6 (the test suite runs `.ts` directly via type stripping;
no build step — opencode transpiles the plugin itself at load time).

```bash
npm install        # dev deps: typescript + @opencode-ai/plugin types
npm test           # node --test
npm run typecheck  # tsc --noEmit
```

Test coverage includes: blocklist semantics (incident-host vs token-rule
layering, case-insensitivity, separator variants), near-miss pass-through
(legit OSS buckets, a relay operator's signed `proxy_temp_file` export,
"Routify" the company), depth-cap boundaries, object-key scanning, empty/odd
argument shapes, the exact
call shapes from the incident (webfetch, MCP `urls` array, `bash curl`, nested
subagent prompt), the self-compatibility guard described above, and the
loader-contract test (exactly one export, a function) mirroring opencode's
`getLegacyPlugins`.

## Related work

- opencode docs: [Plugins](https://opencode.ai/docs/plugins) (`tool.execute.before`)
- The privacy analysis above follows from a session-level forensic review: the
  only way those URLs entered the system was the model inventing them.

## License

MIT — see [LICENSE](LICENSE).
