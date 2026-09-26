import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import blockProxy from "../plugin/block-proxy-artifacts.ts"

const { BLOCKED, strings, findBlocked } = blockProxy

// Dead-proxy URL fixture reconstructed from a real hallucinated call. It is
// assembled from fragments so this source file never contains a contiguous
// blocklisted token — otherwise the live plugin would block any agent that
// tries to edit this very test, and GitHub secret scanners would flag the
// OSSAccessKeyId-shaped parameter.
const DEAD_URL = [
  "https://routify",
  "-file",
  "-proxy-sg.oss-ap-southeast-1",
  ".aliyuncs.com/",
  "proxy_",
  "temp_file/production/2026-09-21/trace_2101843517899439873655976e0e98/",
  "requestId_6b581d20398a4d18b56e18d56518c18a/9296a8761c29666465047035c00e57da",
  "?Expires=1814047991&OSSAccessKeyId=REPLACEDPLACEHOLDER&Signature=Gz9%2F3jH",
].join("")

const CLEAN_URLS = [
  "https://pmc.ncbi.nlm.nih.gov/articles/PMC5795620/",
  "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID:28759224",
  "https://www.targetmol.com/attachment/DataSheet/1B25D990/T11717",
]

type BeforeHook = (input: unknown, output: { args: unknown }) => Promise<void>

async function beforeHook(): Promise<BeforeHook> {
  const factory = blockProxy as unknown as () => Promise<Record<string, BeforeHook>>
  const hooks = await factory()
  const hook = hooks["tool.execute.before"]
  assert.ok(hook, "plugin must register tool.execute.before")
  return hook
}

function nest(depth: number, leaf: unknown): unknown {
  let v = leaf
  for (let i = 0; i < depth; i++) v = [v]
  return v
}

test("fixtures: single exact-host rule blocks the dead URL", () => {
  assert.equal(BLOCKED.length, 1)
  assert.ok(BLOCKED.every((b) => b.why.length > 0))
  const hit = findBlocked(DEAD_URL)
  assert.ok(hit)
  assert.equal(hit.why, "observed incident host (dead relay bucket)")
})

test("strings(): primitives", () => {
  assert.deepEqual([...strings("hello")], ["hello"])
  for (const junk of [42, null, undefined, true, Symbol("s"), () => 0]) {
    assert.deepEqual([...strings(junk)], [])
  }
})

test("strings(): arrays, object values, and object keys", () => {
  const found = new Set(strings({ a: ["x"], b: { c: "y" }, n: null }))
  assert.deepEqual([...found].sort(), ["a", "b", "c", "n", "x", "y"].sort())
})

test("strings(): depth cap is 6 container levels", () => {
  assert.ok([...strings(nest(6, "leaf"))].includes("leaf"))
  assert.ok(![...strings(nest(7, "leaf"))].includes("leaf"))
})

test("findBlocked(): exact-host rule, case-insensitive; variants pass by design", () => {
  const INCIDENT = "observed incident host (dead relay bucket)"
  assert.equal(findBlocked(DEAD_URL)?.why, INCIDENT)
  assert.equal(findBlocked(DEAD_URL.toUpperCase())?.why, INCIDENT)

  // Deliberate under-inclusion: across 169 recorded dials every attempt hit
  // the exact incident host, so the former relay-host-token rule (which also
  // caught separator/region variants) was retired — it added no unique catch
  // and would over-fire on gateway-ops text mentioning the token. If template
  // drift is ever observed, re-add the token rule (plugin header explains
  // how); until then, unseen variant hosts must pass through cleanly.
  const underscoreHost = [
    "https://routify",
    "_file",
    "_proxy-sg.example.org/download",
  ].join("")
  const otherRegion = [
    "https://routify",
    "-file",
    "-proxy-hz.example.net/download",
  ].join("")
  assert.equal(findBlocked(underscoreHost), null)
  assert.equal(findBlocked(otherRegion), null)
})

test("findBlocked(): passes legitimate and near-miss input", () => {
  for (const url of CLEAN_URLS) assert.equal(findBlocked({ url }), null)
  assert.equal(findBlocked("routify is also a logistics company"), null)
  assert.equal(findBlocked({ path: "/var/tmp/proxy_temp_file/report.csv" }), null)
  assert.equal(
    findBlocked("https://my-backup.oss-cn-hangzhou.aliyuncs.com/dump.tar.gz"),
    null,
  )
  assert.equal(findBlocked("ROUTIFY REPORT 2026 file proxy"), null)

  // Regression for the dropped path rule: a legitimate relay operator's own
  // bucket may host signed temp-file exports under the same path scheme,
  // and those can validly return 200.
  const legitRelayExport = [
    "https://my-relay.oss-cn-hangzhou",
    ".aliyuncs.com/",
    "proxy_",
    "temp_file/signed-export?sig=valid",
  ].join("")
  assert.equal(findBlocked(legitRelayExport), null)
})

test("findBlocked(): scans object keys, not just values", () => {
  assert.ok(findBlocked({ [DEAD_URL]: "metadata" }))
})

test("findBlocked(): nested args respect the depth cap", () => {
  assert.ok(findBlocked(nest(6, DEAD_URL)))
  assert.equal(findBlocked(nest(7, DEAD_URL)), null)
})

test("findBlocked(): tolerates empty and odd argument shapes", () => {
  for (const args of [undefined, null, {}, [], { a: { b: [null, 1, true] } }]) {
    assert.equal(findBlocked(args), null)
  }
})

test("tool.execute.before: hard-blocks real call shapes from the incident", async () => {
  const hook = await beforeHook()
  const input = { tool: "webfetch", sessionID: "test-session", callID: "call-1" }

  const blockedShapes: Record<string, unknown>[] = [
    // webfetch: the failed call that triggered the original incident
    { url: DEAD_URL, format: "markdown" },
    // exa_web_fetch_exa: dead URL hidden in a urls array
    { urls: [CLEAN_URLS[0], DEAD_URL], maxCharacters: 5000 },
    // bash: curl of the dead URL
    { command: `curl -s ${DEAD_URL} | head` },
    // task: dead URL inside a deeply nested subagent prompt
    { prompt: { context: "fetch", urls: [DEAD_URL] } },
  ]

  for (const args of blockedShapes) {
    await assert.rejects(
      hook(input, { args }),
      (err: unknown) => {
        assert.match(String(err), /Blocked by block-proxy-artifacts policy/)
        assert.match(String(err), /Do NOT retry/)
        return true
      },
    )
  }
})

test("tool.execute.before: lets clean calls through untouched", async () => {
  const hook = await beforeHook()
  const input = { tool: "webfetch", sessionID: "test-session", callID: "call-2" }
  for (const url of CLEAN_URLS) {
    await hook(input, { args: { url, format: "text", timeout: 120 } })
  }
  await hook(input, { args: undefined })
  await hook(input, { args: {} })
})

test("tool.execute.before: full guidance once per session, terse repeats", async () => {
  const hook = await beforeHook()
  const args = { url: DEAD_URL }
  const mk = (sessionID: string) => ({ tool: "webfetch", sessionID, callID: "c" })
  const FULL_MARKER = "Go back to the original publisher URL"

  // First occurrence in s1: full teaching guidance.
  await assert.rejects(hook(mk("s1"), { args }), (e: unknown) => String(e).includes(FULL_MARKER))
  // Repeat in s1: still blocked, terse, but keeps the anti-retry instruction.
  await assert.rejects(
    hook(mk("s1"), { args }),
    (e: unknown) => !String(e).includes(FULL_MARKER) && String(e).includes("Do NOT retry"),
  )
  // A different session still gets full guidance.
  await assert.rejects(hook(mk("s2"), { args }), (e: unknown) => String(e).includes(FULL_MARKER))
})

test("self-compatibility: blocklist never matches the plugin's own sources", () => {
  // If someone pastes a live proxy URL (or rewrites a regex to match its own
  // source) into the plugin or its tests, an agent with the plugin installed
  // could no longer edit or even grep these files without disabling the
  // plugin first. This test makes that mistake fail CI. The README is
  // deliberately excluded: it documents the real indicator and must keep it.
  const sources = [
    new URL("../plugin/block-proxy-artifacts.ts", import.meta.url),
    new URL(import.meta.url),
  ]
  for (const src of sources) {
    assert.equal(findBlocked(readFileSync(src, "utf8")), null, `${src} contains a live token`)
  }
})

test("opencode loader contract: single function export (regression: silent plugin death)", async () => {
  // getLegacyPlugins() in opencode's packages/opencode/src/plugin/index.ts
  // iterates EVERY module export and throws "Plugin export is not a function"
  // on any non-function value — the whole plugin then silently does not load
  // (a live incident dials unblocked; the error only surfaces in the log).
  // Named exports of internals are therefore forbidden.
  const mod = await import("../plugin/block-proxy-artifacts.ts")
  assert.deepEqual(Object.keys(mod), ["default"])
  for (const entry of Object.values(mod)) assert.equal(typeof entry, "function")
})
