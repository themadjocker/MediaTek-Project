/**
 * landmarkStore.ts
 *
 * Module-level singleton buffers — NO React state, NO Zustand.
 * NeuralLink writes here; CoreReactor reads inside useFrame.
 * Zero re-renders. Zero per-frame heap allocation.
 *
 * ── Buffer layout (Float32Array, stride = 3) ──────────────────────────────
 *   liveBuffer[0   .. 62 ] = LEFT  hand: 21 landmarks × [x, y, z]
 *   liveBuffer[63  .. 125] = RIGHT hand: 21 landmarks × [x, y, z]
 *
 *   lastKnownBuffer        = copy of liveBuffer as of last valid frame
 *                            (used as freeze-in-place on signal loss)
 *
 *   frozenBuffer[n*126 .. n*126+125] = snapshot of frozen pane n
 *
 * ── Coordinate system ─────────────────────────────────────────────────────
 *   All values in liveBuffer are PRE-NORMALIZED to Three.js world space by
 *   NeuralLink before writing. CoreReactor reads world-space coords directly;
 *   no transform work happens inside useFrame.
 *
 *   MediaPipe → world space transform (applied in NeuralLink):
 *     wx = (1 - nx - 0.5) * frustumWidth     ← mirror X (front camera)
 *     wy = -(ny - 0.5) * frustumHeight
 *     wz = nz                                 ← relative depth, as-is
 */

import {
  LIVE_BUFFER_SIZE,
  FROZEN_BUFFER_SIZE,
  FLOATS_PER_HAND,
  MAX_PANES,
  CAMERA_FOV,
  CAMERA_Z,
} from '@constants/index'

// ─── LIVE TRACKING BUFFER ────────────────────────────────────────────────────

/** Pre-allocated live landmark buffer. NeuralLink writes every frame. */
export const liveBuffer = new Float32Array(LIVE_BUFFER_SIZE)

/** Mirror of liveBuffer — last frame where hands were present.
 *  On SIGNAL_LOSS, CoreReactor falls back to this instead of (0,0,0) collapse. */
export const lastKnownBuffer = new Float32Array(LIVE_BUFFER_SIZE)

/**
 * Phase 5b — exponential-moving-average smoothed copy of the tracking buffer.
 * Raw MediaPipe landmarks jitter frame-to-frame even when a hand is dead
 * still; everything that renders a pane (live preview AND freeze commit)
 * should read from here instead of liveBuffer/lastKnownBuffer directly.
 *
 * Updated once per frame via updateSmoothing() — call BEFORE reading any
 * landmark for rendering that frame.
 */
export const smoothedBuffer = new Float32Array(LIVE_BUFFER_SIZE)
let _smoothingInitialized = false

/**
 * EMA-smooth `source` into smoothedBuffer in place. Zero allocation.
 * First call snaps directly to `source` (no fade-in from a zero buffer).
 *
 * @param source raw frame to smooth toward — pass isSignalLost ? lastKnownBuffer : liveBuffer
 * @param alpha  [0..1] — lower = smoother/laggier, higher = snappier/jitterier
 */
export function updateSmoothing(source: Float32Array, alpha: number): void {
  if (!_smoothingInitialized) {
    smoothedBuffer.set(source)
    _smoothingInitialized = true
    return
  }
  for (let i = 0; i < LIVE_BUFFER_SIZE; i++) {
    smoothedBuffer[i] += (source[i] - smoothedBuffer[i]) * alpha
  }
}

/** Timestamp (performance.now()) of last landmark write.
 *  CoreReactor compares this to detect stale frames without polling MediaPipe. */
export const frameTimestamp = new Float64Array(1)  // Float64 to avoid uint32 overflow issues

/** Which hands were detected in the last MediaPipe frame.
 *  Bitmask: bit 0 = left hand present, bit 1 = right hand present.
 *  0b00 = none, 0b01 = left, 0b10 = right, 0b11 = both */
export const handPresence = new Uint8Array(1)

/** Per-landmark confidence scores [0..1] for both hands (42 values).
 *  Not used in the hot path — available for future debug overlay. */
export const landmarkConfidence = new Float32Array(42)

// ─── FROZEN PANE REGISTRY ────────────────────────────────────────────────────

/** Pre-allocated slab for ALL frozen pane vertex data.
 *  One allocation at startup. Never reallocated during session. */
export const frozenBuffer = new Float32Array(FROZEN_BUFFER_SIZE)

/** Circular write cursor — wraps at MAX_PANES */
let _frozenWriteHead = 0

/** Total panes committed (capped at MAX_PANES for circular overwrite) */
export let frozenPaneCount = 0

/**
 * Snapshot the current smoothedBuffer into the next circular registry slot.
 * Uses smoothedBuffer (not raw liveBuffer) so the frozen pane matches exactly
 * what the user saw on-screen right before the pinch, not a single raw,
 * possibly-jittery sample from that frame.
 * Uses typed-array bulk copy (.set) — GC-free, no object allocation.
 * @returns The slot index written (pass to getFrozenPaneView / React descriptor)
 */
export function commitFrozenPane(): number {
  const slot   = _frozenWriteHead
  const offset = slot * LIVE_BUFFER_SIZE
  frozenBuffer.set(smoothedBuffer, offset)      // O(126) memcpy, zero GC
  _frozenWriteHead = (_frozenWriteHead + 1) % MAX_PANES
  frozenPaneCount  = Math.min(frozenPaneCount + 1, MAX_PANES)
  return slot
}

/**
 * Non-copying subarray view into the frozen registry for slot N.
 * The returned Float32Array shares memory with frozenBuffer.
 */
export function getFrozenPaneView(slot: number): Float32Array {
  const offset = slot * LIVE_BUFFER_SIZE
  return frozenBuffer.subarray(offset, offset + LIVE_BUFFER_SIZE)
}

/**
 * Read a single landmark's world-space [x, y, z] into a pre-allocated output array.
 * Zero allocations — caller provides the output buffer.
 *
 * @param source        liveBuffer or lastKnownBuffer
 * @param handOffset    LEFT_HAND_OFFSET (0) or RIGHT_HAND_OFFSET (63)
 * @param landmarkIndex 0–20 MediaPipe landmark index
 * @param out           Pre-allocated Float32Array(3) to write into
 */
export function readLandmark(
  source: Float32Array,
  handOffset: number,
  landmarkIndex: number,
  out: Float32Array,
): void {
  const base = handOffset + landmarkIndex * 3
  out[0] = source[base]
  out[1] = source[base + 1]
  out[2] = source[base + 2]
}

/** Left hand occupies liveBuffer[0..62] */
export const LEFT_HAND_OFFSET  = 0
/** Right hand occupies liveBuffer[63..125] */
export const RIGHT_HAND_OFFSET = FLOATS_PER_HAND

// ─── COORDINATE TRANSFORM ────────────────────────────────────────────────────

/**
 * Camera frustum dimensions in Three.js world units.
 * Computed once from camera FOV + aspect ratio.
 * NeuralLink writes the frustum; toWorldSpace reads it.
 *
 * Initialization: computed from CAMERA_FOV + CAMERA_Z constants so that
 * the first frame has a valid (non-zero) transform even before CoreReactor
 * calls updateFrustum() from its useEffect.
 */
export const cameraFrustum = (() => {
  const vFovRad = (CAMERA_FOV * Math.PI) / 180
  const h       = 2 * Math.tan(vFovRad / 2) * CAMERA_Z
  // Assume 16:9 aspect ratio as safe default; overwritten on first CoreReactor mount
  const w       = h * (16 / 9)
  return { width: w, height: h, aspect: 16 / 9 }
})()

/**
 * Recompute frustum from live camera properties.
 * Call once in CoreReactor's useEffect when the Three.js camera is available.
 */
export function updateFrustum(fovDeg: number, aspect: number, camZ: number): void {
  const vFovRad         = (fovDeg * Math.PI) / 180
  const h               = 2 * Math.tan(vFovRad / 2) * Math.abs(camZ)
  cameraFrustum.height  = h
  cameraFrustum.width   = h * aspect
  cameraFrustum.aspect  = aspect
}

/**
 * Transform a single MediaPipe normalized landmark to Three.js world space.
 * Pre-applies X-axis mirror correction for front-facing camera.
 *
 * Formula (from blueprint Bottleneck section):
 *   wx = (1 - nx - 0.5) * frustumWidth
 *   wy = -(ny - 0.5) * frustumHeight
 *   wz = nz  (relative depth — use as-is)
 *
 * Called in NeuralLink ONLY — never inside useFrame.
 *
 * @param nx  MediaPipe normalized x [0..1]
 * @param ny  MediaPipe normalized y [0..1]
 * @param nz  MediaPipe normalized z (relative depth)
 * @param out Pre-allocated Float32Array(3) — written in place, zero allocation
 */
export function toWorldSpace(
  nx: number,
  ny: number,
  nz: number,
  out: Float32Array,
): void {
  out[0] = (1 - nx - 0.5) * cameraFrustum.width    // mirror X
  out[1] = -(ny - 0.5)    * cameraFrustum.height
  out[2] = nz
}
