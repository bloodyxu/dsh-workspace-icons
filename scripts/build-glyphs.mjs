#!/usr/bin/env node
/**
 * Build the bundled icon table.
 *
 * Presets in the picker are a curated subset of [Hugeicons] (free set,
 * stroke-rounded style, MIT), inlined into `client.js` so the browser half
 * needs no network and no icon package at runtime. The block lives between the
 * `#region hugeicons-glyphs` markers; this script owns that block and nothing
 * else.
 *
 *   node scripts/build-glyphs.mjs                 # regenerate from the package
 *   node scripts/build-glyphs.mjs --check         # verify without the package
 *   node scripts/build-glyphs.mjs --names         # only lib/glyphs.mjs
 *   node scripts/build-glyphs.mjs --source <dir>  # other esm folder
 *
 * The package comes from `npm pack @hugeicons/core-free-icons` (the free set);
 * each `dist/esm/<Name>Icon.js` is an array of `["tag", { props }]` entries.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = join(here, '..', 'client.js')
const NAMES_FILE = join(here, '..', 'lib', 'glyphs.mjs')

const START = '// #region hugeicons-glyphs'
const END = '// #endregion hugeicons-glyphs'
const DEFAULT_SOURCE = '/tmp/hugeicons/package/dist/esm'
const FALLBACK_VERSION = '4.4.0'

/**
 * The curated set, by upstream export name. `id` in the client table is the
 * name without its `Icon` suffix, kebab-cased (`CodeSimpleIcon` → `code-simple`).
 */
const GROUPS = [
  {
    id: 'code',
    icons: [
      'CodeIcon', 'CodeSimpleIcon', 'CodeCircleIcon', 'SourceCodeIcon', 'TerminalIcon', 'CommandLineIcon',
      'GitBranchIcon', 'GitCommitIcon', 'GitMergeIcon', 'Bug01Icon', 'CpuIcon', 'BinaryCodeIcon',
      'Package01Icon', 'PuzzleIcon', 'Settings02Icon', 'Wrench01Icon',
    ],
  },
  {
    id: 'web',
    icons: [
      'BrowserIcon', 'WebValidationIcon', 'GlobeIcon', 'Link01Icon', 'MonitorDotIcon', 'LaptopIcon',
      'ComputerIcon', 'SmartPhone01Icon', 'SmartWatch01Icon', 'RouterIcon', 'Wifi01Icon', 'InternetAntenna01Icon',
      'CloudIcon', 'CloudUploadIcon', 'ChromeIcon', 'WebDesign01Icon',
    ],
  },
  {
    id: 'data',
    icons: [
      'DatabaseIcon', 'Database01Icon', 'TableIcon', 'ColumnInsertIcon', 'ServerIcon', 'HardDriveIcon',
      'SignalIcon', 'ChartLineData01Icon', 'ChartAnalysisIcon', 'BarChartIcon', 'PieChartIcon', 'FunctionIcon',
      'SigmaIcon', 'Calculator01Icon', 'Coins01Icon', 'Exchange01Icon',
    ],
  },
  {
    id: 'design',
    icons: [
      'PaintBrush01Icon', 'PaintBoardIcon', 'PaletteIcon', 'PenTool01Icon', 'PenTool02Icon', 'Cursor01Icon',
      'Shapes01Icon', 'Layout01Icon', 'Layers01Icon', 'HexagonIcon', 'FigmaIcon', 'Image01Icon',
      'Camera01Icon', 'ColorPickerIcon', 'CanvasIcon', 'WebDesign02Icon',
    ],
  },
  {
    id: 'docs',
    icons: [
      'NoteIcon', 'Note01Icon', 'NotebookIcon', 'BookOpen01Icon', 'Book01Icon', 'News01Icon',
      'ClipboardIcon', 'GraduationCapIcon', 'Certificate01Icon', 'LibraryIcon', 'DocumentCodeIcon', 'DocumentValidationIcon',
      'Bookmark01Icon', 'File01Icon', 'File02Icon', 'AiBookIcon',
    ],
  },
  {
    id: 'media',
    icons: [
      'MusicNote01Icon', 'MusicNoteSquare01Icon', 'HeadphonesIcon', 'Mic01Icon', 'SpeakerIcon', 'RadioIcon',
      'DiscIcon', 'GuitarIcon', 'Video01Icon', 'Film01Icon', 'PlayCircleIcon', 'YoutubeIcon',
      'AudioBook01Icon', 'HeadphoneOffIcon', 'ClapperboardIcon', 'CameraVideoIcon',
    ],
  },
  {
    id: 'science',
    icons: [
      'FlaskConicalIcon', 'Atom01Icon', 'Dna01Icon', 'MicroscopeIcon', 'TestTube01Icon', 'BacteriaIcon',
      'Plant01Icon', 'Leaf01Icon', 'Leaf02Icon', 'Rocket01Icon', 'SaturnIcon', 'BrainIcon',
      'ZapIcon', 'FlashIcon', 'CloudSnowIcon', 'TemperatureIcon',
    ],
  },
  {
    id: 'brand',
    icons: [
      'GithubIcon', 'GitlabIcon', 'NpmIcon', 'CodepenIcon', 'CodesandboxIcon', 'GitbookIcon',
      'AppleIcon', 'WindowsNewIcon', 'AndroidIcon', 'DiscordIcon', 'SlackIcon', 'TwitterIcon',
      'Linkedin01Icon', 'Notion01Icon', 'MetaIcon', 'SpotifyIcon',
    ],
  },
  {
    id: 'business',
    icons: [
      'Briefcase01Icon', 'Building01Icon', 'BankIcon', 'Store01Icon', 'Invoice01Icon', 'CreditCardIcon',
      'Wallet01Icon', 'ShoppingCart01Icon', 'UsersIcon', 'Calendar01Icon', 'Mail01Icon', 'Target01Icon',
      'Flag01Icon', 'TrophyIcon', 'GiftIcon', 'PresentationBarChart01Icon',
    ],
  },
  {
    id: 'life',
    icons: [
      'Home01Icon', 'StarIcon', 'HeartIcon', 'FireIcon', 'MoonIcon', 'Sun01Icon',
      'Coffee01Icon', 'Compass01Icon', 'UmbrellaIcon', 'PawPrintIcon', 'CatIcon', 'SparklesIcon',
      'Clock01Icon', 'GamepadIcon', 'Shield01Icon', 'BulbIcon',
    ],
  },
]

const ATTRIBUTE = /([A-Za-z][A-Za-z0-9]*):\s*"([^"]*)"/g
const ENTRY = /\[\s*"([a-z]+)"\s*,\s*\{([^}]*)\}\s*\]/g

/** @returns {string} kebab id for an upstream export name. */
function idOf(name) {
  return name
    .replace(/Icon$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])(\d)/g, '$1-$2')
    .toLowerCase()
}

/** @returns {string[]} the flat id list, in group order. */
function flatIds() {
  return GROUPS.flatMap((group) => group.icons.map(idOf))
}

/**
 * Reduce one icon module to the markup that belongs inside `<svg>`.
 * @param {string} source - module text.
 * @param {string} name - export name, for error messages.
 * @returns {string} the markup.
 */
function innerMarkup(source, name) {
  const entries = []
  ENTRY.lastIndex = 0
  let match
  while ((match = ENTRY.exec(source)) !== null) {
    const tag = match[1]
    const attributes = {}
    ATTRIBUTE.lastIndex = 0
    let attribute
    while ((attribute = ATTRIBUTE.exec(match[2])) !== null) attributes[attribute[1]] = attribute[2]
    entries.push({ tag, attributes })
  }
  if (entries.length === 0) throw new Error(`${name}Icon.js has no drawable entries`)

  const parts = []
  for (const { tag, attributes } of entries) {
    if (tag === 'path') {
      if (typeof attributes.d !== 'string' || attributes.d === '') throw new Error(`${name} has a path without d`)
      parts.push(`<path d="${attributes.d}"/>`)
    } else if (tag === 'circle') {
      parts.push(`<circle cx="${attributes.cx}" cy="${attributes.cy}" r="${attributes.r}"/>`)
    } else if (tag === 'ellipse') {
      parts.push(`<ellipse cx="${attributes.cx}" cy="${attributes.cy}" rx="${attributes.rx}" ry="${attributes.ry}"/>`)
    } else if (tag === 'rect') {
      const radius = attributes.rx !== undefined ? ` rx="${attributes.rx}"` : ''
      parts.push(`<rect x="${attributes.x}" y="${attributes.y}" width="${attributes.width}" height="${attributes.height}"${radius}/>`)
    } else {
      throw new Error(`${name} uses unsupported element <${tag}>`)
    }
  }
  return parts.join('')
}

/**
 * Render the generated block inside `client.js`.
 * @param {Record<string, string>} glyphs - id → markup.
 * @param {string} version - upstream package version.
 * @returns {string} the block body (without the region markers).
 */
function renderBlock(glyphs, version) {
  const groups = GROUPS.map((group) => {
    const ids = group.icons.map(idOf)
    return (
      '      Object.freeze({\n' +
      `        id: '${group.id}',\n` +
      `        icons: Object.freeze([${ids.map((id) => `'${id}'`).join(', ')}]),\n` +
      '      }),'
    )
  }).join('\n')
  const table = flatIds()
    .map((id) => {
      const markup = glyphs[id]
      if (typeof markup !== 'string' || markup === '') throw new Error(`missing markup for ${id}`)
      return `      ${/^[a-z][a-z0-9]*$/.test(id) ? id : `'${id}'`}: '${markup}',`
    })
    .join('\n')

  return [
    '    const HUGEICONS_VERSION = ' + `'${version}'`,
    '',
    '    /** The bundled Hugeicons set, grouped for the picker; ids back the `glyph.<id>` locale keys. */',
    '    const GLYPH_GROUPS = Object.freeze([',
    groups,
    '    ])',
    '',
    '    /** id → the markup inside `<svg>` (stroke-rounded style, 24×24 viewBox). */',
    '    const GLYPHS = Object.freeze({',
    table,
    '    })',
  ].join('\n')
}

/**
 * Render `lib/glyphs.mjs`, the name list the Host half validates against.
 * @param {string} version - upstream package version.
 * @returns {string} the module text.
 */
function renderNamesModule(version) {
  const groups = GROUPS.map((group) => {
    const ids = group.icons.map(idOf)
    return (
      '  Object.freeze({\n' +
      `    id: '${group.id}',\n` +
      `    icons: Object.freeze([${ids.map((id) => `'${id}'`).join(', ')}]),\n` +
      '  }),'
    )
  }).join('\n')

  return [
    '/**',
    ' * The bundled icon names — generated by `scripts/build-glyphs.mjs` from',
    ' * `@hugeicons/core-free-icons`; do not edit by hand.',
    ' *',
    ' * The Host half validates model answers against {@link GLYPH_NAMES}.',
    ' */',
    `export const HUGEICONS_VERSION = '${version}'`,
    '',
    'export const GLYPH_GROUPS = Object.freeze([',
    groups,
    '])',
    '',
    '/** Flat id list, in group order. */',
    'export const GLYPH_NAMES = Object.freeze(GLYPH_GROUPS.flatMap((group) => group.icons))',
    '',
  ].join('\n')
}

/** Guard the curated table itself. @returns {void} */
function assertTable() {
  const ids = flatIds()
  const seen = new Set()
  for (const id of ids) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error(`bad icon id: ${id}`)
    if (seen.has(id)) throw new Error(`duplicate icon id: ${id}`)
    seen.add(id)
  }
  for (const group of GROUPS) {
    if (group.icons.length < 8) throw new Error(`group ${group.id} has too few icons`)
  }
}

/**
 * Read the generated block back out of `client.js` and compare its shape with
 * {@link GROUPS}; this is what `--check` runs, and it needs no icon package.
 * @param {string} client - client.js text.
 * @returns {void}
 */
function assertClientBlock(client) {
  const start = client.indexOf(START)
  const end = client.indexOf(END)
  if (start === -1 || end === -1 || end < start) throw new Error('client.js has no hugeicons-glyphs region to replace')
  const block = client.slice(start, end)

  const version = /const HUGEICONS_VERSION = '([^']+)'/.exec(block)
  if (version === null || !/^\d+\.\d+\.\d+$/.test(version[1])) throw new Error('the block has no usable HUGEICONS_VERSION')

  const groupIds = [...block.matchAll(/\n\s*id: '([a-z0-9-]+)',\n\s*icons: Object\.freeze\(\[([^\]]*)\]\)/g)].map((match) => ({
    id: match[1],
    icons: match[2].split(',').map((part) => part.trim().replace(/^'|'$/g, '')).filter((part) => part !== ''),
  }))
  const expected = GROUPS.map((group) => ({ id: group.id, icons: group.icons.map(idOf) }))
  if (groupIds.length !== expected.length) throw new Error(`the block has ${groupIds.length} groups, expected ${expected.length}`)
  for (let index = 0; index < expected.length; index += 1) {
    if (groupIds[index].id !== expected[index].id) throw new Error(`group ${index} is '${groupIds[index].id}', expected '${expected[index].id}'`)
    if (groupIds[index].icons.join(',') !== expected[index].icons.join(',')) {
      throw new Error(`group '${expected[index].id}' icons drifted from the curated list`)
    }
  }

  const keys = [...block.matchAll(/^ {6}'?([a-z0-9-]+)'?: '/gm)].map((match) => match[1])
  const ids = flatIds()
  if (keys.length !== ids.length) throw new Error(`the block has ${keys.length} glyphs, expected ${ids.length}`)
  for (let index = 0; index < ids.length; index += 1) {
    if (keys[index] !== ids[index]) throw new Error(`glyph ${index} is '${keys[index]}', expected '${ids[index]}'`)
  }
}

/**
 * Read the generated name module back and compare it with {@link GROUPS}.
 * @param {string} names - lib/glyphs.mjs text.
 * @returns {void}
 */
function assertNamesModule(names) {
  const groups = [...names.matchAll(/\n\s*id: '([a-z0-9-]+)',\n\s*icons: Object\.freeze\(\[([^\]]*)\]\)/g)].map((match) => ({
    id: match[1],
    icons: match[2].split(',').map((part) => part.trim().replace(/^'|'$/g, '')).filter((part) => part !== ''),
  }))
  const expected = GROUPS.map((group) => ({ id: group.id, icons: group.icons.map(idOf) }))
  if (JSON.stringify(groups) !== JSON.stringify(expected)) throw new Error('lib/glyphs.mjs is stale — run node scripts/build-glyphs.mjs --names')
}

/**
 * Replace the region inside `client.js`.
 * @param {string} client - client text.
 * @param {string} body - new block body.
 * @returns {string} the patched text.
 */
function splice(client, body) {
  const start = client.indexOf(START)
  const end = client.indexOf(END)
  if (start === -1 || end === -1 || end < start) throw new Error('client.js has no hugeicons-glyphs region to replace')
  const startLineEnd = client.indexOf('\n', start)
  return client.slice(0, startLineEnd + 1) + body + '\n' + client.slice(end)
}

/**
 * Read the upstream package version, falling back to the pinned constant.
 * @param {string} source - esm folder.
 * @returns {Promise<string>} the version.
 */
async function readVersion(source) {
  const manifest = join(source, '..', '..', 'package.json')
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(await readFile(manifest, 'utf8'))
      if (typeof parsed.version === 'string' && /^\d+\.\d+\.\d+$/.test(parsed.version)) return parsed.version
    } catch {
      /* fall through to the pinned version */
    }
  }
  return FALLBACK_VERSION
}

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const namesOnly = args.includes('--names')
const sourceIndex = args.indexOf('--source')
const source = sourceIndex === -1 ? DEFAULT_SOURCE : args[sourceIndex + 1]

try {
  assertTable()
  const client = await readFile(CLIENT_FILE, 'utf8')

  if (checkOnly) {
    assertClientBlock(client)
    const names = await readFile(NAMES_FILE, 'utf8')
    assertNamesModule(names)
    const version = /const HUGEICONS_VERSION = '([^']+)'/.exec(client.slice(client.indexOf(START), client.indexOf(END)))[1]
    console.log(`dsh-workspace-icons: glyph block is current (${flatIds().length} icons, hugeicons ${version})`)
    process.exit(0)
  }

  const version = await readVersion(source)

  if (namesOnly) {
    await writeFile(NAMES_FILE, renderNamesModule(version))
    console.log(`dsh-workspace-icons: wrote lib/glyphs.mjs (${flatIds().length} icon names)`)
    process.exit(0)
  }

  if (!existsSync(source)) {
    console.error(`dsh-workspace-icons: icon sources not found at ${source}`)
    console.error('')
    console.error('  npm pack @hugeicons/core-free-icons --pack-destination /tmp/hugeicons')
    console.error('  mkdir -p /tmp/hugeicons && tar -xzf /tmp/hugeicons/hugeicons-core-free-icons-*.tgz -C /tmp/hugeicons')
    console.error('')
    console.error('then rerun, or pass --source <dir> pointing at the package dist/esm folder.')
    process.exit(1)
  }

  const glyphs = {}
  for (const name of GROUPS.flatMap((group) => group.icons)) {
    const file = join(source, `${name}.js`)
    if (!existsSync(file)) throw new Error(`${name}.js is missing from ${source}`)
    glyphs[idOf(name)] = innerMarkup(await readFile(file, 'utf8'), name)
  }

  await writeFile(CLIENT_FILE, splice(client, renderBlock(glyphs, version)))
  await writeFile(NAMES_FILE, renderNamesModule(version))
  console.log(`dsh-workspace-icons: wrote ${flatIds().length} icons (hugeicons ${version}) into client.js and lib/glyphs.mjs`)
} catch (error) {
  console.error(`dsh-workspace-icons: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
