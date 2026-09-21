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
| `routify[-]file[-]proxy[-]sg[.]oss-ap-southeast-1[.]aliyuncs[.]com` | the exact incident host — covers all 31 observed dials  |
| `routify[-_.]file[-_.]proxy`                                     | relay host token — template-drift insurance               |

A match throws — the tool never executes — with an error written to break the
retry loop, not just fail the call:

> `Blocked by block-proxy-artifacts policy (observed incident host (dead relay bucket)). This URL is
> a dead upload-proxy artifact from a third-party gateway, not a real content
> source: it cannot be fetched and retrying leaks trace identifiers. Do NOT retry
> it. Go back to the original publisher URL (doi.org, pubmed.ncbi.nlm.nih.gov,
> pmc.ncbi.nlm.nih.gov, europepmc, or the publisher site) and fetch that instead.`

Both rules key on the relay host token; the exact incident host is listed first
so its block reason is precise, while the broader token rule absorbs template
drift (other regions, buckets, separators). A generic path rule (any Aliyun OSS
bucket path containing the gateway temp-file segment) was evaluated and
**dropped**: it never fired alone in the 31 observed dials, and it would block
legitimate relay operators whose own buckets serve those paths with valid
signatures. Ordinary Aliyun OSS buckets, unrelated companies named "Routify",
and local paths named `proxy_temp_file` are **not** blocked.

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
| Agents in protected sessions since enforcement confirmed | **0 attempts** | n/a (nothing attempted) |

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
