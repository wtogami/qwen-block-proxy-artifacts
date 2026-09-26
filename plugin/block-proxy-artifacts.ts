import type { Plugin } from "@opencode-ai/plugin"

// Hallucinated file-proxy artifact URLs. Small quantized Qwen models
// regurgitate signed Aliyun OSS "file proxy" links from their pretraining
// data. Local forensics across every recorded session — 169 dialed attempts
// (real incidents, field catches, controlled crawl-burst repros): every one
// targeted the exact incident host below; only trace/request/hash/date
// segments were re-synthesized each time. The blocklist is therefore that
// host alone.
//
// Two broader rules were evaluated and retired: a generic aliyuncs path rule
// (never fired alone; it would block legitimate relay operators' own
// proxy_temp_file objects, which can validly return 200) and a bare
// relay-host-token rule (caught nothing the exact-host rule missed while
// every observed dial already contained the full host; it would over-fire on
// tool calls touching gateway-ops code that legitimately mentions the token).
// If a gateway ever mutates the link template (new region/bucket/host),
// widen by re-adding:
//   { pattern: /routify[-_.]file[-_.]proxy/i, why: "relay host token" }
// Measurement deliberately stays broad: tools/blocks-by-session.py still
// counts token-shaped mentions and leaks, so any novel shape this narrowed
// fence lets through surfaces in the tracker.
//
// Self-compatibility note: the regex sources below are deliberately written
// with character classes so that this file's own text does not match the
// blocklist. Without that, an agent with this plugin installed could not
// even edit or grep this file. A test enforces the property.
//
// Loader-contract note: opencode treats EVERY module export as a plugin
// factory (getLegacyPlugins in packages/opencode/src/plugin/index.ts throws
// "Plugin export is not a function" for anything else, and the whole plugin
// then loads as nothing — enforcement silently off, error only in the log).
// So internals are attached to the single default export, never re-exported.
// A test enforces that contract too.

const BLOCKED: { pattern: RegExp; why: string }[] = [
  { pattern: /routify[-]file[-]proxy[-]sg[.]oss-ap-southeast-1[.]aliyuncs[.]com/i, why: "observed incident host (dead relay bucket)" },
]

function* strings(v: unknown, depth = 0): Generator<string> {
  if (depth > 6) return
  if (typeof v === "string") yield v
  else if (Array.isArray(v)) for (const x of v) yield* strings(x, depth + 1)
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      yield k
      yield* strings(x, depth + 1)
    }
}

function findBlocked(args: unknown): { pattern: RegExp; why: string } | null {
  for (const s of strings(args))
    for (const b of BLOCKED) if (b.pattern.test(s)) return b
  return null
}

const FULL_GUIDANCE =
  `This URL is a dead upload-proxy artifact from a third-party gateway, not a real ` +
  `content source: it cannot be fetched and retrying leaks trace identifiers. ` +
  `Do NOT retry it. Go back to the original publisher URL (doi.org, pubmed.ncbi.nlm.nih.gov, ` +
  `pmc.ncbi.nlm.nih.gov, europepmc, or the publisher site) and fetch that instead.`

// Repeat occurrences in the same session get a one-liner: the full guidance is
// what drove good self-corrections in the field, but re-injecting ~200 tokens
// per recurrence pollutes the context it is trying to protect.
const TERSE_GUIDANCE =
  `Dead upload-proxy artifact from a third-party gateway. Do NOT retry it. ` +
  `Fetch the original publisher URL directly.`

// Server-process-scale cap; clearing wholesale is fine at this size.
const WARNED_CAP = 500

const blockProxy = Object.assign(
  (async () => {
    const warned = new Map<string, boolean>()
    return {
      "tool.execute.before": async (input, output) => {
        const hit = findBlocked(output.args)
        if (!hit) return
        const session = input.sessionID ?? "unknown"
        const first = !warned.has(session)
        if (warned.size > WARNED_CAP) warned.clear()
        warned.set(session, true)
        throw new Error(
          `Blocked by block-proxy-artifacts policy (${hit.why}). ` +
          (first ? FULL_GUIDANCE : TERSE_GUIDANCE),
        )
      },
    }
  }) satisfies Plugin,
  // Introspection surface for tests and other plugins; attached to the
  // default export so the module itself has exactly one export.
  { BLOCKED, strings, findBlocked },
)

export default blockProxy
