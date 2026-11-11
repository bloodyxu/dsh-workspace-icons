/**
 * Tests for the Host-side evidence reader and the fallback rules.
 *
 * `lib/analyze.js` is pure (only `node:fs/promises` behind an injected io), so
 * it runs here against throwaway project folders. The model call itself lives
 * in `index.js` and is exercised only through these pure parts.
 *
 *   node test/analyze.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  baseNameOf,
  buildPrompt,
  cleanText,
  collectEvidence,
  describeEvidence,
  heuristicSuggestion,
  languageOf,
  nodeIo,
  parseSuggestion,
  sanitizeProjects,
} from '../lib/analyze.js'
import { GLYPH_NAMES } from '../lib/glyphs.mjs'

const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-icons-'))
const glyphSet = new Set(GLYPH_NAMES)

async function project(name, files) {
  for (const [relative, body] of Object.entries(files)) {
    const target = join(root, name, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  return join(root, name)
}

try {
  const web = await project('web', {
    'package.json': JSON.stringify({
      name: 'marketing-site',
      description: 'Landing page for the product',
      keywords: ['landing page'],
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
      scripts: { build: 'next build', dev: 'next dev' },
    }),
    'README.md': '# Marketing site\n\nA landing page built with Next.js.\n',
    'pages/index.jsx': 'export default function Home() { return null }\n',
    'pages/about.jsx': 'export default function About() { return null }\n',
    '.gitignore': 'node_modules\n',
  })
  const ml = await project('ml', {
    'requirements.txt': 'torch==2.3.0\ntransformers==4.42.0\npandas==2.2.0\n',
    'README.md': '# Finetune\n\nTrain a small language model on our corpus.\n',
    'src/train.py': 'import torch\n',
    'src/data.py': 'import torch\n',
  })
  const rust = await project('rust', {
    'Cargo.toml': '[package]\nname = "logtail"\nversion = "0.1.0"\n',
    'src/main.rs': 'fn main() { println!("tail"); }\n',
  })
  const empty = await project('empty', { '.keep': '' })

  // --- primitives ---------------------------------------------------------

  assert.equal(cleanText('  a\n\n b\tc  ', 40), 'a b c', 'whitespace collapses')
  assert.equal(cleanText('x'.repeat(20), 10), 'xxxxxxxxxx…', 'long text is truncated with an ellipsis')
  assert.equal(cleanText(undefined, 10), '', 'non-strings are empty')
  assert.equal(baseNameOf('/Users/me/project/'), 'project')
  assert.equal(baseNameOf('/'), '/')
  assert.equal(languageOf('en'), 'en')
  assert.equal(languageOf('en-US'), 'zh', 'only the exact "en" selects English')
  assert.equal(languageOf(undefined), 'zh')

  assert.deepEqual(sanitizeProjects(null, 5), [])
  const sanitized = sanitizeProjects(
    [
      { key: '/a', path: '/a', title: 'A' },
      { key: '/a', path: '/a', title: 'dupe' },
      { path: 'relative/path' },
      { path: '/nul\u0000byte' },
      { key: '/b', path: '/b', title: '   ' },
      { key: '/c', path: '/c' },
    ],
    2,
  )
  assert.deepEqual(sanitized.map((row) => row.key), ['/a', '/b'], 'deduped, absolute, and capped')
  assert.equal(sanitized[1].title, '', 'a blank title stays blank')

  // --- evidence -----------------------------------------------------------

  const io = nodeIo()
  const webEvidence = await collectEvidence(web, io)
  assert.equal(webEvidence.name, 'web')
  assert.ok(webEvidence.dependencies.includes('next'), 'package.json dependencies land in the evidence')
  assert.equal(webEvidence.manifests.length, 0, 'package.json is parsed separately, not as a manifest head')
  assert.match(webEvidence.readme, /landing page built with next\.js/i, 'README is read as evidence')
  assert.equal(webEvidence.description, 'Landing page for the product')
  assert.ok(webEvidence.scripts.includes('build'), 'npm scripts are collected')
  assert.ok(webEvidence.entries.includes('pages/'), 'directories are listed with a trailing slash')
  assert.ok(webEvidence.entries.every((entry) => !entry.startsWith('.')), 'dotfiles are skipped')
  assert.equal(webEvidence.languages.javascript, 2, 'nested source files are bucketed by language')

  const mlIOEvidence = await collectEvidence(ml, io)
  const requirements = mlIOEvidence.manifests.find((entry) => entry.file === 'requirements.txt')
  assert.ok(requirements !== undefined, 'other manifests are collected')
  assert.match(requirements.head, /torch/, 'the manifest head carries the package list')

  const missing = await collectEvidence(join(root, 'does-not-exist'), io)
  assert.equal(missing.name, 'does-not-exist', 'a missing folder still yields a usable name')
  assert.deepEqual(missing.dependencies, [])
  assert.deepEqual(missing.entries, [])

  // --- fallback rules -----------------------------------------------------

  const cases = [
    [web, 'browser', 'a Next.js site'],
    [ml, 'brain', 'torch in requirements.txt'],
    [rust, 'settings-02', 'a Rust manifest'],
    [empty, 'package-01', 'an empty folder'],
  ]
  for (const [folder, expected, label] of cases) {
    const evidence = await collectEvidence(folder, io)
    const suggestion = heuristicSuggestion(evidence)
    assert.equal(suggestion.glyph, expected, `${label} maps to ${expected}`)
    assert.ok(glyphSet.has(suggestion.glyph), `${label} stays inside the bundled catalog`)
    assert.notEqual(suggestion.why.zh.trim(), '', 'zh reason is present')
    assert.notEqual(suggestion.why.en.trim(), '', 'en reason is present')
  }

  // A folder whose only signal is prose still lands on a known icon.
  const prose = await project('prose', { 'README.md': '# Notes\n\nSmall documentation site for the team wiki.\n' })
  const proseSuggestion = heuristicSuggestion(await collectEvidence(prose, io))
  assert.equal(proseSuggestion.glyph, 'book-01')
  assert.ok(glyphSet.has(proseSuggestion.glyph))

  // "language model" must not be mistaken for a 3D "model".
  assert.equal(heuristicSuggestion({ manifests: [], readme: 'train a language model', name: 'x' }).glyph, 'sparkles')

  // --- prompt + parsing ---------------------------------------------------

  const description = describeEvidence(webEvidence)
  assert.match(description, /^folder: web$/m)
  assert.match(description, /^dependencies: /m)
  assert.match(description, /^readme: /m)
  assert.ok(!description.includes('undefined'), 'no undefined leaks into the prompt')

  const prompt = buildPrompt(webEvidence, GLYPH_NAMES, 'zh')
  assert.match(prompt.system, /ONE JSON object/, 'the system message asks for JSON')
  assert.match(prompt.system, /简体中文/, 'the reason language follows the request')
  assert.match(prompt.user, /Allowed icon names:/)
  assert.ok(prompt.user.includes(GLYPH_NAMES[0]), 'the catalog is in the user message')
  assert.match(prompt.user, /Project evidence:/)
  assert.match(buildPrompt(webEvidence, GLYPH_NAMES, 'en').system, /English/)

  assert.deepEqual(parseSuggestion('{"glyph":"brain","why":"trains models"}', GLYPH_NAMES), {
    glyph: 'brain',
    why: 'trains models',
  })
  assert.deepEqual(parseSuggestion('Sure!\n```json\n{"glyph":"Code-Simple","why":"typescript"}\n```', GLYPH_NAMES), {
    glyph: 'code-simple',
    why: 'typescript',
  })
  assert.equal(parseSuggestion('{"glyph":"not-real","why":"x"}', GLYPH_NAMES), null)
  assert.equal(parseSuggestion('no json here', GLYPH_NAMES), null)
  assert.equal(parseSuggestion(null, GLYPH_NAMES), null)
  assert.equal(parseSuggestion('{"glyph":"code","why":"x"}', GLYPH_NAMES).why, 'x')

  console.log('dsh-workspace-icons: analyze test passed')
} finally {
  await rm(root, { recursive: true, force: true })
}
