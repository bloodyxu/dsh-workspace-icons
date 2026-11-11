/**
 * Project evidence collection and icon selection for the Host half.
 *
 * Everything here is pure and dependency-free so it can be unit tested with
 * plain `node` (no Cordis context, no filesystem beyond the injected `io`):
 * the route in `index.js` only wires these pieces to the LLM service and HTTP.
 *
 * @module dsh-workspace-icons/lib/analyze
 */
import { open, readdir, stat } from 'node:fs/promises'

/** Bytes of a manifest or README worth quoting to the model. */
const MANIFEST_HEAD_BYTES = 1400

/** Characters kept from a README (whitespace collapsed by `cleanText`). */
const README_CHARS = 900

/** Top-level entries read from a project root. */
const MAX_TOP_ENTRIES = 40

/** Directory names that say nothing about a project's identity. */
const IGNORED_ENTRIES = new Set([
  'node_modules',
  '.git',
  '.github',
  '.svn',
  '.hg',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '.idea',
  '.vscode',
  '.DS_Store',
])

/** Manifest files worth reading, with the signal they imply. */
const MANIFESTS = [
  { file: 'package.json', signal: 'node' },
  { file: 'pyproject.toml', signal: 'python' },
  { file: 'requirements.txt', signal: 'python' },
  { file: 'setup.py', signal: 'python' },
  { file: 'Cargo.toml', signal: 'rust' },
  { file: 'go.mod', signal: 'go' },
  { file: 'Gemfile', signal: 'ruby' },
  { file: 'pom.xml', signal: 'java' },
  { file: 'build.gradle', signal: 'java' },
  { file: 'build.gradle.kts', signal: 'kotlin' },
  { file: 'composer.json', signal: 'php' },
  { file: 'Package.swift', signal: 'swift' },
  { file: 'pubspec.yaml', signal: 'dart' },
  { file: 'CMakeLists.txt', signal: 'cpp' },
  { file: '*.uproject', signal: 'unity' },
]

/** README files, best first. */
const README_FILES = ['README.md', 'readme.md', 'README.MD', 'README.markdown', 'README.rst', 'README.txt', 'README']

/**
 * Dependency-name rules, most specific first. The first match wins, so a
 * monorepo mentioning both React and Electron reads as a desktop app.
 * @type {readonly {match: readonly string[], glyph: string, why: {zh: string, en: string}}[]}
 */
const DEPENDENCY_RULES = [
  { match: ['react-native', 'expo'], glyph: 'smart-phone-01', why: { zh: 'React Native 移动应用', en: 'React Native mobile app' } },
  { match: ['electron', 'tauri', 'nw', '@tauri-apps/api'], glyph: 'computer', why: { zh: '桌面应用', en: 'Desktop application' } },
  { match: ['next', 'nuxt', 'astro', 'gatsby', 'sveltekit', '@sveltejs/kit', 'remix', '@remix-run/react'], glyph: 'browser', why: { zh: '网站项目', en: 'Web application' } },
  { match: ['react', 'vue', 'svelte', 'solid-js', 'preact', 'lit', '@angular/core'], glyph: 'web-design-01', why: { zh: '前端界面项目', en: 'Front-end UI project' } },
  { match: ['nest', '@nestjs/core', 'express', 'fastify', 'koa', 'hapi', 'hono', 'elysia'], glyph: 'cloud', why: { zh: '服务端接口', en: 'Back-end service' } },
  { match: ['prisma', '@prisma/client', 'drizzle-orm', 'typeorm', 'sequelize', 'mongoose', 'pg', 'mysql2', 'redis', 'sqlite3', 'better-sqlite3'], glyph: 'database', why: { zh: '数据库相关', en: 'Database project' } },
  { match: ['@tensorflow/tfjs', 'torch', 'pytorch', 'onnx', 'onnxruntime', 'transformers', 'jax', 'huggingface', '@huggingface/transformers'], glyph: 'brain', why: { zh: '机器学习项目', en: 'Machine-learning project' } },
  { match: ['openai', 'anthropic', '@anthropic-ai/sdk', 'langchain', '@langchain/core', 'llamaindex', 'ai'], glyph: 'sparkles', why: { zh: 'AI 应用', en: 'AI application' } },
  { match: ['pandas', 'polars', 'numpy', 'scipy', 'statsmodels', 'dask'], glyph: 'chart-line-data-01', why: { zh: '数据分析项目', en: 'Data-analysis project' } },
  { match: ['jupyter', 'nbformat', 'notebook', 'ipykernel'], glyph: 'notebook', why: { zh: 'Jupyter 笔记本项目', en: 'Notebook project' } },
  { match: ['matplotlib', 'plotly', 'echarts', 'd3', 'chart.js', 'recharts', 'vega', 'vega-lite'], glyph: 'bar-chart', why: { zh: '数据可视化', en: 'Data visualization' } },
  { match: ['three', 'threejs', 'babylonjs', '@babylonjs/core', 'pixi.js', 'regl'], glyph: 'shapes-01', why: { zh: '3D 图形项目', en: '3D graphics project' } },
  { match: ['jest', 'vitest', 'mocha', 'ava', 'playwright', '@playwright/test', 'cypress'], glyph: 'bug-01', why: { zh: '测试工程', en: 'Test project' } },
  { match: ['vite', 'webpack', 'rollup', 'esbuild', 'turbo', 'turbopack'], glyph: 'wrench-01', why: { zh: '构建工具', en: 'Build tooling' } },
  { match: ['tailwindcss', 'sass', 'postcss', 'styled-components', '@emotion/react', 'less'], glyph: 'palette', why: { zh: '样式与设计系统', en: 'Styling work' } },
  { match: ['@figma/plugin-typings', 'figma'], glyph: 'figma', why: { zh: 'Figma 插件', en: 'Figma plugin' } },
  { match: ['@storybook/react', '@storybook/react-vite', 'storybook'], glyph: 'book-open-01', why: { zh: '组件文档', en: 'Component documentation' } },
  { match: ['graphql', '@apollo/client', 'apollo-server', '@apollo/server'], glyph: 'link-01', why: { zh: 'GraphQL 接口', en: 'GraphQL API' } },
  { match: ['firebase', 'firebase-admin', '@supabase/supabase-js'], glyph: 'cloud-upload', why: { zh: '云服务项目', en: 'Cloud-backed project' } },
  { match: ['stripe', '@stripe/stripe-js', 'paypal', '@paypal/paypal-js'], glyph: 'credit-card', why: { zh: '支付集成', en: 'Payments integration' } },
  { match: ['discord.js', 'eris'], glyph: 'discord', why: { zh: 'Discord 机器人', en: 'Discord bot' } },
  { match: ['commander', 'yargs', 'clipanion', 'cac', '@oclif/core', 'ink'], glyph: 'terminal', why: { zh: '命令行工具', en: 'Command-line tool' } },
  { match: ['aws-sdk', '@aws-sdk/client-s3', 'aws-cdk-lib'], glyph: 'server', why: { zh: '云存储与基础设施', en: 'Cloud infrastructure' } },
  { match: ['express-graphql', 'socket.io', 'ws', 'undici', 'axios'], glyph: 'signal', why: { zh: '网络通信', en: 'Networking' } },
]

/**
 * README / name / entry keywords, checked in order after dependencies.
 * @type {readonly {match: RegExp, glyph: string, why: {zh: string, en: string}}[]}
 */
const TEXT_RULES = [
  { match: /(^|\W)(game|unity|godot|unreal)($|\W)/i, glyph: 'play-circle', why: { zh: '游戏项目', en: 'Game project' } },
  { match: /(^|\W)(machine learning|deep learning|neural|llm|language model|fine[- ]?tun(e|ing)|transformer|embedding|大模型|机器学习|人工智能)($|\W)/i, glyph: 'sparkles', why: { zh: 'AI／模型项目', en: 'AI / model project' } },
  { match: /(^|\W)(design system|ui kit|design tokens|设计系统)($|\W)/i, glyph: 'palette', why: { zh: '设计系统', en: 'Design system' } },
  { match: /(^|\W)(docs|documentation|handbook|wiki|文档)($|\W)/i, glyph: 'book-01', why: { zh: '文档项目', en: 'Documentation project' } },
  { match: /(^|\W)(blog|website|landing page|官网|博客)($|\W)/i, glyph: 'globe', why: { zh: '网站／博客', en: 'Website / blog' } },
  { match: /(^|\W)(cli|command line|terminal|命令行)($|\W)/i, glyph: 'terminal', why: { zh: '命令行工具', en: 'Command-line tool' } },
  { match: /(^|\W)(api|backend|server|service|服务端)($|\W)/i, glyph: 'cloud', why: { zh: '服务端项目', en: 'Back-end project' } },
  { match: /(^|\W)(scraper|crawler|爬虫)($|\W)/i, glyph: 'internet-antenna-01', why: { zh: '抓取脚本', en: 'Scraper' } },
  { match: /(^|\W)(plugin|extension|插件|扩展)($|\W)/i, glyph: 'puzzle', why: { zh: '插件／扩展', en: 'Plugin / extension' } },
  { match: /(^|\W)(music|audio|音频|音乐)($|\W)/i, glyph: 'music-note-01', why: { zh: '音频项目', en: 'Audio project' } },
  { match: /(^|\W)(video|film|视频)($|\W)/i, glyph: 'video-01', why: { zh: '视频项目', en: 'Video project' } },
  { match: /(^|\W)(image|photo|图片|摄影)($|\W)/i, glyph: 'image-01', why: { zh: '图像项目', en: 'Image project' } },
  { match: /(^|\W)(3d|cinema 4d|blender|unreal|godot|houdini|zbrush|renderer|rendering|渲染|建模)($|\W)/i, glyph: 'shapes-01', why: { zh: '3D 项目', en: '3D project' } },
  { match: /(^|\W)(automation|script|自动化|脚本)($|\W)/i, glyph: 'zap', why: { zh: '自动化脚本', en: 'Automation script' } },
]

/** Extension → language bucket, used when nothing stronger is known. */
const EXTENSION_GROUPS = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  swift: 'swift', m: 'objectivec', mm: 'objectivec', cs: 'csharp', cpp: 'cpp',
  cc: 'cpp', c: 'c', h: 'c', hpp: 'cpp', php: 'php', dart: 'dart', lua: 'lua',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'shell',
  html: 'html', css: 'css', scss: 'css', sass: 'css', less: 'css',
  vue: 'vue', svelte: 'svelte', astro: 'astro', md: 'markdown', mdx: 'markdown',
  json: 'data', yaml: 'data', yml: 'data', toml: 'data', sql: 'sql',
  svg: 'image', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image',
}

/** Language bucket → fallback glyph, checked after manifests and text. */
const LANGUAGE_GLYPHS = {
  typescript: { glyph: 'code-simple', why: { zh: 'TypeScript 项目', en: 'TypeScript project' } },
  javascript: { glyph: 'code-simple', why: { zh: 'JavaScript 项目', en: 'JavaScript project' } },
  python: { glyph: 'code', why: { zh: 'Python 项目', en: 'Python project' } },
  ruby: { glyph: 'code', why: { zh: 'Ruby 项目', en: 'Ruby project' } },
  go: { glyph: 'cpu', why: { zh: 'Go 项目', en: 'Go project' } },
  rust: { glyph: 'settings-02', why: { zh: 'Rust 项目', en: 'Rust project' } },
  java: { glyph: 'code', why: { zh: 'Java 项目', en: 'Java project' } },
  kotlin: { glyph: 'android', why: { zh: 'Kotlin 项目', en: 'Kotlin project' } },
  swift: { glyph: 'apple', why: { zh: 'Swift 项目', en: 'Swift project' } },
  objectivec: { glyph: 'apple', why: { zh: 'Objective-C 项目', en: 'Objective-C project' } },
  csharp: { glyph: 'play-circle', why: { zh: 'C# 项目', en: 'C# project' } },
  cpp: { glyph: 'cpu', why: { zh: 'C/C++ 项目', en: 'C/C++ project' } },
  c: { glyph: 'cpu', why: { zh: 'C/C++ 项目', en: 'C/C++ project' } },
  php: { glyph: 'code', why: { zh: 'PHP 项目', en: 'PHP project' } },
  dart: { glyph: 'smart-phone-01', why: { zh: 'Flutter 项目', en: 'Flutter project' } },
  lua: { glyph: 'code', why: { zh: 'Lua 项目', en: 'Lua project' } },
  shell: { glyph: 'terminal', why: { zh: 'Shell 脚本', en: 'Shell scripts' } },
  html: { glyph: 'globe', why: { zh: '静态网页', en: 'Static web page' } },
  css: { glyph: 'palette', why: { zh: '样式项目', en: 'Styles project' } },
  vue: { glyph: 'web-design-01', why: { zh: 'Vue 项目', en: 'Vue project' } },
  svelte: { glyph: 'web-design-01', why: { zh: 'Svelte 项目', en: 'Svelte project' } },
  astro: { glyph: 'browser', why: { zh: 'Astro 站点', en: 'Astro site' } },
  markdown: { glyph: 'note', why: { zh: '笔记与文档', en: 'Notes and docs' } },
  data: { glyph: 'table', why: { zh: '配置与数据', en: 'Config and data' } },
  sql: { glyph: 'database', why: { zh: 'SQL 项目', en: 'SQL project' } },
  image: { glyph: 'camera-01', why: { zh: '图片素材', en: 'Image assets' } },
}

/** Manifest signal → fallback glyph. */
const MANIFEST_GLYPHS = {
  node: LANGUAGE_GLYPHS.javascript,
  python: LANGUAGE_GLYPHS.python,
  rust: LANGUAGE_GLYPHS.rust,
  go: LANGUAGE_GLYPHS.go,
  ruby: LANGUAGE_GLYPHS.ruby,
  java: LANGUAGE_GLYPHS.java,
  kotlin: LANGUAGE_GLYPHS.kotlin,
  php: LANGUAGE_GLYPHS.php,
  swift: LANGUAGE_GLYPHS.swift,
  dart: LANGUAGE_GLYPHS.dart,
  cpp: LANGUAGE_GLYPHS.cpp,
  unity: { glyph: 'play-circle', why: { zh: 'Unity 工程', en: 'Unity project' } },
}

/** The last resort when a folder holds nothing recognizable. */
const DEFAULT_SUGGESTION = { glyph: 'package-01', why: { zh: '通用项目文件夹', en: 'General project folder' } }

/**
 * Collapse whitespace and drop control characters.
 * @param {unknown} value - raw text.
 * @param {number} max - maximum characters kept.
 * @returns {string} the cleaned text.
 */
export function cleanText(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

/**
 * The project folder's own name.
 * @param {string} path - absolute path.
 * @returns {string} the last path segment.
 */
export function baseNameOf(path) {
  if (typeof path !== 'string' || path === '') return ''
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  if (parts.length === 0) return path.startsWith('/') || path.startsWith('\\') ? '/' : ''
  return parts[parts.length - 1]
}

/**
 * A filesystem facade, so the collector can be unit tested in memory.
 * @returns {{list: Function, read: Function, size: Function}} node-backed io.
 */
export function nodeIo() {
  return {
    /** @param {string} dir - directory to list. */
    async list(dir) {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries.map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
    },
    /**
     * @param {string} file - file to read.
     * @param {number} max - bytes to keep.
     */
    async read(file, max) {
      const handle = await open(file, 'r')
      try {
        const buffer = Buffer.alloc(max)
        const { bytesRead } = await handle.read(buffer, 0, max, 0)
        return buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await handle.close()
      }
    },
    /** @param {string} file - file to stat. */
    async size(file) {
      try {
        return (await stat(file)).size
      } catch {
        return -1
      }
    },
  }
}

/**
 * Read a JSON file, tolerating a missing or malformed one.
 * @param {{read: Function}} io - filesystem facade.
 * @param {string} file - absolute path.
 * @returns {Promise<object|null>} the parsed object, or null.
 */
async function readJson(io, file) {
  try {
    const text = await io.read(file, 64 * 1024)
    if (typeof text !== 'string' || text.trim() === '') return null
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Dependency names a `package.json` mentions, deduplicated and lower-cased.
 * @param {object|null} pkg - parsed package.json.
 * @returns {string[]} dependency names.
 */
function packageDependencies(pkg) {
  if (pkg === null) return []
  const names = new Set()
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const group = pkg[field]
    if (group === null || typeof group !== 'object') continue
    for (const name of Object.keys(group)) names.add(name.toLowerCase())
  }
  return [...names]
}

/**
 * Count file extensions into language buckets.
 * @param {readonly {name: string, dir: boolean}[]} entries - directory entries.
 * @returns {Record<string, number>} bucket → count.
 */
function languageCounts(entries) {
  const counts = {}
  for (const entry of entries) {
    if (entry.dir) continue
    const dot = entry.name.lastIndexOf('.')
    if (dot <= 0) continue
    const ext = entry.name.slice(dot + 1).toLowerCase()
    const bucket = EXTENSION_GROUPS[ext]
    if (bucket === undefined) continue
    counts[bucket] = (counts[bucket] ?? 0) + 1
  }
  return counts
}

/**
 * Collect the bounded evidence about one project folder.
 * @param {string} root - absolute project path.
 * @param {{list: Function, read: Function, size: Function}} io - filesystem facade.
 * @returns {Promise<object>} evidence.
 */
export async function collectEvidence(root, io) {
  const evidence = {
    path: typeof root === 'string' ? root : '',
    name: baseNameOf(root),
    packageJson: null,
    dependencies: [],
    scripts: [],
    manifests: [],
    readme: '',
    entries: [],
    languages: {},
    description: '',
    keywords: [],
  }
  let entries = []
  try {
    entries = await io.list(root)
  } catch {
    return evidence
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  // Dotfiles are noise for a prompt (except the ones above that matter).
  const meaningful = entries.filter((entry) => !IGNORED_ENTRIES.has(entry.name) && !entry.name.startsWith('.'))
  evidence.entries = meaningful.slice(0, MAX_TOP_ENTRIES).map((entry) => (entry.dir ? `${entry.name}/` : entry.name))
  const languages = languageCounts(meaningful.slice(0, 400))
  // Top-level files rarely reveal what a project is made of — most code lives
  // one directory down (src/, app/, lib/), so that level is sampled too.
  for (const dir of meaningful.filter((entry) => entry.dir).slice(0, 6)) {
    let nested = []
    try {
      nested = await io.list(`${root}/${dir.name}`)
    } catch {
      continue
    }
    const sampled = nested.filter((entry) => !entry.dir && !IGNORED_ENTRIES.has(entry.name) && !entry.name.startsWith('.'))
    for (const [bucket, count] of Object.entries(languageCounts(sampled.slice(0, 80)))) {
      languages[bucket] = (languages[bucket] ?? 0) + count
    }
  }
  evidence.languages = languages

  const pkg = await readJson(io, `${root}/package.json`)
  if (pkg !== null) {
    evidence.packageJson = pkg
    evidence.dependencies = packageDependencies(pkg)
    evidence.description = cleanText(pkg.description, 240)
    evidence.keywords = Array.isArray(pkg.keywords)
      ? pkg.keywords.filter((word) => typeof word === 'string').slice(0, 12)
      : []
    evidence.scripts = pkg.scripts !== null && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts).slice(0, 16) : []
  }

  for (const manifest of MANIFESTS) {
    if (manifest.file === 'package.json') continue
    if (manifest.file.startsWith('*.')) {
      const suffix = manifest.file.slice(1)
      const hit = meaningful.find((entry) => !entry.dir && entry.name.endsWith(suffix))
      if (hit !== undefined) evidence.manifests.push({ file: hit.name, signal: manifest.signal, head: '' })
      continue
    }
    const present = meaningful.some((entry) => !entry.dir && entry.name === manifest.file)
    if (!present) continue
    let head = ''
    try {
      head = cleanText(await io.read(`${root}/${manifest.file}`, MANIFEST_HEAD_BYTES), 700)
    } catch {
      head = ''
    }
    evidence.manifests.push({ file: manifest.file, signal: manifest.signal, head })
  }

  for (const candidate of README_FILES) {
    const present = meaningful.some((entry) => !entry.dir && entry.name === candidate)
    if (!present) continue
    try {
      evidence.readme = cleanText(await io.read(`${root}/${candidate}`, 8 * 1024), README_CHARS)
    } catch {
      evidence.readme = ''
    }
    break
  }

  return evidence
}

/**
 * The most common language bucket, when it is meaningful.
 * @param {Record<string, number>} languages - bucket → count.
 * @returns {{bucket: string, count: number}|null} the dominant bucket.
 */
function dominantLanguage(languages) {
  let best = null
  let total = 0
  for (const [bucket, count] of Object.entries(languages)) {
    total += count
    if (best === null || count > best.count) best = { bucket, count }
  }
  if (best === null) return null
  // A single stray file is not a language signal.
  if (best.count < 2 && total < 4) return null
  if (best.bucket === 'data' || best.bucket === 'markdown') return null
  return best
}

/**
 * Choose an icon from the evidence without calling a model.
 *
 * This is both the fallback when the model is unavailable and the guard that
 * keeps the feature useful offline: it only ever returns a name from the
 * bundled catalog.
 *
 * @param {object} evidence - result of {@link collectEvidence}.
 * @returns {{glyph: string, why: {zh: string, en: string}}} a suggestion.
 */
export function heuristicSuggestion(evidence) {
  const dependencies = Array.isArray(evidence?.dependencies) ? evidence.dependencies : []
  const haystack = [
    evidence?.name ?? '',
    evidence?.description ?? '',
    ...(Array.isArray(evidence?.keywords) ? evidence.keywords : []),
    ...(Array.isArray(evidence?.entries) ? evidence.entries : []),
    evidence?.readme ?? '',
    ...(Array.isArray(evidence?.manifests) ? evidence.manifests.map((manifest) => manifest.head) : []),
  ]
    .join(' ')
    .toLowerCase()

  const manifestText = Array.isArray(evidence?.manifests)
    ? evidence.manifests.map((manifest) => manifest.head).join(' ').toLowerCase()
    : ''

  for (const rule of DEPENDENCY_RULES) {
    for (const dependency of dependencies) {
      if (rule.match.includes(dependency)) return { glyph: rule.glyph, why: rule.why }
    }
    // requirements.txt, pyproject and friends list packages without a
    // package.json, so their head text is matched too (short tokens like "pg"
    // or "ws" would only produce noise there).
    for (const token of rule.match) {
      if (token.length >= 3 && manifestText.includes(token)) return { glyph: rule.glyph, why: rule.why }
    }
  }

  for (const rule of TEXT_RULES) {
    if (rule.match.test(haystack)) return { glyph: rule.glyph, why: rule.why }
  }

  const dominant = dominantLanguage(evidence?.languages ?? {})
  if (dominant !== null && LANGUAGE_GLYPHS[dominant.bucket] !== undefined) {
    return LANGUAGE_GLYPHS[dominant.bucket]
  }

  const manifests = Array.isArray(evidence?.manifests) ? evidence.manifests : []
  for (const manifest of manifests) {
    const mapped = MANIFEST_GLYPHS[manifest.signal]
    if (mapped !== undefined) return { glyph: mapped.glyph, why: mapped.why }
  }

  return DEFAULT_SUGGESTION
}

/**
 * Render the evidence as compact prompt text.
 * @param {object} evidence - result of {@link collectEvidence}.
 * @returns {string} a few short lines.
 */
export function describeEvidence(evidence) {
  const lines = []
  lines.push(`folder: ${evidence.name || '(unknown)'}`)
  if (evidence.description !== '') lines.push(`description: ${evidence.description}`)
  if (evidence.keywords.length > 0) lines.push(`keywords: ${evidence.keywords.join(', ')}`)
  const manifests = evidence.manifests.map((manifest) => manifest.file)
  if (manifests.length > 0) lines.push(`manifests: ${manifests.join(', ')}`)
  if (evidence.dependencies.length > 0) {
    const names = [...evidence.dependencies].sort().slice(0, 45)
    lines.push(`dependencies: ${names.join(', ')}`)
  }
  if (evidence.scripts.length > 0) lines.push(`npm scripts: ${evidence.scripts.join(', ')}`)
  if (evidence.entries.length > 0) lines.push(`top level: ${evidence.entries.slice(0, 28).join('  ')}`)
  const languages = Object.entries(evidence.languages)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([bucket, count]) => `${bucket}(${count})`)
  if (languages.length > 0) lines.push(`file types: ${languages.join(', ')}`)
  if (evidence.readme !== '') lines.push(`readme: ${evidence.readme}`)
  for (const manifest of evidence.manifests) {
    if (manifest.head !== '') lines.push(`${manifest.file}: ${manifest.head}`)
  }
  return lines.join('\n')
}

/**
 * Build the two messages sent to the model.
 * @param {object} evidence - result of {@link collectEvidence}.
 * @param {readonly string[]} glyphNames - allowed icon names.
 * @param {'zh'|'en'} language - language for the one-line reason.
 * @returns {{system: string, user: string}} prompt pair.
 */
export function buildPrompt(evidence, glyphNames, language) {
  const catalog = glyphNames.join(', ')
  const reasonLanguage = language === 'en' ? 'English' : '简体中文'
  const system =
    'You label project folders with one icon. ' +
    'Reply with ONE JSON object and nothing else: {"glyph":"<name>","why":"<reason>"}. ' +
    `The "why" field is at most 12 words in ${reasonLanguage}. ` +
    '"glyph" MUST be one of the allowed names, character for character. ' +
    'Pick the icon that best signals what the project IS, not the technology it happens to use.'
  const user = [`Allowed icon names:\n${catalog}`, '', `Project evidence:\n${describeEvidence(evidence)}`].join('\n')
  return { system, user }
}

/**
 * Extract the first JSON object from a model reply.
 * @param {string} text - raw model text.
 * @returns {{glyph: string, why: string}|null} the parsed answer.
 */
function firstJsonObject(text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1))
          return parsed !== null && typeof parsed === 'object' ? parsed : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Validate a model reply into a suggestion.
 * @param {string} text - raw model text.
 * @param {readonly string[]} glyphNames - allowed icon names.
 * @returns {{glyph: string, why: string}|null} a suggestion, or null.
 */
export function parseSuggestion(text, glyphNames) {
  if (typeof text !== 'string') return null
  const payload = firstJsonObject(text)
  if (payload === null) return null
  const rawGlyph = typeof payload.glyph === 'string' ? payload.glyph.trim().toLowerCase() : ''
  if (rawGlyph === '' || !glyphNames.includes(rawGlyph)) return null
  const why = cleanText(payload.why, 120).replace(/^["“]|["”]$/g, '')
  return { glyph: rawGlyph, why }
}

/**
 * Validate the client's project list into the work to do.
 * @param {unknown} projects - request payload `projects`.
 * @param {number} limit - maximum projects served in one request.
 * @returns {{key: string, path: string, title: string}[]} accepted projects.
 */
export function sanitizeProjects(projects, limit) {
  if (!Array.isArray(projects)) return []
  const accepted = []
  const seen = new Set()
  for (const project of projects) {
    if (accepted.length >= limit) break
    if (project === null || typeof project !== 'object') continue
    const path = typeof project.path === 'string' ? project.path.trim() : ''
    if (path === '' || !path.startsWith('/') || path.includes('\u0000')) continue
    const key = typeof project.key === 'string' && project.key.trim() !== '' ? project.key.trim() : path
    if (seen.has(key)) continue
    seen.add(key)
    const title = cleanText(project.title, 120)
    accepted.push({ key, path, title })
  }
  return accepted
}

/**
 * Read the request language, defaulting to Chinese (the primary audience).
 * @param {unknown} value - request field.
 * @returns {'zh'|'en'} the language.
 */
export function languageOf(value) {
  return value === 'en' ? 'en' : 'zh'
}
