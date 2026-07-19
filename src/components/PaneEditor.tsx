import { memo } from 'react'
import {
  useUIStore,
  selectSelectedPaneId,
  selectPanes,
  type ShaderUniforms,
} from '@stores/useUIStore'
import { SHADER_IDS } from '@constants/index'

const SHADER_NAMES: Record<number, string> = {
  [SHADER_IDS.PASSTHROUGH]: 'PASSTHROUGH',
  [SHADER_IDS.THRESHOLD]:   'THRESHOLD',
  [SHADER_IDS.CRT]:         'CRT SCANLINE',
  [SHADER_IDS.GLITCH]:      'GLITCH',
  [SHADER_IDS.WIREFRAME]:   'WIREFRAME',
}

const SHADER_COLORS: Record<number, string> = {
  [SHADER_IDS.PASSTHROUGH]: '#8A9BB5',
  [SHADER_IDS.THRESHOLD]:   '#00FF41',
  [SHADER_IDS.CRT]:         '#00F5FF',
  [SHADER_IDS.GLITCH]:      '#FF003C',
  [SHADER_IDS.WIREFRAME]:   '#9D00FF',
}

export const PaneEditor = memo(function PaneEditor() {
  const selectedId = useUIStore(selectSelectedPaneId)
  if (!selectedId) return null
  return <PaneEditorPanel paneId={selectedId} />
})

function PaneEditorPanel({ paneId }: { paneId: string }) {
  const panes          = useUIStore(selectPanes)
  const pane           = panes.find((p) => p.id === paneId)
  const perUniforms    = useUIStore((s) => s.perPaneUniforms[paneId])
  const setPerUniform  = useUIStore((s) => s.setPerPaneUniform)
  const clearOverrides = useUIStore((s) => s.clearPerPaneUniforms)
  const setSelected    = useUIStore((s) => s.setSelectedPaneId)

  if (!pane) return null

  const shaderColor = SHADER_COLORS[pane.shaderID] ?? '#8A9BB5'
  const shaderName  = SHADER_NAMES[pane.shaderID]  ?? 'UNKNOWN'

  // Uniform config per shader type
  type UniformCfg = { label: string; key: keyof ShaderUniforms; uniformKey: string }
  const uniformConfigs: Record<number, UniformCfg[]> = {
    [SHADER_IDS.THRESHOLD]: [
      { label: 'THRESHOLD',    key: 'threshold',    uniformKey: 'uThreshold' },
    ],
    [SHADER_IDS.CRT]: [
      { label: 'CRT INTENSITY',key: 'crtIntensity', uniformKey: 'uIntensity' },
    ],
    [SHADER_IDS.GLITCH]: [
      { label: 'GLITCH AMOUNT',key: 'glitchAmount', uniformKey: 'uGlitch' },
    ],
  }

  const cfgs = uniformConfigs[pane.shaderID] ?? []

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
        <div>
          <div style={{ ...labelStyle, color: shaderColor }}>{shaderName}</div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.55rem', color: '#8A9BB5' }}>
            PANE #{panes.indexOf(pane) + 1} — ID {pane.id.slice(0, 8)}
          </div>
        </div>
        <button
          onClick={() => setSelected(null)}
          style={{ ...btnStyle, fontSize: '0.75rem', padding: '0 0.4rem', color: '#8A9BB5' }}
        >
          ✕
        </button>
      </div>

      <div style={{ height: 1, background: `${shaderColor}33`, marginBottom: '0.6rem' }} />

      {/* Shader indicator badge */}
      <div style={{
        display: 'inline-block',
        background: `${shaderColor}1A`,
        border: `1px solid ${shaderColor}`,
        color: shaderColor,
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: '0.55rem',
        padding: '0.15rem 0.5rem',
        borderRadius: '2px',
        letterSpacing: '0.12em',
        marginBottom: '0.75rem',
      }}>
        FROZEN WITH: {shaderName}
      </div>

      {/* Per-pane sliders */}
      {cfgs.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cfgs.map(({ label, key }) => {
            // Per-pane override value, falling back to 0.5 if not set
            const val = perUniforms?.[key] ?? 0.5
            return (
              <div key={key}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ ...labelStyle, color: shaderColor, marginBottom: 0 }}>{label}</span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.65rem', color: shaderColor }}>
                    {val.toFixed(2)}
                  </span>
                </div>
                <input
                  type="range" min={0} max={1} step={0.01} title={label}
                  value={val}
                  onChange={(e) => setPerUniform(paneId, key, parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: shaderColor, cursor: 'pointer' }}
                />
              </div>
            )
          })}
        </div>
      ) : (
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem', color: '#1A2740' }}>
          {pane.shaderID === SHADER_IDS.PASSTHROUGH && 'PASSTHROUGH — NO CONTROLS'}
          {pane.shaderID === SHADER_IDS.WIREFRAME   && 'WIREFRAME — AUTO MATERIAL'}
        </div>
      )}

      {/* Z offset info */}
      <div style={{ marginTop: '0.75rem', height: 1, background: '#1A2740' }} />
      <div style={{ marginTop: '0.5rem', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.52rem', color: '#8A9BB5' }}>
        Z-OFFSET: {pane.zOffset.toFixed(4)}
      </div>

      {/* Reset overrides */}
      {perUniforms && Object.keys(perUniforms).length > 0 && (
        <button
          onClick={() => clearOverrides(paneId)}
          style={{ ...btnStyle, marginTop: '0.5rem', width: '100%', color: '#FFAB00', borderColor: '#FFAB00' }}
        >
          RESET OVERRIDES
        </button>
      )}
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  position:       'fixed',
  bottom:         '1.5rem',
  right:          '1.5rem',
  width:          '210px',
  background:     '#07080EEE',
  border:         '1px solid #1A2740',
  borderTop:      '2px solid #9D00FF',
  borderRadius:   '4px',
  padding:        '0.75rem 1rem',
  zIndex:         150,
  backdropFilter: 'blur(12px)',
}

const labelStyle: React.CSSProperties = {
  fontFamily:    'JetBrains Mono, monospace',
  fontSize:      '0.55rem',
  letterSpacing: '0.2em',
  color:         '#8A9BB5',
  marginBottom:  '0.4rem',
  textTransform: 'uppercase',
  display:       'block',
}

const btnStyle: React.CSSProperties = {
  background:    'transparent',
  border:        '1px solid #1A2740',
  color:         '#8A9BB5',
  fontFamily:    'JetBrains Mono, monospace',
  fontSize:      '0.6rem',
  padding:       '0.25rem 0.6rem',
  cursor:        'pointer',
  borderRadius:  '2px',
  letterSpacing: '0.1em',
}

// Needed for React.CSSProperties in .tsx without importing React directly
import React from 'react'
