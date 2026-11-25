/**
 * Prompt templates: the execution-mode section is not one fixed text. The
 * built-in block stays the default, and every `.md` file in the plugin's
 * `prompts/` directory becomes one more selectable template — the file's first
 * `# Title` line names it in Settings, the rest of the file is the text that
 * gets fused into every preset's system prompt.
 *
 * Reading the directory happens on the host half only (plugin start, status,
 * recheck) and never inside an assembly: the fusion path receives text.
 *
 * @module dsh-unrestricted/templates
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXECUTION_MODE_BLOCK } from './rules.js'

/** Reserved id of the built-in block; no template file may claim it. */
export const ORIGINAL_TEMPLATE_ID = 'original'

/** Id used when nothing else is configured. */
export const DEFAULT_TEMPLATE_ID = ORIGINAL_TEMPLATE_ID

/** Upper bound on one template file, so a stray log file cannot be fused in. */
const MAX_TEMPLATE_BYTES = 512 * 1024

/**
 * The directory shipped next to `src/`. Users drop `.md` files here and pick
 * them in Settings after pressing Re-check.
 * @returns the absolute template directory path.
 */
export function defaultTemplateDir() {
  return fileURLToPath(new URL('../prompts/', import.meta.url))
}

/**
 * Split one template file into its display title and its body.
 * @param {string} source - the file's raw text.
 * @returns `{ title, text }`; `title` is undefined when the file does not open with `# Title`.
 */
export function parseTemplate(source) {
  const normalized = String(source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  const lines = normalized.split('\n')
  let title
  if (/^#\s+\S/.test(lines[0] ?? '')) {
    title = lines[0].replace(/^#\s+/, '').trim()
    lines.shift()
  }
  return { title, text: lines.join('\n').trim() }
}

/**
 * The built-in execution-mode block, shaped like a file template so one list
 * serves the whole card. Its text is the source constant, never a copy on disk.
 * @returns one template entry (`builtin: true`).
 */
export function builtinTemplate() {
  return {
    id: ORIGINAL_TEMPLATE_ID,
    builtin: true,
    title: undefined,
    text: EXECUTION_MODE_BLOCK,
    bytes: Buffer.byteLength(EXECUTION_MODE_BLOCK, 'utf8'),
    lines: EXECUTION_MODE_BLOCK.split('\n').length,
  }
}

/**
 * Read every `.md` file in one directory as a template.
 * @param {string} dir - absolute directory path.
 * @returns `{ templates, problems }` — usable templates in file-name order, plus
 *   one `{ file, message }` per file that could not be used. A missing directory
 *   is a problem, never an exception.
 */
export async function scanTemplates(dir) {
  const templates = []
  const problems = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    problems.push({ file: dir, message: error?.code === 'ENOENT' ? 'template directory not found' : messageOf(error) })
    return { templates, problems }
  }
  const files = entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map(entry => entry.name)
    .sort()
  for (const file of files) {
    const id = file.slice(0, -'.md'.length).trim()
    if (id === '') {
      problems.push({ file, message: 'template id is empty' })
      continue
    }
    if (templates.some(template => template.id === id)) {
      problems.push({ file, message: `id "${id}" is already used by another file` })
      continue
    }
    if (id === ORIGINAL_TEMPLATE_ID) {
      problems.push({ file, message: `id "${ORIGINAL_TEMPLATE_ID}" is reserved for the built-in block` })
      continue
    }
    let source
    try {
      source = await readFile(join(dir, file), 'utf8')
    } catch (error) {
      problems.push({ file, message: messageOf(error) })
      continue
    }
    if (Buffer.byteLength(source, 'utf8') > MAX_TEMPLATE_BYTES) {
      problems.push({ file, message: `larger than ${MAX_TEMPLATE_BYTES} bytes` })
      continue
    }
    const parsed = parseTemplate(source)
    if (parsed.text === '') {
      problems.push({ file, message: 'template body is empty' })
      continue
    }
    templates.push({
      id,
      builtin: false,
      title: parsed.title ?? id,
      file,
      text: parsed.text,
      bytes: Buffer.byteLength(parsed.text, 'utf8'),
      lines: parsed.text.split('\n').length,
    })
  }
  return { templates, problems }
}

/**
 * The full selectable list: the built-in block first, then every template file.
 * The built-in entry is always index 0, so callers may fall back to it.
 * @param {string} [dir] - template directory; defaults to the shipped one.
 * @returns `{ dir, templates, problems }`.
 */
export async function loadTemplates(dir = defaultTemplateDir()) {
  const scanned = await scanTemplates(dir)
  return { dir, templates: [builtinTemplate(), ...scanned.templates], problems: scanned.problems }
}

/** Human-readable error text for a `{ file, message }` problem row. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
