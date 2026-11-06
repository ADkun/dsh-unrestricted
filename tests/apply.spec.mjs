/**
 * Host-half integration tests: `apply()` must fully wire up without throwing on
 * either toggle state. This guards a regression where a merge dropped
 * `resolveAgentPreset()` while keeping its call sites, so enabling the plugin
 * crashed the harness boot at `sweepAgents()` with
 * `ReferenceError: resolveAgentPreset is not defined`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ANCHORS } from '../src/rules.js'
import { apply, name, PLUGIN_VERSION } from '../src/node.js'

/** Minimal fake plugin context: only the services node.js actually touches. */
function fakeContext(minimalSections = [{ name: 'deployment:persona-prefix', text: ANCHORS.personaMinimal }]) {
  const state = { registered: [], listeners: new Map(), sections: minimalSections }
  const agent = {
    ctx: {
      systemPrompt: {
        section(spec) {
          state.registered.push(spec)
          return () => {}
        },
      },
    },
  }
  const presets = {
    async list() { return [{ id: 'minimal', name: 'Minimal' }] },
    composedPreset() { return 'minimal' },
    async acquireScope() { return { key: {}, [Symbol.asyncDispose]: async () => {} } },
    async mount() {},
  }
  const ctx = {
    fiber: {},
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    settings: { configure() {} },
    loader: { await: async () => {} },
    get(service) {
      if (service === 'agentPresets') return presets
      if (service === 'agents') return { list: () => [agent], get: () => agent }
      return undefined
    },
    on(event, fn) {
      state.listeners.set(event, fn)
      return () => {}
    },
    inject() { return () => {} },
    systemPrompt: {
      async assemble() {
        return { sections: state.sections, contexts: [], variables: {} }
      },
    },
  }
  return { ctx, state, agent }
}

test('plugin metadata is exported for Loader diagnostics', () => {
  assert.equal(name, 'dsh-unrestricted')
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+$/)
})

test('apply() with enabled=true wires the sweep without a ReferenceError', async () => {
  const { ctx, state } = fakeContext()
  apply(ctx, { enabled: true })
  // onEnable() -> ensureCheck('minimal').then(sweepAgents()); the sweep must
  // resolve the agent's preset instead of throwing on an undefined helper.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.deepEqual(
    [...state.listeners.keys()].sort(),
    ['agent-preset/selected', 'agent/created', 'agent/disposed', 'loader/volatile-update', 'system-prompt/assemble'],
  )
  assert.equal(state.registered.length, 1, 'minimal agent receives one complete persona shadow')
  assert.equal(state.registered[0].name, 'deployment:persona-prefix')
  assert.equal(state.registered[0].complete, true)
})

test('apply() with enabled=false leaves prompts untouched', async () => {
  const { ctx, state } = fakeContext()
  apply(ctx, { enabled: false })
  await new Promise(resolve => setTimeout(resolve, 50))
  const assemble = state.listeners.get('system-prompt/assemble')
  const original = {
    sections: [{ name: 'deployment:persona-prefix', text: ANCHORS.personaMinimal }],
    contexts: [],
    variables: {},
  }
  const out = await assemble(original, { agent: { ctx: {} } }, async () => original)
  assert.equal(out, original, 'disabled mode returns the original assembly verbatim')
  assert.equal(state.registered.length, 0)
})
