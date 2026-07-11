
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { SHADER_IDS, DEFAULT_SMOOTHING_ALPHA, type ShaderID } from '@constants/index'

// Re-exported so components can `import { type ShaderID } from '@stores/useUIStore'`
export type { ShaderID }

// ─── BOOT PHASE ──────────────────────────────────────────────────────────────

export type BootPhase =
  | 'BOOT_SCREEN'
  | 'REQUESTING_CAM'
  | 'CAM_DENIED'
  | 'LOADING_WASM'
  | 'WASM_READY'
  | 'COMPILING_SHADERS'
  | 'ACTIVE'
  | 'TRACKING'
  | 'SIGNAL_LOSS'

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface PaneDescriptor {
  id:       string
  /** Two opposite corners of the drawn rectangle: [x0,y0,z0, x1,y1,z1].
   *  FrozenPane derives all 4 actual corners (min/max x,y, averaged z)
   *  from these two points — see CoreReactor's pinch-drag-draw mechanic. */
  corners:  [number, number, number, number, number, number]
  shaderID: ShaderID
  zOffset:  number
}

export interface ShaderUniforms {
  threshold:    number
  crtIntensity: number
  glitchAmount: number
}

// ─── STORE ───────────────────────────────────────────────────────────────────

interface UIState {
  bootPhase:    BootPhase
  setBootPhase: (phase: BootPhase) => void

  activeShaderID:    ShaderID
  setActiveShaderID: (id: ShaderID) => void

  uniforms:   ShaderUniforms
  setUniform: <K extends keyof ShaderUniforms>(key: K, value: number) => void

  // Per-pane uniform overrides — keyed by pane id.
  // Lets user tweak a frozen pane's shader intensity post-drop.
  perPaneUniforms:    Record<string, Partial<ShaderUniforms>>
  setPerPaneUniform:  <K extends keyof ShaderUniforms>(paneId: string, key: K, value: number) => void
  clearPerPaneUniforms: (paneId: string) => void

  panes:      PaneDescriptor[]
  addPane:    (pane: PaneDescriptor) => void
  clearPanes: () => void

  debugMode:       boolean
  toggleDebug:     () => void

  // Phase 5b — EMA smoothing coefficient, exposed as a live debug slider.
  // Read via ref in CoreReactor's hot path (same pattern as uniforms).
  smoothingAlpha:    number
  setSmoothingAlpha: (a: number) => void

  liveDistance:    number
  setLiveDistance: (d: number) => void

  signalLostAt:    number | null

  // Timestamp of the last confirmed pane drop (for GLSL flash animation).
  // CoreReactor reads this via ref — no re-render needed.
  pinchConfirmedAt: number
  setPinchConfirmedAt: (t: number) => void

  // Selected pane id for the per-pane editor panel
  selectedPaneId:    string | null
  setSelectedPaneId: (id: string | null) => void
}

export const useUIStore = create<UIState>()(
  subscribeWithSelector((set, get) => ({
    bootPhase:    'BOOT_SCREEN',
    setBootPhase: (phase) => {
      set((s) => ({
        bootPhase:   phase,
        signalLostAt: phase === 'SIGNAL_LOSS' ? performance.now()
                    : phase === 'TRACKING'    ? null
                    : s.signalLostAt,
      }))
    },

    activeShaderID:    SHADER_IDS.PASSTHROUGH,
    setActiveShaderID: (id) => set({ activeShaderID: id }),

    uniforms: {
      threshold:    0.5,
      crtIntensity: 0.6,
      glitchAmount: 0.3,
    },
    setUniform: (key, value) =>
      set((s) => ({ uniforms: { ...s.uniforms, [key]: value } })),

    perPaneUniforms:   {},
    setPerPaneUniform: (paneId, key, value) =>
      set((s) => ({
        perPaneUniforms: {
          ...s.perPaneUniforms,
          [paneId]: { ...s.perPaneUniforms[paneId], [key]: value },
        },
      })),
    clearPerPaneUniforms: (paneId) =>
      set((s) => {
        const next = { ...s.perPaneUniforms }
        delete next[paneId]
        return { perPaneUniforms: next }
      }),

    panes:      [],
    addPane:    (pane) => set((s) => ({ panes: [...s.panes, pane] })),
    clearPanes: () => set({ panes: [], perPaneUniforms: {}, selectedPaneId: null }),

    debugMode:   false,
    toggleDebug: () => set((s) => ({ debugMode: !s.debugMode })),

    smoothingAlpha:    DEFAULT_SMOOTHING_ALPHA,
    setSmoothingAlpha: (a) => set({ smoothingAlpha: a }),

    liveDistance:    0,
    setLiveDistance: (d) => set({ liveDistance: d }),

    signalLostAt: null,

    pinchConfirmedAt:    0,
    setPinchConfirmedAt: (t) => set({ pinchConfirmedAt: t }),

    selectedPaneId:    null,
    setSelectedPaneId: (id) => set({ selectedPaneId: id }),
  }))
)

// ─── SELECTORS — primitive values only ───────────────────────────────────────

export const selectBootPhase       = (s: UIState): BootPhase          => s.bootPhase
export const selectShaderID        = (s: UIState): ShaderID            => s.activeShaderID
export const selectUniforms        = (s: UIState): ShaderUniforms      => s.uniforms
export const selectPanes           = (s: UIState): PaneDescriptor[]    => s.panes
export const selectPaneCount       = (s: UIState): number              => s.panes.length
export const selectDebugMode       = (s: UIState): boolean             => s.debugMode
export const selectSmoothingAlpha  = (s: UIState): number              => s.smoothingAlpha
export const selectLiveDistance    = (s: UIState): number              => s.liveDistance
export const selectSignalLostAt    = (s: UIState): number | null       => s.signalLostAt
export const selectPinchConfirmedAt= (s: UIState): number              => s.pinchConfirmedAt
export const selectSelectedPaneId  = (s: UIState): string | null       => s.selectedPaneId
export const selectPerPaneUniforms = (s: UIState)                      => s.perPaneUniforms

// Per-uniform primitive selectors — SliderPanel subscribes to exactly ONE float.
// Changing threshold does NOT re-render the CRT slider component.
export const selectThreshold    = (s: UIState): number => s.uniforms.threshold
export const selectCrtIntensity = (s: UIState): number => s.uniforms.crtIntensity
export const selectGlitchAmount = (s: UIState): number => s.uniforms.glitchAmount
