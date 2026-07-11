// ─── GESTURE CONSTANTS ───────────────────────────────────────────────────────

/** Squared distance between Thumb4 and Index8 that triggers a pinch.
 *  Using SQUARED distance avoids Math.sqrt() per frame — eliminates one
 *  Math.sqrt() call per hand per frame (120 sqrt calls/sec saved at 60fps).
 *  Tune empirically: enable debug overlay, watch PINCH DIST readout, set this
 *  to (your_comfortable_pinch_distance)^2. Default ~0.04 in world units. */
export const PINCH_THRESHOLD_SQ = 0.0036   // 0.06^2 — loosened from 0.04 (2026-07-09):
                                            // the tighter threshold was fighting normal
                                            // sensor jitter and dropping pinches. Trade-off:
                                            // looser = more forgiving, but also more prone
                                            // to a resting/relaxed hand pose accidentally
                                            // reading as a pinch. Tune here first if either
                                            // direction feels wrong.

// Phase 5b — EMA smoothing default. Exposed as a live debug-mode slider;
// this is just the starting value. Lower = smoother/laggier, higher = snappier/jitterier.
export const DEFAULT_SMOOTHING_ALPHA = 0.35

/** How many consecutive frames pinch must be held before committing a pane.
 *  8 frames @ 60fps = ~133ms debounce. Prevents false-positive drops from
 *  momentary hand occlusion (a common MediaPipe failure mode). */
export const PINCH_DEBOUNCE_FRAMES = 8

/** Frames pinch must be RELEASED before re-arming. Prevents double-drops. */
export const PINCH_RELEASE_DEBOUNCE = 4

/** Z-offset increment per frozen pane — prevents Z-fighting. */
export const Z_INCREMENT = 0.001

/** Maximum simultaneously frozen panes (circular buffer wraps here). */
export const MAX_PANES = 12

/** If no new landmark frame arrives within this many ms, enter SIGNAL_LOSS.
 *  At 60fps a frame is 16.6ms. 3 missed frames = 50ms is a safe threshold. */
export const STALE_FRAME_MS = 50

// ─── HAND LANDMARK INDICES ───────────────────────────────────────────────────

/** MediaPipe landmark index: thumb tip (same finger regardless of which hand) */
export const THUMB_TIP_IDX = 4
/** MediaPipe landmark index: index finger tip (same finger regardless of which hand) */
export const INDEX_TIP_IDX = 8

// ─── HANDEDNESS ───────────────────────────────────────────────────────────────

/**
 * MediaPipe's handedness classifier assumes a mirrored (selfie-style) input
 * frame. Since this app feeds it a raw, non-mirrored getUserMedia frame, the
 * "theoretical" fix is to swap MediaPipe's raw label (its "Right" is your
 * physical left hand, and vice versa).
 *
 * Empirically confirmed on this camera pipeline: trusting the RAW label
 * (no swap) is what matches reality — lifting your physical left hand moves
 * the LEFT-buffer skeleton. If a different camera/browser ever flips this
 * back the other way, this is the one line to change.
 */
export const MIRROR_HANDEDNESS = false

/** Minimum rectangle width/height (world units) for a pinch-drag to commit
 *  as a real pane, rather than being discarded as an accidental micro-pinch. */
export const MIN_PANE_SIZE = 0.15

/**
 * Full 21-point MediaPipe hand topology, for reference and for anything that
 * needs to loop over "every joint" (debug skeleton, future gesture work).
 *
 *   0            WRIST                                  — 1 point
 *   1, 2, 3, 4   THUMB   (CMC, MCP, IP,  TIP)            — 4 points
 *   5, 6, 7, 8   INDEX   (MCP, PIP, DIP, TIP)            — 4 points
 *   9,10,11,12   MIDDLE  (MCP, PIP, DIP, TIP)            — 4 points
 *  13,14,15,16   RING    (MCP, PIP, DIP, TIP)            — 4 points
 *  17,18,19,20   PINKY   (MCP, PIP, DIP, TIP)            — 4 points
 *  Total: 1 + 4×5 = 21 points. (Thumb has 4 joints, same as every other
 *  finger — it's easy to undercount it because it has no "PIP", but CMC/
 *  MCP/IP/TIP is still four landmarks, 1 through 4.)
 */
export const LANDMARK_NAMES = [
  'WRIST',
  'THUMB_CMC', 'THUMB_MCP', 'THUMB_IP', 'THUMB_TIP',
  'INDEX_MCP', 'INDEX_PIP', 'INDEX_DIP', 'INDEX_TIP',
  'MIDDLE_MCP', 'MIDDLE_PIP', 'MIDDLE_DIP', 'MIDDLE_TIP',
  'RING_MCP', 'RING_PIP', 'RING_DIP', 'RING_TIP',
  'PINKY_MCP', 'PINKY_PIP', 'PINKY_DIP', 'PINKY_TIP',
] as const

/**
 * Standard MediaPipe HAND_CONNECTIONS bone graph — 21 edges connecting the
 * 21 landmarks above into a recognizable hand skeleton. Palm connections
 * (5–9, 9–13, 13–17, 0–17) link the finger bases together instead of routing
 * everything back through the wrist.
 */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],           // index
  [5, 9], [9, 10], [10, 11], [11, 12],      // middle (+ palm: index base → middle base)
  [9, 13], [13, 14], [14, 15], [15, 16],    // ring   (+ palm: middle base → ring base)
  [13, 17], [17, 18], [18, 19], [19, 20],   // pinky  (+ palm: ring base → pinky base)
  [0, 17],                                  // palm closure: wrist → pinky base
]

// ─── BUFFER LAYOUT ───────────────────────────────────────────────────────────

/** Floats per landmark (x, y, z) */
export const FLOATS_PER_LANDMARK = 3

/** Total landmarks per hand */
export const LANDMARKS_PER_HAND = 21

/** Float32Array slots for one hand: 21 × 3 = 63 */
export const FLOATS_PER_HAND = LANDMARKS_PER_HAND * FLOATS_PER_LANDMARK

/** Float32Array slots for the live buffer: 63 × 2 hands = 126 */
export const LIVE_BUFFER_SIZE = FLOATS_PER_HAND * 2

/** Float32Array slots for the frozen pane registry: 126 × MAX_PANES */
export const FROZEN_BUFFER_SIZE = LIVE_BUFFER_SIZE * MAX_PANES

// ─── CAMERA / FRUSTUM ────────────────────────────────────────────────────────

/** Three.js camera field of view (degrees) — must match CoreReactor Canvas prop */
export const CAMERA_FOV = 60

/** Three.js camera Z position — must match CoreReactor Canvas prop */
export const CAMERA_Z = 5

// ─── WEBCAM ──────────────────────────────────────────────────────────────────

export const WEBCAM_CONSTRAINTS: MediaTrackConstraints = {
  width:     { ideal: 1280 },
  height:    { ideal: 720 },
  frameRate: { ideal: 60, max: 60 },
}

// ─── SHADER IDs ──────────────────────────────────────────────────────────────

export const SHADER_IDS = {
  PASSTHROUGH: 0,
  THRESHOLD:   1,
  CRT:         2,
  GLITCH:      3,
  WIREFRAME:   4,
} as const

export type ShaderID = typeof SHADER_IDS[keyof typeof SHADER_IDS]

// ─── CROSSHAIR / PINCH INDICATOR ─────────────────────────────────────────────

/** World-space radius of the pinch crosshair mesh */
export const CROSSHAIR_RADIUS = 0.06

/** How many segments in the crosshair circle geometry */
export const CROSSHAIR_SEGMENTS = 32

/** Z-offset of the crosshair above the live pane (always in front) */
export const CROSSHAIR_Z_OFFSET = 0.01

// ─── PINCH INDICATOR ─────────────────────────────────────────────────────────

/** Radius of the GLSL pinch crosshair mesh in world units */
export const PINCH_INDICATOR_RADIUS = 0.06

/** How many frames to show the "pane dropped" flash animation */
export const PANE_DROP_FLASH_FRAMES = 20

// ─── COMPOSITE BLEND SHADER ──────────────────────────────────────────────────

export const SHADER_IDS_EXT = {
  COMPOSITE: 5,
} as const

/** Frames a live-pane shader transition takes to fully crossfade A→B.
 *  24 frames @ 60fps ≈ 400ms — long enough to read as a deliberate morph,
 *  short enough not to feel laggy against a hand gesture. */
export const SHADER_TRANSITION_FRAMES = 24

// ─── FROZEN PANE RENDER CACHE ────────────────────────────────────────────────

/** Square resolution (px) of the offscreen WebGLRenderTarget a frozen pane's
 *  shader output is baked into once, on freeze / on override change. Frozen
 *  panes display this cached texture afterward instead of re-running their
 *  fragment shader every frame — 512 balances crispness against VRAM at
 *  MAX_PANES concurrent bakes. */
export const FROZEN_BAKE_SIZE = 512
