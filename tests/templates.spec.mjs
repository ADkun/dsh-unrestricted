/**
 * Unit tests for the prompt-template layer: every `prompts/*.md` file becomes
 * one selectable execution-mode section, `original` stays a synthesized
 * built-in (the source block, never a copy on disk), and every fusion entry
 * point accepts a block override without changing its default behavior.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ANCHORS, BLOCK_SECTION, EXECUTION_MODE_BLOCK, contractAdditions, fuseSections, fusedMinimalPrompt } from '../src/rules.js'
import { readTemplate } from '../src/host.js'
import {
  DEFAULT_TEMPLATE_ID, ORIGINAL_TEMPLATE_ID,
  builtinTemplate, defaultTemplateDir, loadTemplates, parseTemplate, scanTemplates,
} from '../src/templates.js'

test('parseTemplate splits the leading # heading from the body', () => {
  assert.deepEqual(parseTemplate('# Alpha\nalpha body'), { title: 'Alpha', text: 'alpha body' })
})

test('parseTemplate normalizes a BOM and CRLF line endings', () => {
  assert.deepEqual(parseTemplate('\uFEFF# Beta\r\nbody one\r\nbody two\r\n'), {
    title: 'Beta', text: 'body one\nbody two',
  })
})

test('parseTemplate keeps heading-less files whole with no title', () => {
  assert.deepEqual(parseTemplate('body only'), { title: undefined, text: 'body only' })
  assert.deepEqual(parseTemplate('intro\n# not a heading'), {
    title: undefined, text: 'intro\n# not a heading',
  })
})

test('the built-in template carries the source block under the reserved id', () => {
  const builtin = builtinTemplate()
  assert.equal(builtin.id, ORIGINAL_TEMPLATE_ID)
  assert.equal(builtin.id, DEFAULT_TEMPLATE_ID)
  assert.equal(builtin.builtin, true)
  assert.equal(builtin.text, EXECUTION_MODE_BLOCK)
})

test('scanTemplates reads usable .md files in name order and reports the rest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-unrestricted-templates-'))
  try {
    await writeFile(join(dir, 'b.md'), 'beta body', 'utf8')
    await writeFile(join(dir, 'a.md'), '# Alpha\nalpha body', 'utf8')
    await writeFile(join(dir, 'original.md'), '# Reserved', 'utf8')
    await writeFile(join(dir, 'c.md'), '   \n', 'utf8')
    await writeFile(join(dir, 'notes.txt'), 'not a template', 'utf8')
    const { templates, problems } = await scanTemplates(dir)
    assert.deepEqual(templates.map((entry) => entry.id), ['a', 'b'])
    assert.equal(templates[0].title, 'Alpha')
    assert.equal(templates[0].text, 'alpha body')
    assert.equal(templates[1].title, 'b')
    assert.equal(templates[1].text, 'beta body')
    assert.ok(templates.every((entry) => entry.builtin === false))
    assert.deepEqual(problems, [
      { file: 'c.md', message: 'template body is empty' },
      { file: 'original.md', message: 'id "original" is reserved for the built-in block' },
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('empty and duplicate template ids are refused instead of shadowing a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-unrestricted-templates-'))
  try {
    await writeFile(join(dir, '.md'), '# No name', 'utf8')
    await writeFile(join(dir, 'dup .md'), 'second', 'utf8')
    await writeFile(join(dir, 'dup.md'), 'first', 'utf8')
    const { templates, problems } = await scanTemplates(dir)
    assert.deepEqual(templates.map((entry) => entry.id), ['dup'])
    assert.ok(['first', 'second'].includes(templates[0].text))
    assert.deepEqual(problems.map((problem) => problem.file).sort(), ['.md', 'dup.md'])
    assert.match(problems.find((problem) => problem.file === '.md').message, /empty/)
    assert.match(problems.find((problem) => problem.file === 'dup.md').message, /already used/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an oversized template is rejected without killing the scan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-unrestricted-templates-'))
  try {
    await writeFile(join(dir, 'huge.md'), 'x'.repeat(512 * 1024 + 1), 'utf8')
    await writeFile(join(dir, 'ok.md'), 'fine', 'utf8')
    const { templates, problems } = await scanTemplates(dir)
    assert.deepEqual(templates.map((entry) => entry.id), ['ok'])
    assert.equal(problems.length, 1)
    assert.equal(problems[0].file, 'huge.md')
    assert.match(problems[0].message, /larger than/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing template directory is a problem, never an exception', async () => {
  const { templates, problems } = await scanTemplates(join(tmpdir(), 'dsh-unrestricted-no-such-dir'))
  assert.deepEqual(templates, [])
  assert.equal(problems.length, 1)
  assert.equal(problems[0].message, 'template directory not found')
})

test('loadTemplates puts the built-in block first, then the shipped files', async () => {
  const { dir, templates } = await loadTemplates()
  assert.equal(dir, defaultTemplateDir())
  assert.equal(templates[0].id, ORIGINAL_TEMPLATE_ID)
  assert.equal(templates[0].builtin, true)
  assert.equal(templates[0].text, EXECUTION_MODE_BLOCK)
  const armor = templates.find((entry) => entry.id === 'armor-en')
  assert.ok(armor, 'the shipped armor template is present')
  assert.equal(armor.builtin, false)
  assert.ok(armor.text.startsWith('[OPERATION: STABLE]'))
})

test('fusedMinimalPrompt keeps the built-in block by default', () => {
  const additions = contractAdditions('minimal')
  assert.equal(fusedMinimalPrompt(), ANCHORS.personaMinimal + additions.pointer + '\n\n' + EXECUTION_MODE_BLOCK)
})

test('fusedMinimalPrompt accepts a template block in place of the built-in one', () => {
  const additions = contractAdditions('minimal')
  const fused = fusedMinimalPrompt(ANCHORS.structuredOutputFull, 'TEMPLATE BODY')
  assert.ok(fused.startsWith(ANCHORS.personaMinimal + additions.pointer + '\n\n' + 'TEMPLATE BODY'))
  assert.ok(fused.includes(additions.structuredNote))
  assert.ok(!fused.includes(EXECUTION_MODE_BLOCK))
})

test('fuseSections inserts the built-in block by default and the template block when given', () => {
  const sections = [{ name: 'deployment:persona-prefix', text: ANCHORS.personaMinimal }]
  const plain = fuseSections(sections, 'minimal', { isSubagent: true })
  assert.equal(plain.issues, undefined)
  const builtin = plain.sections.find((section) => section.name === BLOCK_SECTION)
  assert.equal(builtin.text, EXECUTION_MODE_BLOCK)

  const templated = fuseSections(sections, 'minimal', { isSubagent: true, block: 'TEMPLATE BODY' })
  assert.equal(templated.issues, undefined)
  const inserted = templated.sections.find((section) => section.name === BLOCK_SECTION)
  assert.equal(inserted.text, 'TEMPLATE BODY')
  assert.equal(templated.sections[0].text, ANCHORS.personaMinimal + contractAdditions('minimal').pointer)
})

test('readTemplate trims the configured id and tolerates missing or malformed shapes', () => {
  assert.equal(readTemplate({ template: ' armor-en ' }), 'armor-en')
  assert.equal(readTemplate({ get: () => ({ template: 'armor-en' }) }), 'armor-en')
  assert.equal(readTemplate({}), undefined)
  assert.equal(readTemplate({ template: '   ' }), undefined)
  assert.equal(readTemplate({ template: 42 }), undefined)
  assert.equal(readTemplate(undefined), undefined)
})

test('the injected rule section is literal so template prose never hits the interpolator', () => {
  const sections = [{ name: 'deployment:persona-prefix', text: ANCHORS.personaMinimal }]
  const plain = fuseSections(sections, 'minimal', { isSubagent: true })
  assert.equal(plain.sections.find((section) => section.name === BLOCK_SECTION).interpolate, false)

  // A template is user prose: `{{ bad name }}` or an unknown variable would make
  // the host renderPrompt throw and break every request, so the section opts out.
  const templated = fuseSections(sections, 'minimal', { isSubagent: true, block: 'RULE {{ bad name }} {{unknown_var}}' })
  assert.equal(templated.sections.find((section) => section.name === BLOCK_SECTION).interpolate, false)
})
