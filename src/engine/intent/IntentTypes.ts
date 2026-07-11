/**
 * IntentTypes.ts
 *
 * Spatial Vision Engine (SVE) — Phase 3: Intent Engine.
 *
 * "What is the user trying to do?" — answered here, with no knowledge of
 * Three.js, React, or MediaPipe specifically. Only knowledge of hands,
 * pinches, and spatial relationships.
 *
 * ── Architecture boundary ─────────────────────────────────────────────────
 *
 * This layer sits between:
 *   ← Sensor Engine (SensorState: raw positions, presence, confidence)
 *   → Command Engine (Phase 4: dispatchable commands with undo/redo)
 *
 * The Intent Engine observes SensorState every frame and emits one of a
 * small, named set of SEMANTIC EVENTS — things like "the user started
 * pinching" or "the user is dragging". Those events carry enough typed
 * data for the Command Engine to act on them without needing to access
 * SensorState directly. The boundary is intentional: a keyboard shortcut
 * or a mouse event could emit the same semantic events and the Command
 * Engine would be none the wiser.
 *
 * ── Gesture model (1-hand Spatial Marquee) ───────────────────────────────
 *
 * Pinch gesture: Left thumb tip (LM 4) close to Left index tip (LM 8).
 *
 * State machine per hand (LEFT only for the primary CREATE gesture):
 *
 *   IDLE
 *     │ distance < PINCH_THRESHOLD for N frames  (debounced)
 *     ▼
 *   PINCH_HOLD                         ← anchor locked in world space here
 *     │ distance still < threshold
 *     │ hand moving                    ← DRAG_UPDATE events emitted here
 *     │ distance >= threshold          (or signal loss for N frames)
 *     ▼
 *   IDLE                               ← PINCH_END event emitted on exit
 *
 * The right hand is tracked for presence (future Phase 6 manipulation) but
 * does not generate CREATE-gesture events in this phase.
 */

import type { EngineEvent } from '../types/EngineTypes'

// ─── INTENT EVENT TYPES ───────────────────────────────────────────────────────

/**
 * The semantic vocabulary of user intent. Hardware-agnostic: nothing in this
 * enum names a finger or a landmark index. The *implementation* uses landmark
 * indices; these events only describe what the user intended.
 */
export enum IntentEventType {
  /**
   * Left-hand pinch confirmed (debounced).
   * Payload: PinchStartPayload — anchor position in world space.
   * This is where the Command Engine should lock the pane's top-left corner.
   */
  PinchStart = 'intent:pinchStart',

  /**
   * Pinch still held; hand has moved enough to be considered a drag update.
   * Emitted every frame that the hand is pinching AND has moved at least
   * MIN_DRAG_DELTA from its last reported position.
   * Payload: DragUpdatePayload — current positions of all 4 pane corners.
   */
  DragUpdate = 'intent:dragUpdate',

  /**
   * Left-hand pinch released (distance exceeded threshold or signal lost).
   * Payload: PinchEndPayload — final corner positions at drop time.
   * This is where the Command Engine should commit the frozen pane.
   */
  PinchEnd = 'intent:pinchEnd',

  /**
   * Both hands are present and the right hand's pinch distance changed
   * significantly relative to the previous frame. Reserved for Phase 6
   * (scale manipulation) — emitted now so Phase 6 only adds a Command
   * handler, not a new event type.
   * Payload: ScaleHintPayload
   */
  ScaleHint = 'intent:scaleHint',

  /**
   * Tracking signal has been lost (stale frame or no hands) — intent engine
   * cannot make gesture decisions while signal is lost. Emitted once on
   * transition into signal-lost state. Consumers should gracefully freeze
   * any in-progress gesture.
   */
  SignalLost = 'intent:signalLost',

  /**
   * Tracking signal restored after a SignalLost. Emitted once on transition
   * back to valid signal. Consumers may resume normal gesture detection.
   */
  SignalRestored = 'intent:signalRestored',
}

// ─── EVENT PAYLOADS ───────────────────────────────────────────────────────────

/**
 * A 3D world-space point. Deliberately a plain object (not THREE.Vector3)
 * so the Intent Engine has zero Three.js dependency — the Renderer Engine
 * is what ultimately consumes these as Vector3s.
 */
export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * The four corners of the live pane quad at a given frame, in world space.
 * Index order matches the vertex buffer: TL, TR, BR, BL (counter-clockwise
 * from top-left).
 *
 * These corners are derived from smoothed landmark positions and are already
 * in Three.js world space (not MediaPipe normalized space).
 *
 * ── Corner → hand/finger mapping ─────────────────────────────────────────
 *
 *   TL (top-left)     = Left  Index tip  (LM 8,  left hand)
 *   TR (top-right)    = Right Index tip  (LM 8,  right hand)
 *   BR (bottom-right) = Right Thumb tip  (LM 4,  right hand)
 *   BL (bottom-left)  = Left  Thumb tip  (LM 4,  left hand)
 *
 * The intent layer does not name fingers in its events — that mapping is an
 * implementation detail of IntentEngine.onUpdate(). Consumers of these events
 * see "four corners of a quad", not "four fingertips".
 */
export interface QuadCorners {
  readonly tl: Vec3
  readonly tr: Vec3
  readonly br: Vec3
  readonly bl: Vec3
}

/**
 * Centroid of a quad — useful for the Command Engine to place a mesh's
 * Object3D.position at the quad's center rather than baking world coordinates
 * into its vertex buffer, which is the correct setup for Phase 6 manipulation
 * (moving a pane = mutate mesh.position, not rebuild geometry).
 */
export interface QuadCentroid {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** Fired when a pinch is confirmed. anchor = the BL corner (left thumb tip)
 *  at the moment the pinch was committed — this is the "stake in the ground"
 *  the marquee drag grows from. */
export interface PinchStartPayload {
  /** World-space position of left thumb tip at pinch confirmation. */
  readonly anchor: Vec3
  /** All four corners at pinch confirmation, for initial pane sizing. */
  readonly corners: QuadCorners
  /** Centroid of the quad at pinch confirmation. */
  readonly centroid: QuadCentroid
  /** performance.now() timestamp of the confirming frame. */
  readonly timestamp: number
}

/** Fired every frame the pinch is held and the hand has moved. */
export interface DragUpdatePayload {
  /** Current four corner positions — drive the live pane geometry directly. */
  readonly corners: QuadCorners
  /** Current centroid — for any UI overlay that wants to show the pane center. */
  readonly centroid: QuadCentroid
  /** Current left-thumb / left-index squared distance — for debug overlay
   *  without re-computing it in the consumer. */
  readonly pinchDistSq: number
}

/** Fired when the pinch releases. Final corner positions for CommitPane. */
export interface PinchEndPayload {
  /** Final corner positions at the moment of release. */
  readonly corners: QuadCorners
  /** Final centroid. */
  readonly centroid: QuadCentroid
  /** Whether the release was due to signal loss rather than voluntary
   *  unpin. Command Engine may want to handle these differently
   *  (e.g. not committing a pane if tracking was lost mid-gesture). */
  readonly wasSignalLoss: boolean
}

/** Reserved for Phase 6 — emitted when right-hand pinch distance changes
 *  significantly while a pane may be grabbed. */
export interface ScaleHintPayload {
  /** Frame-to-frame delta of right-hand pinch distance, in world units.
   *  Positive = hands moving apart (scale up), negative = closing (scale down). */
  readonly scaleDelta: number
}

// ─── INTERNAL GESTURE STATE ───────────────────────────────────────────────────

/**
 * The internal state machine the Intent Engine maintains per-frame.
 * Not exported from the engine — consumers only see the semantic events
 * this state machine produces.
 */
export type GesturePhase =
  | 'IDLE'        // no pinch, or below debounce threshold
  | 'DEBOUNCING'  // pinch detected but not yet confirmed (within debounce window)
  | 'PINCH_HELD'  // pinch confirmed, drag updates being emitted

/** Convenience alias for typed Intent events */
export type IntentEvent = EngineEvent

/**
 * Minimum frame-to-frame world-space movement delta (squared, to avoid
 * Math.sqrt) that triggers a DragUpdate event. Prevents a flood of
 * identical DragUpdate events when the user is pinching but holding still —
 * we only care about actual motion, not "are you still pinching?".
 *
 * 0.0001 world units squared = ~0.01 world units = ~1cm at typical depth.
 * Tune empirically if drag preview feels too stuttery or too laggy.
 */
export const MIN_DRAG_DELTA_SQ = 0.0001

/**
 * Right-hand pinch distance change that qualifies as a "meaningful" scale hint.
 * Below this threshold, noise/jitter from holding still should not emit ScaleHint.
 */
export const MIN_SCALE_DELTA = 0.005
