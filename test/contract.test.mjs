/**
 * Contract test for the `dsh-workspace-icons` browser half.
 *
 * Runs the real `client.js` against a minimal browser surface — the module
 * loader facade, a document head that holds style tags, localStorage, and a
 * React stub — then checks the slot registrations, the stylesheet it writes,
 * the persistence round trip, the URL/emoji validation, and the context-menu
 * shortcut. It does not render React; the components' behaviour is covered by
 * the pure functions they call.
 *
 *   node test/contract.test.mjs
 */
import assert from 'node:assert/strict'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// --- fake browser surface -------------------------------------------------

const elements = new Map()
const windowListeners = new Map()
const documentListeners = new Map()
const storage = new Map()

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName
    this.id = ''
    this.attributes = {}
    this.children = []
    this.textContent = ''
    this.parentElement = null
  }

  setAttribute(name, value) {
    this.attributes[name] = value
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null
  }

  appendChild(child) {
    this.children.push(child)
    child.parentElement = this
    if (child.id !== '') elements.set(child.id, child)
    return child
  }

  remove() {
    if (this.parentElement !== null) {
      const index = this.parentElement.children.indexOf(this)
      if (index >= 0) this.parentElement.children.splice(index, 1)
    }
    if (this.id !== '') elements.delete(this.id)
    this.parentElement = null
  }
}

const head = new FakeElement('head')

globalThis.document = {
  head,
  documentElement: new FakeElement('html'),
  getElementById: (id) => elements.get(id) ?? null,
  createElement: (tagName) => new FakeElement(tagName),
  addEventListener: (type, listener) => {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set())
    documentListeners.get(type).add(listener)
  },
  removeEventListener: (type, listener) => {
    documentListeners.get(type)?.delete(listener)
  },
}

// Node ships a read-only `navigator`, so define our own over it.
Object.defineProperty(globalThis, 'navigator', {
  value: { languages: ['zh-CN', 'zh'], language: 'zh-CN' },
  configurable: true,
  writable: true,
})

globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => {
      captured = definition
    },
  },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  },
  addEventListener: (type, listener) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set())
    windowListeners.get(type).add(listener)
  },
  removeEventListener: (type, listener) => {
    windowListeners.get(type)?.delete(listener)
  },
}

/** Captured module definition from the loader facade. */
let captured = null

/** React stub: the pure functions under test never render a tree. */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => (typeof initial === 'function' ? initial() : initial),
  useEffect: () => undefined,
  useRef: () => ({ current: null }),
  useId: () => 'test-id',
}

/** Module stub table handed to the client factory. */
const requireStub = (specifier) => {
  if (specifier === 'react') return ReactStub
  throw new Error(`unexpected require: ${specifier}`)
}

await import(pathToFileURL(`${here}/../client.js`).href)

assert.ok(captured !== null, 'client.js registers itself with the module loader')
assert.equal(captured.id, 'dsh-workspace-icons', 'loader id is the package name')

const api = captured.factory(requireStub)
const test = api.__test
assert.deepEqual(api.inject, ['slots'], 'declares the slot service')
assert.equal(typeof api.apply, 'function', 'exports apply')

// --- fixtures -------------------------------------------------------------

const registrations = []
const localeCalls = []
const disposers = []
const removals = []

/** Minimal locale service: dictionaries recorded, translate marked. */
const fakeLocale = {
  register(namespace, dicts) {
    localeCalls.push({ namespace, locales: Object.keys(dicts) })
    return () => undefined
  },
  bind(namespace) {
    return (key) => `${namespace}:${key}`
  },
}

/** Minimal plugin context: effects run immediately, disposers are collected. */
const ctx = {
  get: (key) => (key === 'locale' ? fakeLocale : undefined),
  effect: (factory, label) => {
    const dispose = factory()
    if (typeof dispose === 'function') disposers.push({ label, dispose })
    return dispose
  },
  slots: {
    inject: (name, factory) => {
      assert.equal(typeof factory, 'function', `inject(${name}) receives a factory`)
      factory()
    },
    register: (entry, component) => {
      registrations.push({ entry, component })
      return () => undefined
    },
  },
}

// --- apply ----------------------------------------------------------------

api.apply(ctx)

assert.deepEqual(localeCalls, [{ namespace: 'workspace-icons', locales: ['zh', 'en'] }], 'registers both locales')

const overlay = registrations.find((row) => row.entry.name === 'shell.overlay')
const section = registrations.find((row) => row.entry.name === 'settings.section')
assert.ok(overlay !== undefined, 'registers a shell.overlay seat')
assert.equal(overlay.entry.id, 'workspace-icons.picker', 'overlay id is namespaced')
assert.ok(section !== undefined, 'registers a settings.section seat')
assert.equal(section.entry.id, 'workspace-icons', 'settings section id is the plugin id')
assert.equal(section.entry.order, 25, 'sits between agent presets and the cost meter')
assert.equal(typeof section.entry.label, 'function', 'nav label is a thunk so it follows the locale')
assert.equal(section.entry.label(), 'workspace-icons:settings.title', 'nav label reads the active locale')

const styleTag = elements.get('dsh-workspace-icons')
assert.ok(styleTag !== undefined, 'creates the owned stylesheet')
assert.equal(styleTag.textContent, '', 'starts empty: no project is decorated yet')

// --- validation -----------------------------------------------------------

assert.equal(test.sanitizeEmoji('🎨'), '🎨', 'accepts an emoji')
assert.equal(test.sanitizeEmoji('  🐍 '), '🐍', 'trims an emoji')
assert.equal(test.sanitizeEmoji('two chars'), null, 'rejects whitespace')
assert.equal(test.sanitizeEmoji(''), null, 'rejects an empty emoji')
assert.equal(test.sanitizeEmoji('a'.repeat(64)), null, 'rejects an over-long glyph')

assert.equal(test.sanitizeImageUrl('https://example.com/a.png'), 'https://example.com/a.png', 'accepts https')
assert.equal(test.sanitizeImageUrl('data:image/png;base64,AAA'), 'data:image/png;base64,AAA', 'accepts data images')
assert.equal(test.sanitizeImageUrl('javascript:alert(1)'), null, 'rejects javascript:')
assert.equal(test.sanitizeImageUrl('file:///etc/passwd'), null, 'rejects file:')
assert.equal(test.sanitizeImageUrl('https://a/b.png" onload="x'), null, 'rejects a quote break-out')
assert.equal(test.normalizeEntry({ kind: 'image', value: 'javascript:1' }), null, 'drops an invalid stored entry')
assert.deepEqual(test.normalizeEntry({ kind: 'emoji', value: '🔥' }), { kind: 'emoji', value: '🔥' })

assert.equal(test.sanitizeGlyph('code'), 'code', 'accepts a bundled glyph name')
assert.equal(test.sanitizeGlyph('not-an-icon'), null, 'rejects an unknown glyph name')
assert.equal(test.sanitizeGlyph(''), null, 'rejects an empty glyph name')
assert.equal(test.sanitizeGlyph(42), null, 'rejects a non-string glyph name')
assert.equal(test.sanitizeGlyph('<script>'), null, 'rejects markup as a glyph name')
assert.deepEqual(test.normalizeEntry({ kind: 'glyph', value: 'code' }), { kind: 'glyph', value: 'code' })
assert.equal(test.normalizeEntry({ kind: 'glyph', value: 'dropped-in-3.x' }), null, 'drops a stale glyph name')

// --- workspace helpers ----------------------------------------------------

assert.equal(test.iconKey({ workspaceId: 'w1', path: '/Users/me/proj' }), '/Users/me/proj', 'keys by path')
assert.equal(test.iconKey({ workspaceId: 'w1', path: '  ' }), '#w1', 'falls back to the id')
assert.equal(test.iconKey({}), '', 'unusable workspace yields no key')
assert.equal(test.baseName('/Users/me/proj/'), 'proj', 'basename ignores a trailing slash')
assert.equal(test.baseName('C:\\work\\proj'), 'proj', 'basename understands windows paths')
assert.equal(test.workspaceLabel({ title: 'Demo', path: '/x/y' }, 'x'), 'Demo', 'title wins')
assert.equal(test.workspaceLabel({ title: '  ', path: '/x/y' }, 'x'), 'y', 'folder name is the fallback')
assert.equal(test.workspaceLabel({}, 'fallback'), 'fallback', 'last resort is the caller label')

// --- stylesheet -----------------------------------------------------------

const decorated = { workspaceId: 'w1', path: '/Users/me/proj', title: 'proj' }
test.publishWorkspaces([decorated])
assert.equal(
  test.setIcon(decorated, { kind: 'emoji', value: '🎨' }),
  true,
  'sets an emoji icon',
)

const emojiCss = elements.get('dsh-workspace-icons').textContent
assert.match(
  emojiCss,
  /\[data-row-key="workspace:w1"\] > span:first-child > svg\{display:none\}/,
  'hides the native folder glyph',
)
assert.match(
  emojiCss,
  /\[data-row-key="workspace:w1"\] > span:first-child::before\{content:"🎨"/,
  'paints the emoji as the row icon',
)

assert.equal(
  test.setIcon(decorated, { kind: 'image', value: 'https://example.com/icon.png' }),
  true,
  'sets an image icon',
)
assert.match(
  elements.get('dsh-workspace-icons').textContent,
  /background-image:url\("https:\/\/example\.com\/icon\.png"\)/,
  'paints an image icon',
)

const stored = JSON.parse(storage.get('dsh-workspace-icons.v1'))
assert.equal(stored.v, 1, 'stores a schema version')
assert.deepEqual(stored.byPath['/Users/me/proj'], { kind: 'image', value: 'https://example.com/icon.png' })

// A reload reads the same map back.
assert.deepEqual(test.readIcons()['/Users/me/proj'], {
  kind: 'image',
  value: 'https://example.com/icon.png',
})

// Projects without an icon produce no rules.
test.publishWorkspaces([
  decorated,
  { workspaceId: 'w2', path: '/Users/me/other', title: 'other' },
])
const oneRuleSet = elements.get('dsh-workspace-icons').textContent
assert.doesNotMatch(oneRuleSet, /workspace:w2/, 'undecorated projects stay untouched')

// Renaming a project keeps its icon: the key is the path, not the title.
const renamedCss = test.buildCss(
  [{ workspaceId: 'w9', path: '/Users/me/proj', title: 'renamed' }],
  test.stores.iconStore.value,
)
assert.match(renamedCss, /workspace:w9/, 'a renamed project keeps its icon')
assert.match(renamedCss, /background-image:url/, 'and keeps the image variant')

// A bundled glyph is painted through a mask, in that preset's own colour.
const glyphCss = test.buildCss([decorated], { '/Users/me/proj': { kind: 'glyph', value: 'code' } })
assert.match(
  glyphCss,
  /\[data-row-key="workspace:w1"\] > span:first-child > svg\{display:none\}/,
  'a glyph icon hides the native folder glyph too',
)
assert.match(glyphCss, /-webkit-mask-image:url\("data:image\/svg\+xml;charset=utf-8,/, 'masks with a data URI')
assert.match(glyphCss, /mask-image:url\("data:image\/svg\+xml;charset=utf-8,/, 'ships the unprefixed mask too')
assert.match(glyphCss, /mask-size:contain/, 'scales the mask to the slot')
assert.match(glyphCss, /background-color:#[0-9a-f]{6}/, 'paints the preset colour, not the row text colour')
assert.doesNotMatch(glyphCss, /background-color:currentColor/, 'no longer inherits currentColor')
assert.ok(
  glyphCss.includes(`background-color:${test.glyphColor('code')}`),
  'rows use the same colour the picker previews',
)
assert.doesNotMatch(glyphCss, /content:"[^"]/, 'a glyph never paints text')
assert.equal(
  test.buildCss([decorated], { '/Users/me/proj': { kind: 'glyph', value: 'gone' } }),
  '',
  'an unknown glyph renders nothing rather than a broken rule',
)

// --- escaping -------------------------------------------------------------

assert.equal(test.escapeAttribute('a"b'), '"a\\"b"', 'escapes quotes')
assert.equal(test.escapeAttribute('a\\b'), '"a\\\\b"', 'escapes backslashes')
assert.equal(test.escapeAttribute('a\nb'), '"a\\a b"', 'escapes control characters')

// --- context menu ---------------------------------------------------------

/** Build an event target carrying a row key. */
function rowTarget(key) {
  return {
    getAttribute: (name) => (name === 'data-row-key' ? key : null),
    parentElement: null,
  }
}

let prevented = 0
let stopped = 0
const projectEvent = {
  target: rowTarget('workspace:w1'),
  preventDefault: () => {
    prevented += 1
  },
  stopPropagation: () => {
    stopped += 1
  },
}
test.onContextMenu(projectEvent)
assert.equal(prevented, 1, 'claims the context menu on a project row')
assert.equal(stopped, 1, 'stops the sidebar menu from opening')
assert.equal(test.stores.pickerStore.value.workspace.workspaceId, 'w1', 'opens the picker for that project')
test.closePicker()
assert.equal(test.stores.pickerStore.value, null, 'closes the picker')

const sessionEvent = {
  target: rowTarget('session:s1'),
  preventDefault: () => {
    prevented += 1
  },
  stopPropagation: () => {
    stopped += 1
  },
}
test.onContextMenu(sessionEvent)
assert.equal(prevented, 1, 'leaves a session row alone')
assert.equal(test.stores.pickerStore.value, null, 'session rows never open the picker')

const unknownEvent = { target: rowTarget('workspace:missing'), preventDefault: () => {}, stopPropagation: () => {} }
test.onContextMenu(unknownEvent)
assert.equal(test.stores.pickerStore.value, null, 'an unknown workspace id is ignored')

// The document listener is installed by apply and removed by its disposer.
assert.equal(documentListeners.get('contextmenu').size, 1, 'installs one context-menu listener')
const menuDisposer = disposers.find((row) => row.label.endsWith('project row context menu'))
assert.ok(menuDisposer !== undefined, 'registers the listener through ctx.effect')
menuDisposer.dispose()
assert.equal(documentListeners.get('contextmenu').size, 0, 'removes the listener on dispose')

// --- persistence/cleanup --------------------------------------------------

test.clearAllIcons()
assert.equal(elements.get('dsh-workspace-icons').textContent, '', 'clears every rule')
assert.deepEqual(JSON.parse(storage.get('dsh-workspace-icons.v1')), { v: 1, byPath: {} }, 'clears storage')

// A corrupted or hostile payload never crashes the boot.
storage.set('dsh-workspace-icons.v1', '{not json')
assert.deepEqual(test.readIcons(), {}, 'ignores malformed JSON')
storage.set(
  'dsh-workspace-icons.v1',
  JSON.stringify({ v: 1, byPath: { '/x': { kind: 'image', value: 'javascript:alert(1)' } } }),
)
assert.deepEqual(test.readIcons(), {}, 'drops entries whose URL no longer validates')
storage.delete('dsh-workspace-icons.v1')

// The stylesheet disposer removes the tag.
const styleDisposer = disposers.find((row) => row.label.endsWith('stylesheet'))
assert.ok(styleDisposer !== undefined, 'registers stylesheet cleanup through ctx.effect')
const before = elements.get('dsh-workspace-icons')
assert.ok(before !== undefined, 'stylesheet exists before cleanup')
styleDisposer.dispose()
assert.equal(elements.get('dsh-workspace-icons'), undefined, 'removes the stylesheet on dispose')

// --- palette --------------------------------------------------------------

assert.equal(test.PALETTE.length, 7, 'seven palette groups')
const seen = new Set()
for (const group of test.PALETTE) {
  assert.equal(typeof group.id, 'string', 'group has an id')
  assert.ok(group.emojis.length >= 8, `${group.id} has a usable palette`)
  for (const emoji of group.emojis) {
    assert.equal(seen.has(emoji), false, `${emoji} appears once`)
    seen.add(emoji)
    assert.equal(test.sanitizeEmoji(emoji), emoji, `${emoji} passes validation`)
  }
}
assert.ok(seen.size >= 60, `palette offers at least 60 icons (got ${seen.size})`)

// --- bundled glyph set ----------------------------------------------------

const glyphNames = test.GLYPH_NAMES
const glyphSeen = new Set()
assert.ok(test.GLYPH_GROUPS.length >= 8, 'groups the glyph set for the picker')
assert.ok(glyphNames.length >= 100, `bundles a usable icon set (got ${glyphNames.length})`)
assert.match(test.HUGEICONS_VERSION, /^\d+\.\d+\.\d+$/, 'records the upstream version')
assert.deepEqual(
  test.GLYPH_GROUPS.map((group) => group.id),
  ['code', 'web', 'data', 'design', 'docs', 'media', 'science', 'brand', 'business', 'life'],
  'keeps the stable category order',
)
for (const group of test.GLYPH_GROUPS) {
  assert.ok(group.icons.length >= 8, `${group.id} offers a usable set`)
  for (const name of group.icons) {
    assert.equal(glyphSeen.has(name), false, `${name} appears once`)
    glyphSeen.add(name)
    assert.equal(test.sanitizeGlyph(name), name, `${name} passes validation`)
    const markup = test.GLYPHS[name]
    assert.equal(typeof markup, 'string', `${name} has markup`)
    assert.match(
      markup,
      /^(?:<(?:path d="[^"]+"|circle cx="[^"]+" cy="[^"]+" r="[^"]+"|ellipse cx="[^"]+" cy="[^"]+" rx="[^"]+" ry="[^"]+"|rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+"[^>]*)\/>)+$/,
      `${name} is bare Hugeicons markup`,
    )
  }
}
const glyphUrl = test.glyphMaskUrl('code')
assert.match(glyphUrl, /^data:image\/svg\+xml;charset=utf-8,/, 'glyph URLs are inline data URIs')
assert.match(
  decodeURIComponent(glyphUrl),
  /data:image\/svg\+xml;charset=utf-8,<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24"/,
  'the data URI decodes to one standalone SVG',
)
assert.equal(test.glyphMaskUrl('code'), glyphUrl, 'caches one URL per glyph')
assert.equal(test.glyphMaskUrl('gone'), '', 'unknown glyphs have no URL')
assert.equal(test.glyphMaskCss('gone'), '', 'unknown glyphs have no CSS')

// --- per-icon colours -----------------------------------------------------

/** Relative luminance of a `#rrggbb` string, per WCAG. */
function relativeLuminance(hex) {
  const toLinear = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  const [r, g, b] = [1, 3, 5].map((index) => toLinear(parseInt(hex.slice(index, index + 2), 16) / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two relative luminances. */
function contrastRatio(a, b) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const whiteLuminance = 1
const darkLuminance = relativeLuminance('#17171a')

for (const name of glyphNames) {
  const color = test.glyphColor(name)
  assert.match(color, /^#[0-9a-f]{6}$/, `${name} has a hex colour`)
  assert.equal(test.glyphColor(name), color, `${name} keeps the same colour between renders`)
}
assert.equal(test.glyphColor('gone'), '', 'unknown glyphs have no colour')

const distinctColors = new Set(glyphNames.map((name) => test.glyphColor(name)))
assert.equal(
  distinctColors.size,
  glyphNames.length,
  `every bundled icon has its own colour (got ${distinctColors.size} of ${glyphNames.length})`,
)

// Lightness is fixed in OKLCH, so every preset lands in a narrow contrast band
// and none of them disappears on the light or on the dark theme.
for (const name of glyphNames) {
  const luminance = relativeLuminance(test.glyphColor(name))
  const onLight = contrastRatio(luminance, whiteLuminance)
  const onDark = contrastRatio(luminance, darkLuminance)
  assert.ok(onLight >= 3.5, `${name} stays visible on the light theme (${onLight.toFixed(2)}:1)`)
  assert.ok(onLight <= 4.5, `${name} does not go muddy on the light theme (${onLight.toFixed(2)}:1)`)
  assert.ok(onDark >= 4.0, `${name} stays visible on the dark theme (${onDark.toFixed(2)}:1)`)
}

const preview = test.glyphPreviewStyle('code', 16)
assert.equal(preview.backgroundColor, test.glyphColor('code'), 'previews use the preset colour too')
assert.equal(test.glyphPreviewStyle('gone', 16), null, 'unknown glyphs have no preview')

// --- dictionaries ---------------------------------------------------------

const zhKeys = Object.keys(test.DICT.zh).sort()
const enKeys = Object.keys(test.DICT.en).sort()
assert.deepEqual(zhKeys, enKeys, 'both dictionaries carry the same keys')
for (const key of zhKeys) {
  assert.notEqual(test.DICT.zh[key].trim(), '', `zh:${key} is translated`)
  assert.notEqual(test.DICT.en[key].trim(), '', `en:${key} is translated`)
}
for (const group of test.PALETTE) {
  assert.ok(zhKeys.includes(`group.${group.id}`), `zh has group.${group.id}`)
}
for (const group of test.GLYPH_GROUPS) {
  assert.ok(zhKeys.includes(`glyph.${group.id}`), `zh has glyph.${group.id}`)
}
for (const key of ['tab.glyph', 'tab.emoji', 'tab.image', 'editor.searchGlyph', 'editor.noGlyph', 'editor.credit']) {
  assert.ok(zhKeys.includes(key), `zh has ${key}`)
}

// --- AI / rule suggestions ------------------------------------------------

const autoStore = test.stores.autoStore
const alpha = { workspaceId: 'w1', path: '/Users/me/alpha', title: 'alpha', sessionIds: [] }
const beta = { workspaceId: 'w2', path: '/Users/me/beta', title: 'beta', sessionIds: [] }

assert.equal(test.AUTO_STORAGE_KEY, 'dsh-workspace-icons.auto.v1')
assert.equal(test.SUGGEST_ROUTE, 'api/workspace-icons/suggest')
assert.equal(autoStore.value.enabled, true, 'auto suggestions start enabled')

// A missing reason map is tolerated; a broken entry is dropped whole.
assert.deepEqual(test.readAutoState().byPath, {}, 'nothing is stored yet')

// Manual icons always win over a suggestion for the same project.
test.setIcon(alpha, { kind: 'glyph', value: 'code' })
const suggestionMap = {
  [alpha.path]: { entry: { kind: 'glyph', value: 'brain' }, why: { zh: '机器学习', en: 'ML' }, at: 1, source: 'ai' },
  [beta.path]: { entry: { kind: 'glyph', value: 'browser' }, why: { en: 'Web app' }, at: 2, source: 'rule' },
}
const merged = test.mergeIcons(test.stores.iconStore.value, suggestionMap)
assert.deepEqual(merged[alpha.path], { kind: 'glyph', value: 'code' }, 'manual icon wins')
assert.deepEqual(merged[beta.path], { kind: 'glyph', value: 'browser' }, 'suggestion fills the gap')
assert.equal(Object.isFrozen(suggestionMap), false, 'input is not mutated')

// A stored suggestion is readable per key and localized.
test.stores.autoStore.value = {
  ...autoStore.value,
  byPath: Object.freeze({ ...suggestionMap }),
}
assert.equal(test.suggestionFor(beta.path).source, 'rule')
assert.equal(test.suggestionFor('/nowhere'), null)
assert.equal(test.whyText(test.suggestionFor(beta.path)), 'Web app', 'falls back to the other language')
const langBefore = test.currentLanguage()
assert.ok(langBefore === 'zh' || langBefore === 'en')

// Payload handling skips unknown glyphs and bad rows.
const accepted = test.mergeSuggestions({
  results: [
    { key: '/Users/me/gamma', glyph: 'database', why: { zh: '数据项目', en: 'Data' }, source: 'ai' },
    { key: '/Users/me/delta', glyph: 'not-a-real-icon', source: 'ai' },
    { key: '', glyph: 'code' },
    null,
  ],
})
assert.equal(accepted, 1, 'only the valid row is stored')
assert.equal(test.stores.autoStore.value.byPath['/Users/me/gamma'].entry.value, 'database')
assert.equal(test.sanitizeGlyph(test.stores.autoStore.value.byPath['/Users/me/gamma'].entry.value), 'database')

// The switch is persisted and stops the background pass.
test.setAutoEnabled(false)
assert.equal(test.stores.autoStore.value.enabled, false)
assert.equal(JSON.parse(storage.get(test.AUTO_STORAGE_KEY)).enabled, false, 'switch is persisted')
assert.equal(test.needsSuggestion({ workspaceId: 'w3', path: '/Users/me/epsilon' }), true)
assert.equal(test.needsSuggestion({ workspaceId: 'w4', path: 'relative/path' }), false, 'relative paths are never analysed')
assert.equal(test.needsSuggestion({ workspaceId: 'w1', path: '/Users/me/alpha' }), false, 'manual icon means no analysis')
assert.equal(test.needsSuggestion({ workspaceId: 'w2', path: '/Users/me/beta' }), false, 'existing suggestion means no analysis')

test.setAutoEnabled(true)

// One POST, one in-flight guard, and a failure that backs off instead of looping.
let calls = 0
const previousFetch = globalThis.fetch
globalThis.fetch = async (route, init) => {
  calls += 1
  assert.equal(route, test.SUGGEST_ROUTE)
  assert.equal(init.method, 'POST')
  const body = JSON.parse(init.body)
  assert.deepEqual(body.projects.map((project) => project.key), ['/Users/me/epsilon'])
  assert.ok(body.language === 'zh' || body.language === 'en')
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: [{ key: '/Users/me/epsilon', glyph: 'rocket-01', why: { zh: '新项目', en: 'New' }, source: 'ai' }],
    }),
  }
}
try {
  const stored = await test.requestAutoSuggestions([{ workspaceId: 'w3', path: '/Users/me/epsilon' }])
  assert.equal(stored, 1, 'the suggestion is stored')
  assert.equal(test.stores.autoStore.value.byPath['/Users/me/epsilon'].entry.value, 'rocket-01')
  assert.equal(calls, 1)
  assert.equal(test.stores.autoStore.value.running, false, 'the busy flag clears')

  // Nothing left to analyse means no request at all.
  assert.equal(await test.requestAutoSuggestions([{ workspaceId: 'w3', path: '/Users/me/epsilon' }]), 0)
  assert.equal(calls, 1)

  // A rejected request is swallowed and leaves state usable.
  globalThis.fetch = async () => {
    calls += 1
    return { ok: false, status: 503, json: async () => ({}) }
  }
  const failed = await test.requestAutoSuggestions([{ workspaceId: 'w5', path: '/Users/me/zeta' }], { force: true })
  assert.equal(failed, 0)
  assert.equal(test.stores.autoStore.value.error, 'failed')
  assert.equal(test.stores.autoStore.value.running, false)

  // Force mode re-analyses a project that already had a suggestion.
  globalThis.fetch = async () => {
    calls += 1
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [{ key: '/Users/me/zeta', glyph: 'flask-conical', why: { zh: '实验', en: 'Lab' } }] }),
    }
  }
  assert.equal(await test.refreshAuto({ workspaceId: 'w5', path: '/Users/me/zeta' }), 1)
  assert.equal(test.stores.autoStore.value.byPath['/Users/me/zeta'].source, 'rule', 'rule rows stay rule rows')
} finally {
  globalThis.fetch = previousFetch
}

// --- storage bounds --------------------------------------------------------

assert.equal(test.MAX_STORED_ENTRIES, 500, 'the cap is documented')
const many = {}
for (let index = 0; index < 620; index += 1) many[`/p/${index}`] = { kind: 'emoji', value: '🎨' }
const capped = test.capEntries(many)
assert.equal(Object.keys(capped).length, 500, 'oldest entries are dropped')
assert.equal(capped['/p/619'].kind, 'emoji', 'the newest entry survives')
assert.equal(Object.hasOwn(capped, '/p/0'), false, 'the oldest entry is gone')
const small = { '/a': many['/p/0'] }
assert.equal(test.capEntries(small), small, 'small maps pass through untouched')

console.log('dsh-workspace-icons: contract test passed')
