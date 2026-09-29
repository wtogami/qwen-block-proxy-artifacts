import type { Plugin } from "@opencode-ai/plugin"

// Hallucinated file-proxy artifact URLs. Small quantized Qwen models
// regurgitate signed Aliyun OSS "file proxy" links from their pretraining
// data. 371 recorded dials (as of 2026-09-27) hit one relay bucket label,
// `routify-file-proxy-sg`, in Aliyun OSS's two DOCUMENTED endpoint formats
// (public `<bucket>.oss-<region>.aliyuncs.com`, dual-stack
// `<bucket>.<region>.oss.aliyuncs.com`), re-synthesizing only the
// trace/request/date segments each time.
// The 2026-09-28/29 PLE n-gram row-ablation experiment (SURGERY.md; README
// "Weights-level surgery") proved this is a TEMPLATE FAMILY, not one
// memorized host: after the table rows carrying the canonical template were
// zeroed, unshielded runs dialed 70 new URLs at never-before-observed
// members — the `oversea` label (no "proxy" segment at all), the
// `oss-accelerate`/`oss-cn-beijing`/`oss-acdr-ut-1` endpoint forms, and an
// `aliyuncs.io` TLD variant. The family library lives in the LM weights,
// so rule 2 must NOT require a "proxy" segment and must include Aliyun's
// second TLD. Rule 1 still pins the exact incident host for provenance.
// Every span must be host-shaped ([\w.-]) with bounded gaps and must end in
// an aliyuncs TLD, so code or prose that merely mentions the token passes
// through.
//
// Retired rules: a generic aliyuncs path rule (would block legitimate relay
// operators' own proxy_temp_file objects, which can validly return 200) and
// a bare relay-host-token rule (over-fires on relay-ops code and incident
// writeups, and blocks self-documentation; since rule 2 widened to
// proxy-less labels its only unique catches are separator-mutated labels
// missing the `file` segment — re-add a suitably-shaped token rule if ever
// observed). Measurement deliberately stays broad:
// tools/blocks-by-session.py still counts token-shaped mentions and leaks,
// so any novel shape this fence lets through surfaces in the tracker.
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
  { pattern: /routify[\w.-]{0,12}file[\w.-]{0,56}aliyuncs[.](com|io)/i, why: "relay bucket label (any routify-file-* form) on an Aliyun OSS endpoint, com or io TLD" },
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
  `This URL is a dead upload-proxy artifact from a third-party relay middlebox, not a real ` +
  `content source: it cannot be fetched and retrying leaks trace identifiers. ` +
  `Do NOT retry it. Go back to the original publisher URL and fetch that instead.`

// Repeat occurrences in the same session get a one-liner: the full guidance is
// what drove good self-corrections in the field, but re-injecting ~200 tokens
// per recurrence pollutes the context it is trying to protect.
const TERSE_GUIDANCE =
  `Dead upload-proxy artifact from a third-party relay middlebox. Do NOT retry it. ` +
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
