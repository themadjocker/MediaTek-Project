import React, { memo, useEffect, useRef, useState } from 'react'
import {
  useUIStore,
  selectShaderID,
  selectPaneCount,
  selectDebugMode,
  selectBootPhase,
  selectSignalLostAt,
  selectPanes,
  selectPinchConfirmedAt,
  selectSelectedPaneId,
  selectThreshold,
  selectCrtIntensity,
  selectGlitchAmount,
  type ShaderID,
} from '@stores/useUIStore'
import { SHADER_IDS, MAX_PANES } from '@constants/index'

// ─── Shader maps ──────────────────────────────────────────────────────────────

const SHADER_LABELS: Record<ShaderID, string> = {
  [SHADER_IDS.PASSTHROUGH]: 'PASS',
  [SHADER_IDS.THRESHOLD]:   'THRSH',
  [SHADER_IDS.CRT]:         'CRT',
  [SHADER_IDS.GLITCH]:      'GLITCH',
  [SHADER_IDS.WIREFRAME]:   'WIRE',
}

const SHADER_COLORS: Record<ShaderID, string> = {
  [SHADER_IDS.PASSTHROUGH]: '#8A9BB5',
  [SHADER_IDS.THRESHOLD]:   '#00FF41',
  [SHADER_IDS.CRT]:         '#00F5FF',
  [SHADER_IDS.GLITCH]:      '#FF003C',
  [SHADER_IDS.WIREFRAME]:   '#9D00FF',
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export const EncryptedChannel = memo(function EncryptedChannel() {
  const bootPhase    = useUIStore(selectBootPhase)
  const debugMode    = useUIStore(selectDebugMode)
  const toggleDebug  = useUIStore((s) => s.toggleDebug)
  const clearPanes   = useUIStore((s) => s.clearPanes)

  return (
    <div style={overlayStyle}>

      {/* Signal loss banner */}
      {bootPhase === 'SIGNAL_LOSS' && <SignalLossBanner />}

      {/* Pane drop flash notification */}
      <PaneDropFlash />

      {/* Shader selector */}
      <ShaderSelector />

      {/* Uniform sliders — each uses a primitive selector */}
      <UniformSliders />

      {/* Pane registry panel */}
      <PaneRegistry onClear={clearPanes} />

      {/* Controls */}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={toggleDebug}
          style={{
            ...btnStyle,
            borderColor: debugMode ? '#FFAB00' : '#1A2740',
            color:       debugMode ? '#FFAB00' : '#8A9BB5',
          }}
        >
          {debugMode ? '◈ DEBUG ON' : '◈ DEBUG'}
        </button>
      </div>

      <div style={hintStyle}>PINCH &amp; DRAG WITH EITHER HAND TO DRAW A PANE — RELEASE TO DROP</div>
    </div>
  )
})

// ─── Signal loss banner ───────────────────────────────────────────────────────

const SignalLossBanner = memo(function SignalLossBanner() {
  return (
    <div style={signalBannerStyle}>
      <span style={{ animation: 'svp-blink 0.8s step-end infinite' }}>▮</span>
      {' '}SIGNAL LOST — WIREFRAME MODE
      <style>{`@keyframes svp-blink { 50% { opacity: 0; } }`}</style>
    </div>
  )
})

// ─── Pane drop flash notification ────────────────────────────────────────────

const PaneDropFlash = memo(function PaneDropFlash() {
  const pinchConfirmedAt = useUIStore(selectPinchConfirmedAt)
  const paneCount        = useUIStore(selectPaneCount)
  const [visible, setVisible] = useState(false)
  const prevTimestamp    = useRef(0)

  useEffect(() => {
    if (pinchConfirmedAt > prevTimestamp.current) {
      prevTimestamp.current = pinchConfirmedAt
      setVisible(true)
      const t = setTimeout(() => setVisible(false), 600)
      return () => clearTimeout(t)
    }
  }, [pinchConfirmedAt])

  if (!visible) return null

  const isOverwrite = paneCount > MAX_PANES
  return (
    <div style={{
      ...signalBannerStyle,
      borderColor: isOverwrite ? '#FF003C' : '#00FF41',
      color:       isOverwrite ? '#FF003C' : '#00FF41',
      background:  isOverwrite ? 'rgba(255,0,60,0.12)' : 'rgba(0,255,65,0.08)',
      animation:   'svp-fadeout 0.6s ease forwards',
    }}>
      <style>{`@keyframes svp-fadeout { 0%{opacity:1} 70%{opacity:1} 100%{opacity:0} }`}</style>
      {isOverwrite ? '⟳ PANE OVERWRITTEN' : '✓ PANE FROZEN'}
    </div>
  )
})

// ─── Shader selector ──────────────────────────────────────────────────────────

const ShaderSelector = memo(function ShaderSelector() {
  const activeShaderID    = useUIStore(selectShaderID)
  const setActiveShaderID = useUIStore((s) => s.setActiveShaderID)

  return (
    <div style={panelStyle}>
      <div style={labelStyle}>NEXT PANE SHADER</div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {(Object.entries(SHADER_LABELS) as [string, string][]).map(([id, label]) => {
          const sid    = Number(id) as ShaderID
          const active = sid === activeShaderID
          const color  = SHADER_COLORS[sid]
          return (
            <button key={id} onClick={() => setActiveShaderID(sid)} style={{
              background:    active ? `${color}1A` : 'transparent',
              border:        `1px solid ${active ? color : '#1A2740'}`,
              color:         active ? color : '#8A9BB5',
              fontFamily:    'JetBrains Mono, monospace',
              fontSize:      '0.6rem',
              padding:       '0.2rem 0.55rem',
              cursor:        'pointer',
              borderRadius:  '2px',
              letterSpacing: '0.1em',
              transition:    'all 0.12s',
            }}>{label}</button>
          )
        })}
      </div>
    </div>
  )
})

// ─── Uniform sliders — each on its own primitive selector ─────────────────────

const UniformSliders = memo(function UniformSliders() {
  const activeShaderID = useUIStore(selectShaderID)

  if (activeShaderID === SHADER_IDS.PASSTHROUGH ||
      activeShaderID === SHADER_IDS.WIREFRAME) return null

  return (
    <div style={panelStyle}>
      {activeShaderID === SHADER_IDS.THRESHOLD && (
        <ThresholdSlider />
      )}
      {activeShaderID === SHADER_IDS.CRT && (
        <CrtSlider />
      )}
      {activeShaderID === SHADER_IDS.GLITCH && (
        <GlitchSlider />
      )}
    </div>
  )
})

// Each slider subscribes to ONE primitive value — no cascade re-renders
const ThresholdSlider = memo(function ThresholdSlider() {
  const value     = useUIStore(selectThreshold)
  const setUniform = useUIStore((s) => s.setUniform)
  return <Slider label="THRESHOLD" value={value} color="#00FF41" onChange={(v) => setUniform('threshold', v)} />
})

const CrtSlider = memo(function CrtSlider() {
  const value     = useUIStore(selectCrtIntensity)
  const setUniform = useUIStore((s) => s.setUniform)
  return <Slider label="CRT INTENSITY" value={value} color="#00F5FF" onChange={(v) => setUniform('crtIntensity', v)} />
})

const GlitchSlider = memo(function GlitchSlider() {
  const value     = useUIStore(selectGlitchAmount)
  const setUniform = useUIStore((s) => s.setUniform)
  return <Slider label="GLITCH AMOUNT" value={value} color="#FF003C" onChange={(v) => setUniform('glitchAmount', v)} />
})

function Slider({ label, value, color, onChange }: {
  label: string; value: number; color: string; onChange: (v: number) => void
}) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ ...labelStyle, color, marginBottom: 0 }}>{label}</span>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.68rem', color }}>{value.toFixed(2)}</span>
      </div>
      <input type="range" min={0} max={1} step={0.01} value={value} title={label}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: color, cursor: 'pointer' }} />
    </>
  )
}

// ─── Pane registry ────────────────────────────────────────────────────────────

const PaneRegistry = memo(function PaneRegistry({ onClear }: { onClear: () => void }) {
  const count        = useUIStore(selectPaneCount)
  const panes        = useUIStore(selectPanes)
  const selectedId   = useUIStore(selectSelectedPaneId)
  const setSelected  = useUIStore((s) => s.setSelectedPaneId)
  const isWrapping   = count >= MAX_PANES

  return (
    <div style={panelStyle}>
      {/* Counter row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <div>
          <div style={labelStyle}>PANES FROZEN</div>
          <div style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize:   '1.25rem',
            fontWeight: 700,
            color:      isWrapping ? '#FF003C' : '#00F5FF',
            lineHeight: 1,
          }}>
            {count.toString().padStart(2, '0')}
            <span style={{ fontSize: '0.6rem', color: '#8A9BB5', marginLeft: 4 }}>/ {MAX_PANES}</span>
          </div>
        </div>
        <button onClick={onClear} style={{ ...btnStyle, fontSize: '0.55rem', padding: '0.15rem 0.5rem' }}>
          CLEAR ALL
        </button>
      </div>

      {/* Ring buffer fill bar */}
      <div style={{ height: 2, background: '#0A1220', borderRadius: 1, overflow: 'hidden', marginBottom: 6 }}>
        <div style={{
          height:       '100%',
          width:        `${Math.min(100, (count / MAX_PANES) * 100)}%`,
          background:   isWrapping ? '#FF003C' : '#00F5FF',
          transition:   'width 0.25s ease',
          borderRadius: 1,
        }} />
      </div>
      {isWrapping && (
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.52rem', color: '#FF003C', marginBottom: 6, letterSpacing: '0.1em' }}>
          ⟳ CIRCULAR — OLDEST OVERWRITTEN
        </div>
      )}

      {/* Pane list — last 4 panes, scrollable */}
      {panes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 100, overflowY: 'auto' }}>
          {[...panes].reverse().slice(0, 5).map((pane, i) => {
            const color    = SHADER_COLORS[pane.shaderID] ?? '#8A9BB5'
            const label    = SHADER_LABELS[pane.shaderID] ?? '?'
            const isSelected = pane.id === selectedId
            return (
              <button
                key={pane.id}
                onClick={() => setSelected(isSelected ? null : pane.id)}
                style={{
                  display:       'flex',
                  alignItems:    'center',
                  gap:           6,
                  background:    isSelected ? `${color}18` : 'transparent',
                  border:        `1px solid ${isSelected ? color : '#1A2740'}`,
                  borderRadius:  '2px',
                  padding:       '0.2rem 0.5rem',
                  cursor:        'pointer',
                  width:         '100%',
                  textAlign:     'left',
                  transition:    'all 0.1s',
                }}
              >
                <span style={{
                  display:      'inline-block',
                  width:        6,
                  height:       6,
                  borderRadius: '50%',
                  background:   color,
                  flexShrink:   0,
                }} />
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.55rem', color: isSelected ? color : '#8A9BB5', flex: 1 }}>
                  PANE {panes.length - i} — {label}
                </span>
                {isSelected && (
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.5rem', color }}>EDIT</span>
                )}
              </button>
            )
          })}
          {panes.length > 5 && (
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.5rem', color: '#1E3A5F', textAlign: 'center', padding: '0.1rem 0' }}>
              +{panes.length - 5} MORE
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// ─── Styles ───────────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed', top: '1.5rem', right: '1.5rem',
  display: 'flex', flexDirection: 'column', gap: 7,
  zIndex: 100, width: '210px', pointerEvents: 'auto',
}

const panelStyle: React.CSSProperties = {
  background: '#07080ECC', border: '1px solid #1A2740',
  borderRadius: '4px', padding: '0.65rem 0.85rem', backdropFilter: 'blur(12px)',
}

const signalBannerStyle: React.CSSProperties = {
  background: 'rgba(255,0,60,0.1)', border: '1px solid #FF003C',
  borderRadius: '4px', padding: '0.4rem 0.7rem',
  fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem',
  letterSpacing: '0.12em', color: '#FF003C',
}

const labelStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace', fontSize: '0.55rem',
  letterSpacing: '0.22em', color: '#8A9BB5',
  marginBottom: '0.4rem', textTransform: 'uppercase', display: 'block',
}

const btnStyle: React.CSSProperties = {
  background: 'transparent', border: '1px solid #1A2740', color: '#8A9BB5',
  fontFamily: 'JetBrains Mono, monospace', fontSize: '0.6rem',
  padding: '0.28rem 0.7rem', cursor: 'pointer', borderRadius: '2px',
  letterSpacing: '0.12em', flex: 1,
}

const hintStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace', fontSize: '0.58rem',
  color: '#00F5FF', letterSpacing: '0.12em', textAlign: 'center', padding: '0.2rem 0',
  opacity: 0.85,
}
