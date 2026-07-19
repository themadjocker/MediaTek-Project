/**
 * NeuralLink.tsx  —  Phase 2: Full Tracking Implementation
 *
 * Responsibilities:
 *  1. Run MediaPipe HandLandmarker in a requestAnimationFrame loop
 *  2. Write pre-normalized world-space landmarks into liveBuffer (zero React)
 *  3. Maintain lastKnownBuffer so CoreReactor never collapses to (0,0,0)
 *  4. Write frameTimestamp + handPresence for stale-frame detection
 *  5. Transition boot phase state machine (ACTIVE → TRACKING ⇄ SIGNAL_LOSS)
 *
 * React re-renders emitted by this component: ZERO
 * Heap allocations per tracking frame: ZERO (pre-allocated scratch buffers)
 */

import { useEffect, useRef } from 'react'
import { useUIStore }        from '@stores/useUIStore'
import {
  liveBuffer,
  lastKnownBuffer,
  frameTimestamp,
  handPresence,
  landmarkConfidence,
  toWorldSpace,
  LEFT_HAND_OFFSET,
  RIGHT_HAND_OFFSET,
} from '@data/landmarkStore'
import {
  LANDMARKS_PER_HAND,
  MIRROR_HANDEDNESS,
} from '@constants/index'
import { handLandmarker, videoElement } from './BootScreen'

// ─── PRE-ALLOCATED SCRATCH BUFFERS ───────────────────────────────────────────
// Module-level — allocated once, reused every frame. Never inside the loop.

/** Scratch buffer for toWorldSpace output — reused each landmark */
const _wsOut = new Float32Array(3)

export function NeuralLink() {
  const rafRef = useRef<number>(0)

  useEffect(() => {
    // Guard: both singletons must exist (set by BootScreen before NeuralLink mounts)
    if (!handLandmarker || !videoElement) {
      console.warn('[NeuralLink] handLandmarker or videoElement not ready — skipping loop start')
      return
    }

    let lastVideoTime = -1

    // ── rAF Detection Loop ────────────────────────────────────────────────────
    function detect(rafTimestamp: number): void {
      const vid = videoElement!

      // Wait until video has a decoded frame available
      if (vid.readyState >= 2 && vid.currentTime !== lastVideoTime) {
        lastVideoTime = vid.currentTime

        // ── MediaPipe Inference ────────────────────────────────────────────
        // Pass the rAF timestamp directly — this locks MediaPipe's cadence to
        // the display refresh rate, preventing drift on >60Hz displays.
        const results = handLandmarker!.detectForVideo(vid, rafTimestamp)

        const hands     = results.handedness ?? []
        const landmarks = results.landmarks  ?? []
        const worldLms  = results.worldLandmarks ?? []

        // ── Reset presence bitmask ─────────────────────────────────────────
        handPresence[0] = 0

        if (hands.length === 0) {
          // ── SIGNAL LOSS ───────────────────────────────────────────────────
          // DO NOT zero out liveBuffer — leave last known values in place.
          // CoreReactor reads handPresence[0] to know hands are gone.
          // The lastKnownBuffer already holds the last valid frame.

          transitionTo('signal_loss')
        } else {
          // ── HANDS DETECTED ────────────────────────────────────────────────
          for (let h = 0; h < hands.length; h++) {
            const category = hands[h][0]?.categoryName?.toLowerCase() ?? ''

            // See MIRROR_HANDEDNESS in constants — this pipeline feeds MediaPipe
            // a raw (non-mirrored) frame, and empirically the raw label is
            // already correct here, so no swap is applied by default.
            const isLeft     = MIRROR_HANDEDNESS ? category === 'right' : category === 'left'
            const handOffset = isLeft ? LEFT_HAND_OFFSET : RIGHT_HAND_OFFSET
            const handBit    = isLeft ? 0b01 : 0b10

            handPresence[0] |= handBit

            const lms = landmarks[h]
            if (!lms) continue

            // ── Write all 21 landmarks into liveBuffer ─────────────────────
            for (let i = 0; i < LANDMARKS_PER_HAND; i++) {
              const lm = lms[i]
              if (!lm) continue

              // Normalize to Three.js world space — result in _wsOut (no alloc)
              toWorldSpace(lm.x, lm.y, lm.z, _wsOut)

              const base = handOffset + i * 3
              liveBuffer[base]     = _wsOut[0]
              liveBuffer[base + 1] = _wsOut[1]
              liveBuffer[base + 2] = _wsOut[2]
            }

            // Write per-landmark confidence (optional, for debug overlay)
            const wls = worldLms[h]
            if (wls) {
              const confOffset = isLeft ? 0 : LANDMARKS_PER_HAND
              for (let i = 0; i < LANDMARKS_PER_HAND; i++) {
                landmarkConfidence[confOffset + i] = lms[i]?.visibility ?? 1
              }
            }
          }

          // ── Snapshot last-known ONLY when hands are present ────────────────
          // This ensures lastKnownBuffer always holds valid hand positions,
          // never (0,0,0) from a cold boot where no hand has been seen yet.
          lastKnownBuffer.set(liveBuffer)

          transitionTo('tracking')
        }

        // ── Write timestamp for stale-frame detection in CoreReactor ───────
        // Using Float64Array so performance.now() precision is preserved.
        frameTimestamp[0] = performance.now()
      }

      rafRef.current = requestAnimationFrame(detect)
    }

    rafRef.current = requestAnimationFrame(detect)

    return () => {
      cancelAnimationFrame(rafRef.current)
    }
  }, []) // Empty deps — we don't want this to re-run. handLandmarker/videoElement are module singletons.

  return null // Renders nothing
}

// ─── PHASE TRANSITION HELPER ─────────────────────────────────────────────────
// Uses Zustand's getState() — NOT a hook — so it doesn't trigger re-renders
// from inside the rAF loop. Only calls setState when the phase actually changes.

function transitionTo(next: 'active' | 'tracking' | 'signal_loss'): void {
  const store   = useUIStore.getState()
  const current = store.bootPhase

  if (next === 'tracking' && (current === 'ACTIVE' || current === 'SIGNAL_LOSS')) {
    store.setBootPhase('TRACKING')
  } else if (next === 'signal_loss' && current === 'TRACKING') {
    store.setBootPhase('SIGNAL_LOSS')
  }
}
