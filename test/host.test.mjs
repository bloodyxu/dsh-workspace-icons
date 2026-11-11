/**
 * Tests for the Host half: the `/api/workspace-icons/suggest` route.
 *
 * The real `index.js` is imported (it degrades gracefully when
 * `@deepseek-ai/dsh-llm` cannot be resolved) and driven through a fake Cordis
 * context, so this covers the request validation, the rule fallback, the model
 * call and its failure paths without a running Harness.
 *
 *   node test/host.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { apply, inject, __test } from '../index.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-icons-host-'))

async function project(name, files) {
  for (const [relative, body] of Object.entries(files)) {
    const target = join(root, name, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  return join(root, name)
}

function fakeCtx({
  selection = { provider: 'deepseek-account', model: 'deepseek-flash' },
  llm = undefined,
  registry = undefined,
} = {}) {
  const effects = []
  let route = null
  const ctx = {
    connection: {
      fetch: {
        register(candidate) {
          route = candidate
          return () => {
            route = null
          }
        },
      },
    },
    effect(factory) {
      const disposer = factory()
      effects.push(disposer)
      return disposer
    },
    get(face) {
      if (face === 'agentDefaultModel') return { currentSelection: () => selection }
      if (face === 'llm') return llm
      if (face === 'workspaceRegistry') return registry
      return undefined
    },
  }
  return {
    ctx,
    get route() {
      return route
    },
    dispose() {
      for (const effect of effects.reverse()) if (typeof effect === 'function') effect()
    },
  }
}

function post(body) {
  return new Request('http://127.0.0.1/api/workspace-icons/suggest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

try {
  const web = await project('web', {
    'package.json': JSON.stringify({ name: 'site', dependencies: { next: '14.0.0', react: '18.0.0' } }),
    'README.md': '# Site\n\nA landing page.\n',
    'app/page.jsx': 'export default function Page() { return null }\n',
  })
  const api = await project('api', {
    'package.json': JSON.stringify({ name: 'svc', dependencies: { express: '^4.19.0' } }),
    'server/index.js': 'module.exports = 1\n',
  })

  assert.deepEqual(inject, ['connection'], 'the route needs the connection service')

  // --- registration -------------------------------------------------------

  const harness = fakeCtx()
  apply(harness.ctx)
  assert.ok(harness.route !== null, 'the route is registered')
  assert.equal(harness.route.path, '/api/workspace-icons/suggest')
  assert.deepEqual(harness.route.methods, ['POST'])
  assert.equal(harness.route.requestBody, 'buffered')

  const call = (body) => harness.route.fetch(post(body))

  // --- validation ---------------------------------------------------------

  const broken = await call('{not json')
  assert.equal(broken.status, 400)
  assert.deepEqual(await broken.json(), { error: 'invalid-body' })

  const empty = await call({ projects: [] })
  assert.equal(empty.status, 200)
  assert.deepEqual((await empty.json()).results, [])

  const relative = await call({ projects: [{ key: 'x', path: 'relative/path' }] })
  assert.deepEqual((await relative.json()).results, [], 'relative paths are refused')

  const oversized = await call({ projects: [], padding: 'x'.repeat(70 * 1024) })
  assert.equal(oversized.status, 413, 'an oversized body is refused before any file read')
  assert.deepEqual(await oversized.json(), { error: 'body-too-large' })
  assert.equal(__test.normalizePath('/a/b/'), __test.normalizePath('/a/b'), 'trailing separators compare equal')
  assert.equal(__test.normalizePath('/'), '/', 'the root keeps its slash')

  // Only folders the workspace registry knows about may be read.
  const registered = fakeCtx({ registry: { list: () => [{ workspaceId: 'w', path: web }, { workspaceId: 'x', path: `${api}/` }] } })
  apply(registered.ctx)
  const knownResponse = await registered.route.fetch(
    post({ language: 'en', projects: [{ key: web, path: `${web}/`, title: 'web' }] }),
  )
  assert.equal(knownResponse.status, 200, 'a registered folder is served even with a trailing separator')
  const strangerResponse = await registered.route.fetch(
    post({ language: 'en', projects: [{ key: '/tmp', path: '/tmp', title: 'tmp' }] }),
  )
  assert.equal(strangerResponse.status, 422, 'a folder outside the registry is refused')
  assert.deepEqual(await strangerResponse.json(), { results: [], error: 'unknown-workspace' })
  registered.dispose()

  // --- rule fallback (no llm service) -------------------------------------

  const ruleResponse = await call({
    language: 'zh',
    projects: [
      { key: web, path: web, title: 'web' },
      { key: api, path: api, title: 'api' },
    ],
  })
  assert.equal(ruleResponse.status, 200)
  const rulePayload = await ruleResponse.json()
  assert.equal(rulePayload.results.length, 2)
  assert.equal(rulePayload.route, 'deepseek-flash', 'the resolved model is reported')
  const byKey = new Map(rulePayload.results.map((row) => [row.key, row]))
  assert.equal(byKey.get(web).glyph, 'browser', 'Next.js is a web app')
  assert.equal(byKey.get(web).source, 'rule', 'no model means a rule suggestion')
  assert.equal(byKey.get(api).glyph, 'cloud', 'Express is a back end')
  assert.equal(byKey.get(web).why.zh.trim() !== '', true, 'the reason is localized')

  // --- model path ---------------------------------------------------------

  const fakeKit = {
    BlockAssembler: class {
      constructor() {
        this.text = ''
        this.done = { kind: 'stop' }
      }
      push(chunk) {
        if (chunk?.type === 'text') this.text += chunk.text
      }
      blocks() {
        return [{ type: 'text', text: this.text }]
      }
    },
    createUserMessage(input) {
      return { role: 'user', ...input }
    },
  }
  const llm = {
    async *stream(options) {
      assert.equal(options.maxTokens, 160)
      assert.ok(options.signal instanceof AbortSignal, 'the call is cancellable')
      yield { type: 'text', text: 'Here you go: {"glyph":"sparkles","why":"AI 训练项目"}' }
    },
  }
  const withModel = fakeCtx({ llm })
  apply(withModel.ctx)
  __test.setLlmKit(fakeKit)
  try {
    const aiResponse = await withModel.route.fetch(
      post({ language: 'zh', projects: [{ key: web, path: web, title: 'web' }] }),
    )
    const aiPayload = await aiResponse.json()
    assert.equal(aiPayload.results[0].glyph, 'sparkles', 'the model answer wins')
    assert.equal(aiPayload.results[0].source, 'ai')
    assert.equal(aiPayload.results[0].why.zh, 'AI 训练项目')

    // A model that answers with an unknown icon must not corrupt the row.
    const badLlm = {
      async *stream() {
        yield { type: 'text', text: '{"glyph":"definitely-not-an-icon","why":"x"}' }
      },
    }
    const withBadModel = fakeCtx({ llm: badLlm })
    apply(withBadModel.ctx)
    const badPayload = await (
      await withBadModel.route.fetch(post({ language: 'en', projects: [{ key: api, path: api, title: 'api' }] }))
    ).json()
    assert.equal(badPayload.results[0].glyph, 'cloud', 'an invalid answer falls back to the rule')
    assert.equal(badPayload.results[0].source, 'rule')

    // A throwing model is swallowed the same way.
    const throwing = {
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('model exploded')
      },
    }
    const withThrowing = fakeCtx({ llm: throwing })
    apply(withThrowing.ctx)
    const thrownPayload = await (
      await withThrowing.route.fetch(post({ language: 'en', projects: [{ key: web, path: web, title: 'web' }] }))
    ).json()
    assert.equal(thrownPayload.results[0].source, 'rule')

    // The request budget aborts long calls instead of hanging the sidebar.
    __test.setPerProjectTimeout(15)
    const slow = {
      async *stream(options) {
        await new Promise((resolve) => setTimeout(resolve, 80))
        if (options.signal.aborted) throw new Error('aborted')
        yield { type: 'text', text: '{"glyph":"code","why":"late"}' }
      },
    }
    const withSlow = fakeCtx({ llm: slow })
    apply(withSlow.ctx)
    const slowPayload = await (
      await withSlow.route.fetch(post({ language: 'en', projects: [{ key: web, path: web, title: 'web' }] }))
    ).json()
    assert.equal(slowPayload.results[0].glyph, 'browser', 'a slow model still yields the rule suggestion')
  } finally {
    __test.setPerProjectTimeout(25000)
    __test.resetLlmKit()
    withModel.dispose()
  }

  // --- missing services ---------------------------------------------------

  const noSelection = fakeCtx({ selection: { provider: '', model: '' } })
  apply(noSelection.ctx)
  const noRoute = await (await noSelection.route.fetch(post({ projects: [{ key: web, path: web, title: 'web' }] }))).json()
  assert.equal(noRoute.route, null, 'no default model means no route')
  assert.equal(noRoute.results[0].source, 'rule')
  assert.equal(noRoute.results[0].glyph, 'browser')

  // --- disposal -----------------------------------------------------------

  harness.dispose()
  assert.equal(harness.route, null, 'the route is removed with the plugin')

  assert.equal(__test.MAX_BODY_BYTES, 64 * 1024, 'the body cap is documented and enforced')

  console.log('dsh-workspace-icons: host test passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
