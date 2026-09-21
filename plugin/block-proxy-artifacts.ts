import type { Plugin } from "@opencode-ai/plugin"

// Hallucinated file-proxy artifact URLs. Small quantized Qwen models
// regurgitate signed Aliyun OSS "file proxy" links from their pretraining
// data. Local forensics across every recorded session: 31 dialed attempts in
// 3 sessions on 3 different dates, every one targeting the exact incident
// host below (only trace/request/hash/date segments were re-synthesized each
// time). Rule 1 blocks that host exactly; rule 2 keeps the host token as
// insurance against template drift (region/bucket mutations). A generic
// aliyuncs path rule was evaluated and dropped: it never fired alone in any
// incident, and it would block legitimate relay operators' own
// proxy_temp_file objects, which can validly return 200.
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
  { pattern: /routify[-_.]file[-_.]proxy/i, why: "relay host token (template variant of observed incident host)" },
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

const blockProxy = Object.assign(
  (async () => {
    return {
      "tool.execute.before": async (_input, output) => {
        const hit = findBlocked(output.args)
        if (hit) {
          throw new Error(
            `Blocked by block-proxy-artifacts policy (${hit.why}). ` +
            `This URL is a dead upload-proxy artifact from a third-party gateway, not a real ` +
            `content source: it cannot be fetched and retrying leaks trace identifiers. ` +
            `Do NOT retry it. Go back to the original publisher URL (doi.org, pubmed.ncbi.nlm.nih.gov, ` +
            `pmc.ncbi.nlm.nih.gov, europepmc, or the publisher site) and fetch that instead.`,
          )
        }
      },
    }
  }) satisfies Plugin,
  // Introspection surface for tests and other plugins; attached to the
  // default export so the module itself has exactly one export.
  { BLOCKED, strings, findBlocked },
)

export default blockProxy
