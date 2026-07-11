/**
 * BootScreen.tsx
 *
 * Handles the BOOT_SCREEN → REQUESTING_CAM → LOADING_WASM state machine.
 * Shown before the WebGL canvas mounts, preventing WASM/WebGL race condition.
 */

import { useEffect, useRef } from 'react'
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { useUIStore, selectBootPhase } from '@stores/useUIStore'
import { WEBCAM_CONSTRAINTS } from '@constants/index'

// Module-level singletons — initialized once here, used in NeuralLink
export let handLandmarker: HandLandmarker | null = null
export let videoElement: HTMLVideoElement | null = null

export function BootScreen() {
  const bootPhase    = useUIStore(selectBootPhase)
  const setBootPhase = useUIStore((s) => s.setBootPhase)
  const hasBooted    = useRef(false)

  useEffect(() => {
    if (hasBooted.current) return
    hasBooted.current = true

    async function boot() {
      try {
        // ── Phase 1: Request camera ──────────────────────────────────────
        setBootPhase('REQUESTING_CAM')
        const stream = await navigator.mediaDevices.getUserMedia({
          video: WEBCAM_CONSTRAINTS,
          audio: false,
        })

        // Attach stream to hidden video element
        const vid = document.createElement('video')
        vid.srcObject = stream
        vid.autoplay  = true
        vid.playsInline = true
        vid.muted = true
        await vid.play()
        videoElement = vid

        // ── Phase 2: Load MediaPipe WASM + model ─────────────────────────
        setBootPhase('LOADING_WASM')

        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
        )

        const delegate = await detectGPUDelegate()

        handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
            delegate,
          },
          numHands:    2,
          runningMode: 'VIDEO',
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence:  0.6,
          minTrackingConfidence:      0.6,
        })

        // ── Phase 3: Hand off to NeuralLink + CoreReactor ────────────────
        setBootPhase('WASM_READY')

        // Small delay to allow CoreReactor to mount and compile shaders
        await new Promise((r) => setTimeout(r, 100))
        setBootPhase('ACTIVE')

      } catch (err) {
        console.error('[BootScreen] Boot failed:', err)
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          setBootPhase('CAM_DENIED')
        }
      }
    }

    boot()
  }, [setBootPhase])

  // ── Render ───────────────────────────────────────────────────────────────

  if (bootPhase === 'CAM_DENIED') {
    return (
      <div style={overlayStyle}>
        <div style={panelStyle}>
          <div style={{ color: '#FF003C', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem', letterSpacing: '0.3em', marginBottom: '1rem' }}>
            ✕ CAMERA ACCESS DENIED
          </div>
          <p style={{ color: '#8A9BB5', fontSize: '0.9rem' }}>
            Spatial Video Panes requires webcam access to track hand gestures.
            Please allow camera permissions and reload the page.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={buttonStyle}
          >
            RELOAD
          </button>
        </div>
      </div>
    )
  }

  const phaseLabel: Record<string, string> = {
    BOOT_SCREEN:   'INITIALIZING...',
    REQUESTING_CAM:'REQUESTING CAMERA ACCESS',
    LOADING_WASM:  'LOADING NEURAL NETWORK',
    WASM_READY:    'CALIBRATING SHADERS',
  }

  return (
    <div style={overlayStyle}>
      <div style={panelStyle}>
        <div style={{ color: '#00FF41', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.7rem', letterSpacing: '0.3em', marginBottom: '1.5rem' }}>
          <span style={{ animation: 'blink 1.2s step-end infinite' }}>█</span>
          {' '}SPATIAL VIDEO PANES // BOOT
        </div>
        <div style={{ color: '#00F5FF', fontFamily: 'JetBrains Mono, monospace', fontSize: '0.85rem', letterSpacing: '0.15em' }}>
          {phaseLabel[bootPhase] ?? 'STANDBY'}
        </div>
        <div style={{ marginTop: '1.5rem', height: '2px', background: '#1A2740', borderRadius: '1px', overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            background: 'linear-gradient(90deg, #FF003C, #00FF41)',
            width: bootPhase === 'LOADING_WASM' ? '66%' : bootPhase === 'WASM_READY' ? '90%' : '33%',
            transition: 'width 0.6s ease',
          }} />
        </div>
      </div>
      <style>{`@keyframes blink { 50% { opacity: 0; } }`}</style>
    </div>
  )
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function detectGPUDelegate(): Promise<'GPU' | 'CPU'> {
  try {
    const canvas  = document.createElement('canvas')
    const gl      = canvas.getContext('webgl2') || canvas.getContext('webgl')
    const isGPU   = !!gl
    console.log(`[BootScreen] GPU delegate: ${isGPU ? 'available' : 'fallback to CPU'}`)
    return isGPU ? 'GPU' : 'CPU'
  } catch {
    return 'CPU'
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: '#030508',
  zIndex: 10,
}

const panelStyle: React.CSSProperties = {
  background: '#0A1220',
  border: '1px solid #1A2740',
  borderTop: '2px solid #00F5FF',
  borderRadius: '4px',
  padding: '2rem 2.5rem',
  minWidth: '320px',
}

const buttonStyle: React.CSSProperties = {
  marginTop: '1.5rem',
  background: 'rgba(255,0,60,0.1)',
  border: '1px solid #FF003C',
  color: '#FF003C',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: '0.75rem',
  letterSpacing: '0.2em',
  padding: '0.5rem 1.5rem',
  cursor: 'pointer',
  borderRadius: '2px',
}
