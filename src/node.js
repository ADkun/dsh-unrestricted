/**
 * dsh-unrestricted host half: fuses the unrestricted execution mode into each
 * preset's ORIGINAL system prompt at assembly time and exposes read-only previews.
 *
 * Mechanism (public interfaces only):
 * - A root `system-prompt/assemble` waterfall listener receives every agent's
 *   assembly (unscoped listeners pass the dsh-scope filter). When enabled, it
 *   fuses the preset's sections structurally: extending `deployment:persona-prefix`
 *   in place, inserting the `unrestricted:execution-mode` section right after the
 *   persona, and appending boundary notes to any present `plan:policy`,
 *   `tools:ptc-only`, or `tool:structured_output` sections. Known presets keep
 *   their anchor contract; every other preset id (a user-authored preset, or one
 *   added after this build) fuses generically. Tools, contexts, and variables
 *   pass through untouched; when disabled the listener returns `next()`
 *   verbatim, so the prompt is byte-identical to the unmodified harness.
 * - The inserted section's text is the user-edited execution prompt
 *   (config.customPrompt), defaulting to the built-in block. Markdown files in
 *   prompts/ are read only as editor starting points for that field: the
 *   directory is scanned on status / recheck, never in the waterfall; tools,
 *   plans, and the rest of the prompt stay untouched.
 * - `minimal` registers its persona with `complete: true`, which the registry
 *   restores AFTER the waterfall, so waterfall edits cannot reach it. For
 *   minimal agents (joined, switched via `agent-preset/selected`, or later
 *   created) the plugin shadows `deployment:persona-prefix` at agent scope with
 *   a complete section carrying the fused minimal prompt, and disposes that
 *   shadow immediately if the blank session switches away to another preset.
 * - Rosterless profiles (such as `headless`, `acp`, or `sdk`) mount no
 *   `agentPresets` service; the plugin detects the active host composition
 *   (`ptc` when `tools:ptc-only` is present, otherwise `standard`) and fuses
 *   their assemblies directly.
 * - Anchor failures (startup standing-scope check or any live assembly) leave
 *   that prompt unchanged and surface the issue codes in the settings card.
 *
 * The toggle, the host-brand stripping flag, and the custom execution prompt
 * live in the unrestricted settings namespace (persisted to
 * $DSH_HOME/profiles/web/cordis.patch.yml). All affect the NEXT assembly of any
 * live or future agent — never an in-flight request or a logged session event.
 */
import { loadHost, readEnabled } from './host.js'
import {
  ANCHORS, EXECUTION_MODE_BLOCK, PRESETS, fuseSections, fusedMinimalPrompt, isKnownPreset,
  normalizePromptText, renderPreview, resolveExecutionModeBlock, stripHostIdentityFromAssembly,
} from './rules.js'
import { registerRpcRoutes } from './rpc.js'
import { builtinTemplate, defaultTemplateDir, loadTemplates } from './templates.js'

// Host packages are resolved through the running DSH entry, never through this
// bundle's own `node_modules` (a `link:` install has none). See ./host.js.
const z = loadHost('@deepseek-ai/schemastery')
const systemPromptModule = loadHost('@deepseek-ai/dsh-system-prompt')
const scopeModule = loadHost('@deepseek-ai/dsh-scope')

/**
 * Fallback renderer used only when `@deepseek-ai/dsh-system-prompt` cannot be
 * resolved: joins sections and substitutes the variables that do have values,
 * leaving the rest as literal `{{name}}`. Previews degrade; nothing else does.
 */
function fallbackRender(assembly) {
  return (assembly.sections ?? [])
    .map((section) => {
      if (section.interpolate === false) return section.text
      return String(section.text).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (whole, name) => {
        const value = assembly.variables?.[name]
        return typeof value === 'string' ? value : whole
      })
    })
    .filter((text) => text.length > 0)
    .join('\n\n')
}

const renderPrompt = systemPromptModule?.renderPrompt ?? fallbackRender

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'dsh-unrestricted'

/** Current plugin package version. */
export const PLUGIN_VERSION = '0.5.0'

/** Services required by this plugin (all base-backed profiles provide these). */
export const inject = ['settings', 'systemPrompt', 'loader']

/**
 * The volatile settings: the `enabled` flag and the selected prompt-template
 * id. Built only when schemastery resolves: without it the plugin still runs,
 * but the Settings form and live changes are absent.
 */
export const Config = typeof z?.object === 'function'
  ? z.object({
    enabled: z.boolean().default(false),
    stripHostIdentity: z.boolean().default(false),
    customPrompt: z.string().default(''),
  }).default({ enabled: false, stripHostIdentity: false, customPrompt: '' }).volatile()
  : undefined

/** Human-readable error text for status and RPC error branches. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** RpcResult success branch. */
function ok(value) {
  return { ok: true, value }
}

/** Read the config value whether the host passed a schemastery handle or a plain object. */
function readConfigValue(config) {
  return typeof config?.get === 'function' ? config.get() : (config ?? {})
}

/**
 * @param ctx - plugin context carrying settings, systemPrompt, loader, and
 *   optional agentPresets / connection services.
 */
export function apply(ctx, config) {
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))

  const initialConfig = readConfigValue(config)
  const initialCustomPrompt = normalizePromptText(initialConfig.customPrompt)
  const initialPromptBlock = resolveExecutionModeBlock(initialCustomPrompt)
  const state = {
    active: true,
    enabled: readEnabled(config),
    stripHostIdentity: Boolean(initialConfig.stripHostIdentity),
    customPrompt: initialCustomPrompt,
    promptBlock: initialPromptBlock,
    /** Selectable templates: index 0 is always the built-in block; the rest are editor starting points. */
    templates: [builtinTemplate()],
    /** Directory scanned for markdown template files (editor starting points). */
    templateDir: defaultTemplateDir(),
    /** { file, message } rows for template files that could not be used. */
    templateProblems: [],
    /** presetId -> issue codes; a preset with an empty list is verified. */
    startup: new Map(),
    /** presetId -> in-flight startup check. */
    checking: new Map(),
    /** presetId -> issue codes observed on live assemblies. */
    runtime: new Map(),
    /** Agent -> section disposer for minimal persona shadows. */
    shadows: new Map(),
    /** Minimal agents whose persona was already registered at agent scope by caller. */
    customMinimal: new WeakSet(),
    /** Minimal agents currently being probed for complete-section ownership. */
    probingMinimal: new WeakSet(),
    /** Agents already disposed, guarding async shadow probes against late writes. */
    disposed: new WeakSet(),
    /** Precomputed fused minimal prompt for the active prompt block. */
    fusedMinimal: fusedMinimalPrompt('', initialPromptBlock),
    /** presetId -> last successfully fused top-level live assembly (the deploy preview). */
    fusedText: new Map(),
  }

  /** All known issues for one preset (startup check + live observations). */
  function modeIssues(presetId) {
    return [...state.startup.get(presetId) ?? [], ...state.runtime.get(presetId) ?? []]
  }

  /** Execution-mode section text to fuse into the next assembly. */
  function activeBlock() {
    return state.promptBlock
  }

  /** Whether the user's custom prompt overrides the built-in block. */
  function isCustomPromptActive() {
    return state.customPrompt.trim() !== '' && state.promptBlock !== EXECUTION_MODE_BLOCK
  }

  let templateLoad

  /**
   * Read the template directory on the host half only — started once at apply,
   * then status, preview, recheck. The assembly waterfall never begins a scan;
   * it only awaits one already in flight and receives `activeBlock()` text.
   * @param {boolean} [force] - rescan even when a scan already ran.
   */
  function ensureTemplates(force = false) {
    if (!force && templateLoad !== undefined) return templateLoad
    templateLoad = loadTemplates(defaultTemplateDir()).then((loaded) => {
      state.templateDir = loaded.dir
      state.templates = loaded.templates
      state.templateProblems = loaded.problems
      refreshFusion()
    }).catch((error) => {
      state.templateProblems = [{ file: state.templateDir, message: messageOf(error) }]
    })
    return templateLoad
  }

  /**
   * Drop cached previews and — once minimal has been verified — rebuild its
   * complete persona shadow with the current block text.
   */
  function refreshFusion() {
    if (state.startup.has('minimal')) {
      state.fusedMinimal = modeIssues('minimal').length === 0
        ? fusedMinimalPrompt('', activeBlock())
        : null
    }
    state.fusedText.clear()
  }

  // Start the scan here, before any listener exists: the assembly waterfall may
  // await a scan that is already running, but never begins one itself.
  void ensureTemplates()

  /**
   * Read the standing assembly of a preset using the registry's scope lease
   * (DSH >= 0.2.1) or a temporary mounted scope fallback. In rosterless
   * profiles, assemble the global host layer directly.
   */
  async function presetAssembly(presetId) {
    // 预设声明与本插件是并列 Loader 条目；服务可用时，声明仍可能尚未注册。
    await ctx.loader.await()
    const presets = ctx.get('agentPresets')
    if (presets === undefined) {
      return await ctx.systemPrompt.assemble({})
    }
    if (typeof presets.acquireScope === 'function') {
      const lease = await presets.acquireScope(presetId)
      try {
        return await ctx.systemPrompt.assemble({ scope: lease.key })
      } finally {
        await lease[Symbol.asyncDispose]()
      }
    }
    const createScope = scopeModule?.createScope
    if (typeof createScope !== 'function') {
      // No scope primitive available: probe the standing global assembly.
      return await ctx.systemPrompt.assemble({})
    }
    const key = {}
    const scope = createScope(ctx, key)
    try {
      await presets.mount(scope.ctx, presetId)
      return await ctx.systemPrompt.assemble({ scope: key })
    } finally {
      await scope.dispose()
    }
  }

  /**
   * Enumerate every preset this profile can run, so the card and the checks
   * cover presets added after this build (a user-authored preset, or any
   * future one) instead of the four ids compiled into {@link PRESETS}.
   * @returns rows of `{ id, name, known, broken }`, the shipped ids first.
   */
  async function presetRoster() {
    const rows = new Map()
    for (const id of PRESETS) rows.set(id, { id, name: undefined, known: true })
    const presets = ctx.get('agentPresets')
    if (presets !== undefined && typeof presets.list === 'function') {
      try {
        await ctx.loader.await()
        for (const preset of await presets.list()) {
          rows.set(preset.id, {
            id: preset.id,
            name: preset.name ?? preset.description,
            known: isKnownPreset(preset.id),
            broken: preset.broken,
          })
        }
      } catch {
        // A roster read is a convenience; the shipped ids still fuse.
      }
    }
    return [...rows.values()]
  }

  /** All preset ids currently in the roster (shipped ids always included). */
  async function presetIds() {
    return (await presetRoster()).map(row => row.id)
  }

  /**
   * Run the standing-scope anchor check for ONE preset (lazy per-preset, so a
   * minimal toggle never waits on the other three mounts). Idempotent per
   * preset until `recheck` clears it.
   */
  function ensureCheck(presetId) {
    let pending = state.checking.get(presetId)
    if (pending !== undefined) return pending
    pending = (async () => {
      const issues = []
      try {
        await ensureTemplates()
        await ctx.loader.await()
        const presets = ctx.get('agentPresets')
        if (presets === undefined) {
          // Rosterless profile (e.g. headless / sdk): live assembly checks the
          // host sections directly.
          state.startup.set(presetId, issues)
          return
        }
        const assembly = await presetAssembly(presetId)
        const fused = fuseSections(assembly.sections, presetId, { block: activeBlock() })
        if (fused.issues !== undefined) issues.push(...fused.issues)
      } catch (error) {
        issues.push(`preset probe failed: ${messageOf(error)}`)
      }
      state.startup.set(presetId, issues)
      if (presetId === 'minimal') {
        state.fusedMinimal = issues.length === 0 ? fusedMinimalPrompt('', activeBlock()) : null
      }
    })().catch((error) => {
      state.startup.set(presetId, [`preset probe failed: ${messageOf(error)}`])
      if (presetId === 'minimal') state.fusedMinimal = null
    })
    state.checking.set(presetId, pending)
    return pending
  }

  /** Check every preset in the roster once (status surface and `recheck`). */
  async function ensureChecks() {
    await Promise.all((await presetIds()).map(presetId => ensureCheck(presetId)))
  }

  /**
   * Remove a minimal persona shadow from an agent when it switches preset, is
   * disposed, or unrestricted mode turns off.
   */
  function unshadowMinimal(agent) {
    const dispose = state.shadows.get(agent)
    if (dispose === undefined) return
    state.shadows.delete(agent)
    dispose()
  }

  /**
   * Resolve the composed preset id for a live agent, or infer `ptc`/`standard`
   * when running in a rosterless profile (e.g. headless / sdk).
   */
  function resolveAgentPreset(agent, sections) {
    const presets = ctx.get('agentPresets')
    if (presets !== undefined) {
      try {
        return presets.composedPreset(agent.ctx)
      } catch {
        return undefined // scope chain not readable; leave the agent untouched
      }
    }
    if (sections !== undefined) {
      return sections.some(s => s.name === 'tools:ptc-only' && s.text.trim() !== '')
        ? 'ptc'
        : 'standard'
    }
    return undefined
  }

  /**
   * Determine whether a post-assembly section list belongs to a stock
   * complete-persona minimal agent rather than a custom-persona child override.
   * On DSH >= 0.2.3, `AssembledSection` exposes `order` and `complete`; on
   * DSH <= 0.2.2, a complete assembly restores a single `deployment:persona-prefix`
   * section without `order`.
   */
  function isCompleteMinimalAssembly(sections) {
    const persona = sections.find(section => section.name === 'deployment:persona-prefix')
    if (persona === undefined) return false
    if (typeof persona.order === 'number') return persona.complete === true
    return sections.length === 1
  }

  /**
   * Register the fused complete persona shadow directly on a stock minimal
   * agent. Still handles the duplicate-section error thrown by DSH <= 0.2.2 if
   * a caller registered a persona in the same scope before probing completed.
   */
  function installMinimalShadow(agent) {
    if (!state.active || !state.enabled || state.disposed.has(agent)) return
    if (resolveAgentPreset(agent) !== 'minimal') return
    if (state.shadows.has(agent) || state.customMinimal.has(agent)) return
    let dispose
    try {
      dispose = agent.ctx.systemPrompt.section({
        name: 'deployment:persona-prefix',
        order: 0,
        complete: true,
        interpolate: false,
        text: (context) => {
          const hasStructured = context?.agent?.ctx?.tools
            ?.schemas?.(context.agent)
            ?.some(tool => tool.name === 'structured_output') === true
          return hasStructured
            ? fusedMinimalPrompt(ANCHORS.structuredOutputFull, activeBlock())
            : (state.fusedMinimal ?? fusedMinimalPrompt('', activeBlock()))
        },
      })
    } catch (error) {
      if (messageOf(error) !== 'prompt section "deployment:persona-prefix" is already registered in this scope') throw error
      state.customMinimal.add(agent)
      return
    }
    state.shadows.set(agent, dispose)
  }

  /**
   * Synchronize a minimal agent's complete persona shadow with its current
   * preset and toggle state. Probes the scope read-only (no `agent`/`session`)
   * before installing a shadow so DSH >= 0.2.3's latest-registration-wins rule
   * never overwrites a child subagent's custom non-complete persona.
   */
  function syncMinimalShadow(agent) {
    if (!state.active || !state.enabled || state.disposed.has(agent)) {
      unshadowMinimal(agent)
      return
    }
    const presetId = resolveAgentPreset(agent)
    if (presetId !== 'minimal') {
      unshadowMinimal(agent)
      return
    }
    if (state.shadows.has(agent) || state.customMinimal.has(agent) || state.probingMinimal.has(agent)) return
    state.probingMinimal.add(agent)
    void ctx.systemPrompt.assemble({ scope: agent }).then((assembly) => {
      if (!state.active || !state.enabled || state.disposed.has(agent)) return
      if (resolveAgentPreset(agent) !== 'minimal') return
      if (isCompleteMinimalAssembly(assembly.sections)) {
        installMinimalShadow(agent)
      } else {
        state.customMinimal.add(agent)
      }
    }).catch(() => {
      // Agent or scope disposed while probing; ignore transient error.
    }).finally(() => {
      state.probingMinimal.delete(agent)
    })
  }

  /** Synchronize minimal persona shadows across all live agents. */
  function sweepAgents() {
    const agents = ctx.get('agents')
    if (agents === undefined) return
    for (const agent of agents.list()) syncMinimalShadow(agent)
  }

  /** Drop every persona shadow (toggle off or plugin disposal). */
  function clearShadows() {
    for (const [, dispose] of state.shadows) dispose()
    state.shadows.clear()
  }

  function onEnable() {
    void ensureChecks() // fills the status surface in the background
    // The sweep only needs minimal's own check — don't gate it on the rest.
    void ensureCheck('minimal').then(() => sweepAgents())
  }

  function onDisable() {
    clearShadows()
    state.runtime.clear()
    state.fusedText.clear()
  }

  /** Current card view: toggle, version, and per-preset state (roster-driven). */
  async function statusPayload() {
    const modes = {}
    for (const row of await presetRoster()) {
      const issues = modeIssues(row.id)
      modes[row.id] = {
        state: !state.enabled
          ? 'off'
          : !state.startup.has(row.id)
            ? 'checking'
            : issues.length > 0 ? 'failed' : 'active',
        issues,
        name: row.name,
        known: row.known,
        broken: row.broken,
      }
    }
    return {
      enabled: state.enabled,
      stripHostIdentity: state.stripHostIdentity,
      customPrompt: state.customPrompt,
      defaultPrompt: EXECUTION_MODE_BLOCK,
      isCustomPrompt: isCustomPromptActive(),
      version: PLUGIN_VERSION,
      /** Directory scanned for editor-starting-point templates. */
      templateDir: state.templateDir,
      templates: state.templates.map(entry => ({
        id: entry.id,
        builtin: entry.builtin,
        title: entry.title,
        text: entry.text,
        bytes: entry.bytes,
        lines: entry.lines,
      })),
      templateProblems: state.templateProblems,
      modes,
    }
  }

  /** One line-count/byte summary so the preview reports size metadata. */
  function summarize(text) {
    return {
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: text.split('\n').length,
    }
  }

  /**
   * Variables to bind in a standing-scope preview. When a live agent exists,
   * borrow its route and working directory so the card reads a realistic
   * prompt instead of raw slots.
   */
  function previewVariables() {
    const variables = {}
    try {
      const agents = ctx.get('agents')
      const agent = agents?.list?.()[0]
      if (agent !== undefined) {
        variables.provider = agent.options.provider
        variables.model = agent.options.model
        variables.cwd = agent.session.header.cwd
      }
    } catch {
      // No agent service or an unreadable session: literal slots are fine.
    }
    return variables
  }

  /**
   * Build the deploy preview for ONE preset from the same assembly path the
   * live fusion uses. Read-only — never mutates prompt state.
   */
  async function previewFor(presetId) {
    if (typeof presetId !== 'string' || presetId === '') {
      return { presetId, available: false, errorCode: 'unsupported-preset', reason: 'missing preset id' }
    }
    const cached = state.fusedText.get(presetId)
    if (cached !== undefined) {
      return { presetId, available: true, source: 'live', ...summarize(cached) }
    }
    try {
      await ensureTemplates()
      const assembly = await presetAssembly(presetId)
      const fused = presetId === 'minimal'
        ? { sections: [{ name: 'deployment:persona-prefix', text: fusedMinimalPrompt('', activeBlock()), interpolate: false }] }
        : fuseSections(assembly.sections, presetId, { block: activeBlock() })
      if (fused.issues !== undefined) {
        return {
          presetId,
          available: false,
          errorCode: fused.issues.includes('missing-persona') ? 'missing-persona' : 'preview-failed',
          reason: fused.issues.join('; '),
        }
      }
      let previewAssembly = { ...assembly, sections: fused.sections }
      if (state.stripHostIdentity) previewAssembly = stripHostIdentityFromAssembly(previewAssembly)
      const variables = { ...previewAssembly.variables, ...previewVariables() }
      const text = renderPreview({ ...previewAssembly, variables }, renderPrompt)
      return { presetId, available: true, source: 'standing', ...summarize(text) }
    } catch (error) {
      return {
        presetId,
        available: false,
        errorCode: 'preview-failed',
        reason: messageOf(error),
      }
    }
  }

  /** RPC endpoint handler for the settings card. */
  async function handleRpc(endpoint, payload) {
    switch (endpoint) {
      case 'status': {
        await ensureTemplates()
        if (state.enabled) await ensureChecks()
        return ok(await statusPayload())
      }
      case 'preview': {
        // Private channels forward the client payload verbatim; accept the
        // `{ args }` envelope too so this handler survives a caller that
        // follows the gateway convention.
        const presetId = payload?.presetId ?? payload?.args?.presetId
        return ok(await previewFor(presetId))
      }
      case 'recheck': {
        state.checking.clear()
        state.startup.clear()
        state.runtime.clear()
        state.fusedText.clear()
        await ensureTemplates(true)
        await ensureChecks()
        if (state.enabled) sweepAgents()
        return ok(await statusPayload())
      }
      default:
        return {
          ok: false,
          error: {
            code: 'internal',
            message: `dsh-unrestricted: unknown endpoint ${JSON.stringify(endpoint)}`,
            details: {},
          },
        }
    }
  }

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const original = await next()
    if (!state.enabled && !state.stripHostIdentity) return original
    const agent = context.agent
    if (agent === undefined) return original
    const presetId = resolveAgentPreset(agent, original.sections)
    if (presetId === undefined) {
      unshadowMinimal(agent)
      return original
    }

    let current = original

    if (presetId === 'minimal') {
      if (state.enabled) {
        if (!state.shadows.has(agent) && !state.customMinimal.has(agent)) {
          const persona = current.sections.find(section => section.name === 'deployment:persona-prefix')
          if (persona !== undefined && typeof persona.order === 'number') {
            if (persona.complete === true) installMinimalShadow(agent)
            else state.customMinimal.add(agent)
          } else {
            installMinimalShadow(agent)
          }
        }
        if (state.customMinimal.has(agent)) {
          const fused = fuseSections(current.sections, 'minimal', {
            isSubagent: true,
            block: activeBlock(),
          })
          if (fused.issues !== undefined) {
            state.runtime.set('minimal', fused.issues)
            return state.stripHostIdentity ? stripHostIdentityFromAssembly(current) : current
          }
          state.runtime.delete('minimal')
          current = { ...current, sections: fused.sections }
        } else if (state.shadows.has(agent) && state.fusedMinimal !== null) {
          state.fusedText.set('minimal', state.fusedMinimal)
        }
      } else if (state.shadows.has(agent)) {
        unshadowMinimal(agent)
      }
      return state.stripHostIdentity ? stripHostIdentityFromAssembly(current) : current
    }

    if (state.shadows.has(agent)) {
      unshadowMinimal(agent)
    }

    if (state.enabled) {
      const isSubagent = current.contexts.some(entry => entry.name === 'subagent:delegation')
      const fused = fuseSections(current.sections, presetId, {
        isSubagent,
        block: activeBlock(),
      })
      if (fused.issues !== undefined) {
        state.runtime.set(presetId, fused.issues)
        return state.stripHostIdentity ? stripHostIdentityFromAssembly(current) : current
      }
      state.runtime.delete(presetId)
      current = { ...current, sections: fused.sections }
      // Keep the deployed top-level fusion available for the card's live preview.
      // Subagents may carry custom personas, so they do not overwrite it.
      if (!isSubagent) {
        try {
          state.fusedText.set(presetId, renderPreview({ ...original, sections: fused.sections }, renderPrompt))
        } catch {
          state.fusedText.delete(presetId)
        }
      }
    }

    return state.stripHostIdentity ? stripHostIdentityFromAssembly(current) : current
  })

  ctx.on('agent/created', ({ agent }) => {
    if (!state.enabled) return
    // Only minimal's own check gates the shadow — never the other presets'.
    void ensureCheck('minimal').then(() => syncMinimalShadow(agent))
  })

  ctx.on('agent-preset/selected', (sessionId) => {
    const agent = ctx.get('agents')?.get?.(sessionId)
    if (agent === undefined) return
    state.customMinimal.delete(agent)
    if (!state.enabled) {
      unshadowMinimal(agent)
      return
    }
    void ensureCheck('minimal').then(() => syncMinimalShadow(agent))
  })

  ctx.on('agent/disposed', ({ agent }) => {
    state.disposed.add(agent)
    state.customMinimal.delete(agent)
    unshadowMinimal(agent)
  })

  ctx.effect(() => {
    const unwatch = ctx.on('loader/volatile-update', () => {
      const nextConfig = readConfigValue(config)
      const enabled = Boolean(nextConfig.enabled)
      const nextCustomPrompt = normalizePromptText(nextConfig.customPrompt)
      state.stripHostIdentity = Boolean(nextConfig.stripHostIdentity)
      const promptChanged = nextCustomPrompt !== state.customPrompt
      state.customPrompt = nextCustomPrompt
      state.promptBlock = resolveExecutionModeBlock(nextCustomPrompt)
      if (promptChanged) refreshFusion()
      if (enabled === state.enabled) return
      state.enabled = enabled
      if (enabled) onEnable()
      else onDisable()
    })
    if (state.enabled) onEnable()
    return () => {
      state.active = false
      state.enabled = false
      unwatch()
      clearShadows()
    }
  }, 'dsh-unrestricted: toggle lifecycle')

  // Web/Desktop 状态通道由官方 Connection 认证；headless 组合无需提供 connection 服务。
  ctx.inject(['connection'], (connectionCtx) => registerRpcRoutes(connectionCtx.connection, handleRpc))
}