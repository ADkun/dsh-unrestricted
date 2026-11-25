/**
 * Browser-half controller for the unrestricted card: binds the `unrestricted`
 * settings namespace (the toggle) and polls the host half's private RPC for
 * per-preset fusion state. Mirrors the card-controller pattern: the apply
 * closure owns the controller, the slot inject face hands hooks and callbacks
 * to the component.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ctx.configForms Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** The section stored in the `unrestricted` settings namespace. */
export interface UnrestrictedSettings {
  enabled?: boolean
  /** Selected prompt-template id; `original` is the built-in block. */
  template?: string
}

/** Per-preset fusion state reported by the host half. */
export interface UnrestrictedModeState {
  state: 'off' | 'checking' | 'active' | 'failed'
  issues: string[]
  /** Display name declared by the preset itself (absent for the four shipped ids). */
  name?: string
  /** Whether this build ships an exact-anchor rule for the preset id. */
  known?: boolean
  /** Why the preset failed to activate in this profile, when it did. */
  broken?: string
}

/** One selectable execution-mode template offered by the host half. */
export interface UnrestrictedTemplate {
  id: string
  /** True for the built-in block, which has no file behind it. */
  builtin: boolean
  /** Display name: the file's `# Heading`, else its id. */
  title?: string
  bytes?: number
  lines?: number
}

/** Host status endpoint payload. */
export interface UnrestrictedStatus {
  enabled: boolean
  /** Selected template id as the host resolved it. */
  template: string
  /** Directory `*.md` templates are read from. */
  templateDir?: string
  /** True when the selected id has no file: the built-in block is in use. */
  templateMissing?: boolean
  /** Selectable templates; the built-in block comes first. */
  templates: UnrestrictedTemplate[]
  /** Template files that could not be used. */
  templateProblems?: { file: string; message: string }[]
  modes: Record<string, UnrestrictedModeState>
}

/** Deploy preview for one preset: what switching on would actually assemble. */
export interface UnrestrictedPreview {
  presetId: string
  available: boolean
  /** `live` = bytes a live agent received; `standing` = preset scope, no agent bound. */
  source?: 'live' | 'standing'
  /** Fused prompt text; present when available. */
  text?: string
  bytes?: number
  lines?: number
  /** Why no preview could be built; present when unavailable. */
  reason?: string
}

/** One fetched preview, keyed by preset, plus its in-flight/error state. */
export interface UnrestrictedPreviewEntry {
  status: 'loading' | 'ready' | 'failed'
  preview?: UnrestrictedPreview
  message?: string
}

/** Full view snapshot the card subscribes to. */
export interface UnrestrictedViewSnapshot {
  /** Persisted toggle; undefined until the settings scope first syncs. */
  enabled: boolean
  /** Selected template id from the settings document (immediate, not host-resolved). */
  template: string
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Settings scope sync state. */
  settingsStatus: 'loading' | 'ready' | 'unavailable'
  /** Live host status; null until the first RPC answer. */
  status: UnrestrictedStatus | null
  /** presetId -> fetched deploy preview. */
  previews: Record<string, UnrestrictedPreviewEntry>
  /** 是否仍有设置写入或状态检查尚未完成。 */
  busy: boolean
  /** Last transport/business failure, if any. */
  message?: string
}

/** Minimal RPC wire shape (structural copy of the host RpcResult). */
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** Minimal observable contract consumed by the slot renderer's hook binding. */
export interface UnrestrictedViewSource {
  getSnapshot(): UnrestrictedViewSnapshot
  subscribe(listener: () => void): () => void
}

/** Inject face handed to the card at registration. */
export interface UnrestrictedCardInjected {
  hooks: {
    /** Reactive card view. */
    view: UnrestrictedViewSource
  }
  /** Persist the toggle. */
  setEnabled: (enabled: boolean) => Promise<void>
  /** Persist the selected prompt template. */
  setTemplate: (template: string) => Promise<void>
  /** Flip the persisted toggle (the composer dock button). */
  toggle: () => Promise<void>
  /** Re-run the host-side anchor checks and refresh. */
  recheck: () => Promise<void>
  /** Re-read host status and invalidate cached previews. */
  refresh: () => Promise<void>
  /** Fetch the exact fused prompt this preset would deploy. */
  loadPreview: (presetId: string) => Promise<void>
}

const RPC_CHANNEL = '/api'
const RPC_NAMESPACE = 'dsh-unrestricted'
const SETTINGS_NS = 'unrestricted'
/** Id of the built-in block, which has no file behind it. */
const ORIGINAL_TEMPLATE = 'original'

/** Human-readable error text for the banner. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Create the card controller bound to the calling plugin's context.
 * @param ctx - the browser plugin context (connection + remote + configForms injected).
 * @returns the controller whose face() feeds the slot inject share.
 */
export function createUnrestrictedController(ctx: Context) {
  const connection = ctx.get('connection') as ConnectionHandle
  const settings = ctx.configForms.get<UnrestrictedSettings>(SETTINGS_NS)

  let snapshot: UnrestrictedViewSnapshot = {
    enabled: false,
    template: ORIGINAL_TEMPLATE,
    writable: false,
    settingsStatus: 'loading',
    status: null,
    previews: {},
    busy: false,
  }
  const listeners = new Set<() => void>()
  // 每个预设只接收最近一次请求；清空标记同时废弃所有在途旧预览。
  const previewRequests = new Map<string, symbol>()
  let statusGeneration = 0
  let pendingOperations = 0

  const view: UnrestrictedViewSource = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  function publish(): void {
    const settingsSnapshot = settings.getSnapshot()
    const enabled = settingsSnapshot.value?.enabled === true
    const template = settingsSnapshot.value?.template ?? ORIGINAL_TEMPLATE
    // Both keys change the deployed text, so both void the fetched previews.
    if (enabled !== snapshot.enabled || template !== snapshot.template) invalidatePreviews()
    snapshot = {
      enabled,
      template,
      writable: settingsSnapshot.writable,
      settingsStatus: settingsSnapshot.status,
      status: snapshot.status,
      previews: snapshot.previews,
      busy: pendingOperations > 0,
      message: snapshot.message,
    }
    for (const listener of listeners) listener()
  }

  function invalidatePreviews(): void {
    previewRequests.clear()
    snapshot = { ...snapshot, previews: {} }
  }

  async function call<T>(endpoint: string, payload: unknown): Promise<T> {
    const result = await connection.rpc.call(RPC_CHANNEL, `${RPC_NAMESPACE}/${endpoint}`, payload) as RpcResult<T>
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }

  async function whileBusy(action: () => Promise<void>): Promise<void> {
    pendingOperations++
    publish()
    try {
      await action()
    } finally {
      pendingOperations--
      publish()
    }
  }

  function readStatus(endpoint: 'status' | 'recheck', clearPreviews: boolean): Promise<void> {
    const generation = ++statusGeneration
    return whileBusy(async () => {
      try {
        const status = await call<UnrestrictedStatus>(endpoint, {})
        if (generation !== statusGeneration) return
        if (clearPreviews) invalidatePreviews()
        snapshot = { ...snapshot, status, message: undefined }
      } catch (error) {
        if (generation !== statusGeneration) return
        snapshot = { ...snapshot, message: messageOf(error) }
      }
    })
  }

  function refresh(clearPreviews = false): Promise<void> {
    return readStatus('status', clearPreviews)
  }

  /**
   * Write one settings key, then re-read the host status.
   * @param key - settings key to persist.
   * @param value - new value for that key.
   */
  function writeSetting<K extends keyof UnrestrictedSettings>(
    key: K,
    value: UnrestrictedSettings[K],
  ): Promise<void> {
    return whileBusy(async () => {
      try {
        await settings.set(key, value)
        await refresh(true)
      } catch (error) {
        snapshot = { ...snapshot, message: messageOf(error) }
      }
    })
  }

  function setEnabled(enabled: boolean): Promise<void> {
    return writeSetting('enabled', enabled)
  }

  function setTemplate(template: string): Promise<void> {
    return writeSetting('template', template)
  }

  function recheck(): Promise<void> {
    return readStatus('recheck', true)
  }

  /**
   * Fetch one preset's deploy preview. The card renders the raw fused prompt,
   * so the user reads the exact bytes before switching the mode on.
   * @param presetId - preset id from the card's row.
   */
  async function loadPreview(presetId: string): Promise<void> {
    const request = Symbol(presetId)
    previewRequests.set(presetId, request)
    snapshot = {
      ...snapshot,
      previews: { ...snapshot.previews, [presetId]: { status: 'loading' } },
    }
    publish()
    try {
      const preview = await call<UnrestrictedPreview>('preview', { presetId })
      if (previewRequests.get(presetId) !== request) return
      snapshot = {
        ...snapshot,
        previews: { ...snapshot.previews, [presetId]: { status: 'ready', preview } },
      }
    } catch (error) {
      if (previewRequests.get(presetId) !== request) return
      snapshot = {
        ...snapshot,
        previews: { ...snapshot.previews, [presetId]: { status: 'failed', message: messageOf(error) } },
      }
    }
    publish()
  }

  ctx.effect(
    () => settings.subscribe(publish),
    'dsh-unrestricted: settings mirror',
  )
  // External profile configuration edits commit through the settings service, which
  // forwards one document event per commit regardless of namespace.
  ctx.effect(
    () => ctx.remote.$on('settings/document-updated', (namespace?: string) => {
      if (namespace === undefined || namespace === SETTINGS_NS) void refresh(true)
    }),
    'dsh-unrestricted: settings invalidations',
  )

  publish()
  void refresh()
  return {
    face: (): UnrestrictedCardInjected => ({
      hooks: { view },
      setEnabled,
      setTemplate,
      toggle: () => setEnabled(!snapshot.enabled),
      recheck,
      refresh: () => refresh(true),
      loadPreview,
    }),
  }
}
