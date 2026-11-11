/**
 * Host half of `dsh-workspace-icons`: turns a project folder into one icon.
 *
 * The browser half owns the presentation (icon table, stylesheet, pickers).
 * What it cannot do is look inside a folder or reach a model, so this module
 * serves exactly one thing: `POST /api/workspace-icons/suggest` reads bounded
 * evidence about each requested project (manifests, README, top-level layout,
 * file types) and asks the harness LLM to pick one icon from the bundled
 * Hugeicons catalog, with a deterministic rule-based suggestion as the fallback
 * whenever the model is unavailable, slow, or answers with something unusable.
 *
 * The route is an exact Fetch route on the connection service, so it inherits
 * the harness's own browser authentication (`principal.kind === 'owner'`).
 *
 * @module dsh-workspace-icons
 */
import {
  buildPrompt,
  collectEvidence,
  heuristicSuggestion,
  languageOf,
  nodeIo,
  parseSuggestion,
  sanitizeProjects,
} from './lib/analyze.js'
import { GLYPH_NAMES } from './lib/glyphs.mjs'

/** The project's API surface, relative to the page (the harness owns `/api`). */
export const SUGGEST_PATH = '/api/workspace-icons/suggest'

/** Projects served per request; the browser sends only ones still unsuggested. */
const MAX_PROJECTS = 24

/**
 * Largest accepted request body. 24 projects of path/title fit in a few KB,
 * so anything far above that is not a genuine request from this plugin's UI.
 */
const MAX_BODY_BYTES = 64 * 1024

/** Per-project model budget. */
const PER_PROJECT_TIMEOUT_MS = 25000

/** Per-project budget, overridable in tests so a timeout can be exercised. */
let perProjectTimeoutMs = PER_PROJECT_TIMEOUT_MS

/** Whole-request budget, so a slow fleet cannot stall the sidebar. */
const TOTAL_BUDGET_MS = 45000

/** A one-line answer with one icon name needs very little room. */
const MAX_TOKENS = 160

/** How many projects may talk to the model at once. */
const CONCURRENCY = 2

/** Injectable `llm` surface: `stream()` plus an optional capability probe. */
const LLM_FACE = 'llm'

/**
 * `@deepseek-ai/dsh-llm` is resolved by the Host runtime, not by this package,
 * so it is imported lazily: a resolution problem must degrade the feature to
 * local rules instead of failing the whole bundle.
 * @type {{BlockAssembler: any, createUserMessage: any}|null|undefined}
 */
let llmKitCache

/** @returns {Promise<{BlockAssembler: any, createUserMessage: any}|null>} the kit, or null. */
async function llmKit() {
  if (llmKitCache !== undefined) return llmKitCache
  try {
    llmKitCache = await import('@deepseek-ai/dsh-llm')
  } catch {
    llmKitCache = null
  }
  return llmKitCache
}

/**
 * Read and parse a bounded JSON request body.
 * @param {Request} request - the incoming POST.
 * @returns {Promise<object|null>} the parsed body, or null when it is too large.
 */
async function readBody(request) {
  const declared = Number(request.headers?.get?.('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return null
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * Paths of the workspaces this deployment knows about, used to bound what the
 * route may read. `null` means "no registry to check against": the endpoint is
 * already owner-authenticated and the caller only sends real workspace paths,
 * so an absent registry degrades to the previous behaviour instead of failing.
 * @param {object} ctx - the Cordis context.
 * @returns {Set<string>|null} normalized paths, or null when unknown.
 */
function knownWorkspacePaths(ctx) {
  const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  if (registry === undefined || typeof registry.list !== 'function') return null
  let list
  try {
    list = registry.list()
  } catch {
    return null
  }
  if (!Array.isArray(list)) return null
  const paths = new Set()
  for (const workspace of list) {
    const path = typeof workspace?.path === 'string' ? workspace.path : ''
    if (path !== '') paths.add(normalizePath(path))
  }
  return paths.size === 0 ? null : paths
}

/**
 * One comparable form of a folder path: drop trailing separators, keep `/`.
 * @param {string} path - absolute path.
 * @returns {string} the normalized path.
 */
function normalizePath(path) {
  const trimmed = path.replace(/[/\\]+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * Resolve the deployment's default provider/model route.
 * @param {object} ctx - the Cordis context.
 * @returns {{provider: string, model: string}|null} the route, or null.
 */
function defaultRoute(ctx) {
  const holder = ctx.get('agentDefaultModel')
  const selection = typeof holder?.currentSelection === 'function' ? holder.currentSelection() : undefined
  if (selection === null || typeof selection !== 'object') return null
  const provider = typeof selection.provider === 'string' ? selection.provider : ''
  const model = typeof selection.model === 'string' ? selection.model : ''
  return provider === '' || model === '' ? null : { provider, model }
}

/**
 * Ask the model for one icon name.
 * @param {object} ctx - the Cordis context.
 * @param {{provider: string, model: string}|null} route - model route.
 * @param {object} evidence - collected project evidence.
 * @param {'zh'|'en'} language - reason language.
 * @param {AbortSignal} signal - cancellation.
 * @returns {Promise<{glyph: string, why: string}|null>} the model's answer.
 */
async function askModel(ctx, route, evidence, language, signal) {
  if (route === null) return null
  const llm = ctx.get(LLM_FACE)
  if (llm === undefined || typeof llm.stream !== 'function') return null
  const kit = await llmKit()
  if (kit === null) return null
  const { system, user } = buildPrompt(evidence, GLYPH_NAMES, language)
  const assembler = new kit.BlockAssembler()
  for await (const chunk of llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [
      kit.createUserMessage({
        content: [{ type: 'text', text: user }],
        source: { kind: 'plugin:dsh-workspace-icons' },
      }),
    ],
    system,
    maxTokens: MAX_TOKENS,
    signal,
  })) {
    assembler.push(chunk)
  }
  const text = assembler
    .blocks()
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
  const parsed = parseSuggestion(text, GLYPH_NAMES)
  if (parsed === null) return null
  return { glyph: parsed.glyph, why: parsed.why }
}

/**
 * Suggest one icon for one project: the model when it answers, the rules
 * otherwise. Never throws: a failure is reported as a `source: "rule"` result.
 *
 * @param {object} ctx - the Cordis context.
 * @param {{provider: string, model: string}|null} route - model route.
 * @param {{key: string, path: string, title: string}} project - the project.
 * @param {'zh'|'en'} language - reason language.
 * @param {AbortSignal} signal - remaining request budget.
 * @returns {Promise<object>} one result row.
 */
async function suggestOne(ctx, route, project, language, signal) {
  const io = nodeIo()
  let evidence
  try {
    evidence = await collectEvidence(project.path, io)
  } catch {
    evidence = { path: project.path, name: project.title, dependencies: [], manifests: [], readme: '', entries: [], languages: {}, description: '', keywords: [], scripts: [], packageJson: null }
  }
  const fallback = heuristicSuggestion(evidence)
  const row = {
    key: project.key,
    path: project.path,
    glyph: fallback.glyph,
    why: { [language]: fallback.why[language] },
    source: 'rule',
  }
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), perProjectTimeoutMs)
  const cancel = () => timeout.abort()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const answer = await askModel(ctx, route, evidence, language, timeout.signal)
    if (answer !== null) {
      row.glyph = answer.glyph
      row.why = { [language]: answer.why }
      row.source = 'ai'
    }
  } catch {
    /* keep the rule-based suggestion */
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
  return row
}

/**
 * Serve the suggestion request.
 * @param {object} ctx - the Cordis context.
 * @param {Request} request - the incoming POST.
 * @param {AbortSignal} budget - whole-request budget.
 * @returns {Promise<Response>} JSON response.
 */
async function handleSuggest(ctx, request, budget) {
  let body
  try {
    body = await readBody(request)
  } catch {
    return json({ error: 'invalid-body' }, 400)
  }
  if (body === null) return json({ error: 'body-too-large' }, 413)
  const authored = sanitizeProjects(body.projects, MAX_PROJECTS)
  if (authored.length === 0) return json({ results: [] })
  const known = knownWorkspacePaths(ctx)
  const projects =
    known === null ? authored : authored.filter((project) => known.has(normalizePath(project.path)))
  if (projects.length === 0) return json({ results: [], error: 'unknown-workspace' }, 422)
  const language = languageOf(body?.language)
  const route = defaultRoute(ctx)
  const results = new Array(projects.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < projects.length) {
      const index = cursor
      cursor += 1
      results[index] = await suggestOne(ctx, route, projects[index], language, budget)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, projects.length) }, worker))
  return json({ results: results.filter((row) => row !== undefined), route: route === null ? null : route.model })
}

/**
 * Serialize a JSON response.
 * @param {unknown} body - JSON-serializable body.
 * @param {number} status - HTTP status.
 * @returns {Response} the response.
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** The Host services this plugin needs; without `connection` it cannot be reached. */
export const inject = ['connection']

/**
 * Register the suggestion route.
 * @param {object} ctx - the Cordis context.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: SUGGEST_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          const budget = new AbortController()
          const timer = setTimeout(() => budget.abort(), TOTAL_BUDGET_MS)
          try {
            return await handleSuggest(ctx, request, budget.signal)
          } catch {
            return json({ error: 'suggest-failed' }, 500)
          } finally {
            clearTimeout(timer)
          }
        },
      }),
    'workspace-icons: project icon suggestions',
  )
}

/**
 * Test surface: the route handler and the model kit are private, but the
 * tests need to drive them without a live Cordis context.
 */
export const __test = {
  SUGGEST_PATH,
  MAX_BODY_BYTES,
  readBody,
  knownWorkspacePaths,
  normalizePath,
  handleSuggest,
  suggestOne,
  defaultRoute,
  askModel,
  /**
   * Replace the lazily imported LLM kit (tests only).
   * @param {{BlockAssembler: any, createUserMessage: any}|null} kit - fake kit.
   * @returns {void}
   */
  /**
   * Shorten the per-project budget (tests only).
   * @param {number} ms - budget in milliseconds.
   * @returns {void}
   */
  setPerProjectTimeout(ms) {
    perProjectTimeoutMs = ms
  },
  setLlmKit(kit) {
    llmKitCache = kit
  },
  /** @returns {void} forget any imported or injected kit. */
  resetLlmKit() {
    llmKitCache = undefined
  },
  GLYPH_NAMES,
}
