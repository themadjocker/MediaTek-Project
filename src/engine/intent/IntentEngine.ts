/**
 * IntentEngine.ts
 *
 * Spatial Vision Engine (SVE) — Phase 3: Intent Engine.
 *
 * Transforms raw SensorState into semantic gesture events. This is the layer
 * that knows "a hand's thumb close to that hand's index = pinch" — but emits
 * only "pinch started at world position X", never landmark indices.
 *
 * ── REVISION: 2-hand quad → 1-hand marquee ────────────────────────────────
 * This engine originally modeled a 2-hand, 4-fingertip "photographer's
 * viewfinder" gesture (all four corners = four simultaneous fingertips
 * across both hands). That design is abandoned — holding 4 fingertips
 * steady simultaneously multiplies MediaPipe's per-landmark jitter across
 * all of them and is physically tiring to sustain for a drag's duration.
 * This file now implements the 1-hand Spatial Marquee instead, matching
 * CoreReactor.tsx's own (already shipped, already tuned) gesture handling
 * exactly: pinch-down drops an anchor, drag while pinching grows a
 * rectangle, pinch-up commits it. See IntentTypes.ts's file-level docs for
 * the full state diagram.
 *
 * ── What this engine owns ─────────────────────────────────────────────────
 *  - The gesture state machine (IDLE → DEBOUNCING → PINCH_HELD → IDLE)
 *  - Per-hand pinch debounce (N consecutive frames under threshold = confirmed)
 *  - Picking WHICH hand owns an active drag (either hand may start one;
 *    left wins a same-frame tie; the other hand is ignored until IDLE again)
 *  - DragUpdate throttling (only emit when the active hand has actually moved)
 *  - Quad corner derivation: the axis-aligned bounding box of {anchor, current}
 *  - Centroid computation (needed by Command Engine to place mesh.position)
 *  - ScaleHint detection on whichever hand is NOT currently dragging
 *
 * ── What this engine does NOT own ─────────────────────────────────────────
 *  - Actually creating/removing panes — that's the Command Engine (Phase 4)
 *  - Updating geometry buffers — that's the Renderer Engine (Phase 6)
 *  - EMA smoothing — SensorState already contains pre-smoothed coords
 *  - The STALE_FRAME_MS check — SensorState.isSignalLost already encapsulates it
 *
 * ── Zero-allocation discipline ────────────────────────────────────────────
 *  All objects emitted in payloads (Vec3, QuadCorners, etc.) are PRE-ALLOCATED
 *  in onInitialize() and their fields are MUTATED in place each frame before
 *  emit(). This means emit() sends the SAME object reference every frame —
 *  consumers must read payload fields immediately inside their event handler,
 *  not store the payload reference and read it later (the fields will have
 *  changed). This trade-off is explicitly documented on each emitting call.
 *
 *  If a consumer genuinely needs a durable snapshot (e.g. the Command Engine
 *  storing final corner positions at PinchEnd), it must copy the fields it
 *  needs into its own storage. The intent engine provides a copyVec3() and
 *  copyQuadCorners() helper for that purpose.
 */

import { Engine }                   from '../core/Engine'
import type { FrameContext }        from '../types/EngineTypes'
import type { SensorEngine }        from '../sensor/SensorEngine'
import { HandId }                   from '../sensor/SensorTypes'
import {
  IntentEventType,
  MIN_DRAG_DELTA_SQ,
  MIN_SCALE_DELTA,
  type GesturePhase,
  type Vec3,
  type QuadCorners,
  type QuadCentroid,
  type PinchStartPayload,
  type DragUpdatePayload,
  type PinchEndPayload,
  type ScaleHintPayload,
} from './IntentTypes'
import {
  PINCH_THRESHOLD_SQ,
  PINCH_DEBOUNCE_FRAMES,
  PINCH_RELEASE_DEBOUNCE,
  THUMB_TIP_IDX,
  INDEX_TIP_IDX,
  FLOATS_PER_LANDMARK,
} from '@constants/index'

/** Runs after SensorEngine (priority 0) — must have fresh sensor data. */
export const INTENT_ENGINE_PRIORITY = 10

// ─── LANDMARK BYTE OFFSETS ───────────────────────────────────────────────────
// Pre-computed once — these never change. Each hand's landmarks array is a
// 63-float subarray (21 × xyz). Offset = index × 3. Same offsets apply to
// EITHER hand's buffer now — there's no per-hand distinction in the offset
// itself, only in which buffer (sensor.left vs sensor.right) it's read from.

const THUMB_OFFSET = THUMB_TIP_IDX * FLOATS_PER_LANDMARK   // LM4:  offset 12
const INDEX_OFFSET = INDEX_TIP_IDX * FLOATS_PER_LANDMARK   // LM8:  offset 24

// ─── PRE-ALLOCATED PAYLOAD OBJECTS ───────────────────────────────────────────
// Created once in onInitialize(), mutated every frame — see class-level docs
// re: zero-allocation discipline and consumer obligations.

function makeVec3(): Vec3 {
  // Cast: the object matches the interface shape; we hold it as mutable
  // internally and expose it as readonly to consumers via the interface type.
  return { x: 0, y: 0, z: 0 } as Vec3
}

function makeQuadCorners(): QuadCorners {
  return { tl: makeVec3(), tr: makeVec3(), br: makeVec3(), bl: makeVec3() } as QuadCorners
}

/** Mutate a Vec3 in place from a Float32Array subarray, as the MIDPOINT of
 *  thumb tip and index tip — i.e. the pinch point itself, not either
 *  fingertip alone. This is what CoreReactor calls "the pinch point" and
 *  it's what a marquee's anchor/current position actually is. */
function setPinchMidpoint(v: Vec3, buf: Float32Array): void {
  const mutable = v as { x: number; y: number; z: number }
  mutable.x = (buf[THUMB_OFFSET]     + buf[INDEX_OFFSET])     * 0.5
  mutable.y = (buf[THUMB_OFFSET + 1] + buf[INDEX_OFFSET + 1]) * 0.5
  mutable.z = (buf[THUMB_OFFSET + 2] + buf[INDEX_OFFSET + 2]) * 0.5
}

/** Copy one Vec3's fields into another, in place — zero allocation. */
function copyVec3Into(dst: Vec3, src: Vec3): void {
  const mutable = dst as { x: number; y: number; z: number }
  mutable.x = src.x
  mutable.y = src.y
  mutable.z = src.z
}

/**
 * Derive the 4 named corners of the axis-aligned rectangle spanning two
 * diagonal points (anchor and current) — the entire "quad" a 1-hand marquee
 * ever produces. See IntentTypes.ts's QuadCorners doc for the exact mapping.
 */
function setCornersFromDiagonal(out: QuadCorners, a: Vec3, b: Vec3): void {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x)
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y)
  const z    = (a.z + b.z) * 0.5

  const tl = out.tl as { x: number; y: number; z: number }
  const tr = out.tr as { x: number; y: number; z: number }
  const br = out.br as { x: number; y: number; z: number }
  const bl = out.bl as { x: number; y: number; z: number }

  tl.x = minX; tl.y = maxY; tl.z = z
  tr.x = maxX; tr.y = maxY; tr.z = z
  br.x = maxX; br.y = minY; br.z = z
  bl.x = minX; bl.y = minY; bl.z = z
}

/** Compute quad centroid from four corners, mutating `out`. */
function setCentroid(out: QuadCentroid, corners: QuadCorners): void {
  const mutable = out as { x: number; y: number; z: number }
  mutable.x = (corners.tl.x + corners.tr.x + corners.br.x + corners.bl.x) * 0.25
  mutable.y = (corners.tl.y + corners.tr.y + corners.br.y + corners.bl.y) * 0.25
  mutable.z = (corners.tl.z + corners.tr.z + corners.br.z + corners.bl.z) * 0.25
}

/** Copy a Vec3 into a plain mutable object — for consumers that need a
 *  durable snapshot (e.g. Command Engine storing final corner at drop). */
export function copyVec3(src: Vec3): { x: number; y: number; z: number } {
  return { x: src.x, y: src.y, z: src.z }
}

/** Copy a QuadCorners into a plain mutable snapshot object. */
export function copyQuadCorners(
  src: QuadCorners,
): { tl: { x: number; y: number; z: number }; tr: { x: number; y: number; z: number }; br: { x: number; y: number; z: number }; bl: { x: number; y: number; z: number } } {
  return {
    tl: copyVec3(src.tl),
    tr: copyVec3(src.tr),
    br: copyVec3(src.br),
    bl: copyVec3(src.bl),
  }
}

// ─── INTENT ENGINE ────────────────────────────────────────────────────────────

export class IntentEngine extends Engine {
  private readonly sensor: SensorEngine

  // ── Gesture state machine ──────────────────────────────────────────────
  private gesturePhase: GesturePhase = 'IDLE'

  /** Which hand (if any) currently owns an active marquee drag. null in
   *  IDLE/DEBOUNCING — set the instant a pinch confirms, cleared on commit
   *  or on signal loss. This is the field that makes "either hand, but only
   *  one at a time" work. */
  private activeHand: HandId | null = null

  // Per-hand debounce counters — mirror CoreReactor's own [left, right]
  // tuples exactly, kept as named fields rather than a tuple/map for the
  // hottest possible per-frame access (no indirection, no key lookup).
  private pinchFramesLeft    = 0
  private pinchFramesRight   = 0
  private releaseFramesLeft  = 0
  private releaseFramesRight = 0
  /** "Armed" = allowed to start counting toward a NEW confirm. Disarmed the
   *  instant a hand starts an active drag (so its own frozen debounce count
   *  can't spuriously re-confirm while already dragging); re-armed once that
   *  hand completes its own full release-debounce cycle. */
  private armedLeft  = true
  private armedRight = true

  // ── Pre-allocated scratch — mutated in place every frame ────────────────
  private readonly _leftPoint:  Vec3 = makeVec3()   // left hand's pinch midpoint, tracked every frame regardless of gesture state
  private readonly _rightPoint: Vec3 = makeVec3()   // right hand's pinch midpoint, same
  private readonly _anchor:     Vec3 = makeVec3()   // locked at confirm; fixed for the rest of the drag
  private readonly _current:    Vec3 = makeVec3()   // the active hand's live point, refreshed every frame while dragging

  private readonly _corners:  QuadCorners  = makeQuadCorners()
  private readonly _centroid: QuadCentroid = { x: 0, y: 0, z: 0 } as QuadCentroid

  // Last position a DragUpdate was emitted for — throttle reference.
  private readonly _lastEmittedCurrent: Vec3 = makeVec3()

  // Pre-allocated payload objects — mutated before each emit().
  // Consumers must NOT store these references across frames.
  private readonly _pinchStartPayload: PinchStartPayload = {
    anchor:    makeVec3(),
    corners:   makeQuadCorners(),
    centroid:  { x: 0, y: 0, z: 0 } as QuadCentroid,
    timestamp: 0,
  } as PinchStartPayload

  private readonly _dragUpdatePayload: DragUpdatePayload = {
    corners:     makeQuadCorners(),
    centroid:    { x: 0, y: 0, z: 0 } as QuadCentroid,
    pinchDistSq: 0,
  } as DragUpdatePayload

  private readonly _pinchEndPayload: PinchEndPayload = {
    corners:       makeQuadCorners(),
    centroid:      { x: 0, y: 0, z: 0 } as QuadCentroid,
    wasSignalLoss: false,
  } as PinchEndPayload

  private readonly _scaleHintPayload: ScaleHintPayload = {
    scaleDelta: 0,
  } as ScaleHintPayload

  // Previous-frame pinch squared distance of the INACTIVE hand, for
  // ScaleHint delta. Reset whenever which hand is inactive changes (i.e. on
  // every drag start/end) so a stale delta from "the other hand" never leaks in.
  private _prevInactiveDistSq = 0

  // Last-frame per-hand squared pinch distances — stored purely for debug/
  // observability consumers (e.g. DebugOverlay's threshold sparkline). Not
  // read anywhere in the gesture logic itself, which uses local variables
  // computed fresh each frame; these are a read-only side channel.
  private _lastLeftDistSq  = 0
  private _lastRightDistSq = 0

  // Whether signal was lost last frame — for SignalLost/Restored edges.
  private _prevSignalLost = false

  constructor(sensor: SensorEngine) {
    super('IntentEngine', INTENT_ENGINE_PRIORITY)
    this.sensor = sensor
  }

  protected onInitialize(): void {
    this.gesturePhase  = 'IDLE'
    this.activeHand    = null
    this.pinchFramesLeft    = 0
    this.pinchFramesRight   = 0
    this.releaseFramesLeft  = 0
    this.releaseFramesRight = 0
    this.armedLeft  = true
    this.armedRight = true
    this._prevInactiveDistSq = 0
    this._prevSignalLost     = false
  }

  protected onUpdate(_frame: FrameContext): void {
    const sensor = this.sensor.getState()

    // ── 1. Signal loss / restoration ──────────────────────────────────────
    if (sensor.isSignalLost && !this._prevSignalLost) {
      if (this.gesturePhase === 'PINCH_HELD') {
        this.emitPinchEnd(true /* wasSignalLoss */)
      }
      this.resetToIdle()
      this.emit(IntentEventType.SignalLost)
    } else if (!sensor.isSignalLost && this._prevSignalLost) {
      this.emit(IntentEventType.SignalRestored)
    }
    this._prevSignalLost = sensor.isSignalLost

    if (sensor.isSignalLost) return   // nothing reliable to gesture on

    // ── 2. Track both hands' pinch points + squared distances every frame —
    //      regardless of gesture state, exactly like CoreReactor does, since
    //      whichever hand isn't dragging still needs to be ready to become
    //      the active hand (or to feed ScaleHint) the instant it's relevant. ──
    const leftPresent  = sensor.left.present
    const rightPresent = sensor.right.present
    const lBuf = sensor.left.landmarks
    const rBuf = sensor.right.landmarks

    const ldx = lBuf[THUMB_OFFSET]     - lBuf[INDEX_OFFSET]
    const ldy = lBuf[THUMB_OFFSET + 1] - lBuf[INDEX_OFFSET + 1]
    const ldz = lBuf[THUMB_OFFSET + 2] - lBuf[INDEX_OFFSET + 2]
    const leftDistSq = ldx * ldx + ldy * ldy + ldz * ldz

    const rdx = rBuf[THUMB_OFFSET]     - rBuf[INDEX_OFFSET]
    const rdy = rBuf[THUMB_OFFSET + 1] - rBuf[INDEX_OFFSET + 1]
    const rdz = rBuf[THUMB_OFFSET + 2] - rBuf[INDEX_OFFSET + 2]
    const rightDistSq = rdx * rdx + rdy * rdy + rdz * rdz

    this._lastLeftDistSq  = leftDistSq
    this._lastRightDistSq = rightDistSq

    setPinchMidpoint(this._leftPoint, lBuf)
    setPinchMidpoint(this._rightPoint, rBuf)

    const isPinchingLeft  = leftPresent  && leftDistSq  < PINCH_THRESHOLD_SQ
    const isPinchingRight = rightPresent && rightDistSq < PINCH_THRESHOLD_SQ

    // ── 3. Per-hand pinch debounce (both hands, every frame, unconditionally) ─
    let leftConfirmed  = false
    let rightConfirmed = false

    if (isPinchingLeft && this.armedLeft) {
      this.pinchFramesLeft++
      this.releaseFramesLeft = 0
      if (this.pinchFramesLeft === PINCH_DEBOUNCE_FRAMES) leftConfirmed = true
    } else if (!isPinchingLeft) {
      if (this.pinchFramesLeft > 0) {
        this.releaseFramesLeft++
        if (this.releaseFramesLeft >= PINCH_RELEASE_DEBOUNCE) {
          this.pinchFramesLeft   = 0
          this.releaseFramesLeft = 0
          this.armedLeft         = true
        }
      }
    }

    if (isPinchingRight && this.armedRight) {
      this.pinchFramesRight++
      this.releaseFramesRight = 0
      if (this.pinchFramesRight === PINCH_DEBOUNCE_FRAMES) rightConfirmed = true
    } else if (!isPinchingRight) {
      if (this.pinchFramesRight > 0) {
        this.releaseFramesRight++
        if (this.releaseFramesRight >= PINCH_RELEASE_DEBOUNCE) {
          this.pinchFramesRight   = 0
          this.releaseFramesRight = 0
          this.armedRight         = true
        }
      }
    }

    // ── 4. Marquee drag session state machine ──────────────────────────────
    if (this.activeHand === null) {
      // Not dragging — either hand's confirmed pinch starts a new drag.
      // Left checked first; if both land the same frame, left wins.
      if (leftConfirmed) {
        this.startDrag(HandId.Left)
      } else if (rightConfirmed) {
        this.startDrag(HandId.Right)
      } else {
        this.gesturePhase =
          (this.pinchFramesLeft > 0 || this.pinchFramesRight > 0) ? 'DEBOUNCING' : 'IDLE'
      }
    } else {
      // Currently dragging with this.activeHand — the other hand is ignored
      // entirely (its debounce counters keep running above, but nothing here
      // consumes them until this drag ends and activeHand goes back to null).
      const isActive =
        this.activeHand === HandId.Left ? isPinchingLeft : isPinchingRight

      if (isActive) {
        copyVec3Into(this._current, this.activeHand === HandId.Left ? this._leftPoint : this._rightPoint)
        setCornersFromDiagonal(this._corners, this._anchor, this._current)
        setCentroid(this._centroid, this._corners)

        const dx = this._current.x - this._lastEmittedCurrent.x
        const dy = this._current.y - this._lastEmittedCurrent.y
        const dz = this._current.z - this._lastEmittedCurrent.z
        if (dx * dx + dy * dy + dz * dz > MIN_DRAG_DELTA_SQ) {
          const activeDistSq = this.activeHand === HandId.Left ? leftDistSq : rightDistSq
          this.emitDragUpdate(activeDistSq)
          copyVec3Into(this._lastEmittedCurrent, this._current)
        }
      } else {
        // Active hand released — wait for ITS OWN release debounce to fully
        // complete (mirrors CoreReactor's "pinchFrames===0 && releaseFrames===0"
        // check, which is only true on the exact frame the reset just happened).
        const framesZero = this.activeHand === HandId.Left
          ? (this.pinchFramesLeft === 0 && this.releaseFramesLeft === 0)
          : (this.pinchFramesRight === 0 && this.releaseFramesRight === 0)

        if (framesZero) {
          this.emitPinchEnd(false)
          this.activeHand   = null
          this.gesturePhase = 'IDLE'
        }
        // else: still within the release-debounce grace window — corners are
        // deliberately NOT refreshed here, so the last live drag frame is
        // what gets committed, matching CoreReactor's preview-freeze behavior.
      }
    }

    // ── 5. ScaleHint from whichever hand is NOT currently dragging ─────────
    if (this.gesturePhase === 'PINCH_HELD' && this.activeHand !== null) {
      const inactivePresent = this.activeHand === HandId.Left ? rightPresent : leftPresent
      const inactiveDistSq  = this.activeHand === HandId.Left ? rightDistSq  : leftDistSq

      if (inactivePresent) {
        if (this._prevInactiveDistSq > 0) {
          // sqrt-of-distances delta (real units), not squared-delta — scale
          // meaning is linear, not quadratic.
          const prev  = Math.sqrt(this._prevInactiveDistSq)
          const curr  = Math.sqrt(inactiveDistSq)
          const delta = curr - prev

          if (Math.abs(delta) > MIN_SCALE_DELTA) {
            ;(this._scaleHintPayload as { scaleDelta: number }).scaleDelta = delta
            this.emit(IntentEventType.ScaleHint, this._scaleHintPayload)
          }
        }
        this._prevInactiveDistSq = inactiveDistSq
      } else {
        this._prevInactiveDistSq = 0
      }
    } else {
      this._prevInactiveDistSq = 0
    }
  }

  // ── Public read access ────────────────────────────────────────────────────

  /** Current gesture phase — for debug overlay without event subscription. */
  public getGesturePhase(): GesturePhase {
    return this.gesturePhase
  }

  /** Which hand owns the active drag, or null if none. */
  public getActiveHand(): HandId | null {
    return this.activeHand
  }

  /** Current quad corners (live, world-space) — meaningful only while
   *  getGesturePhase() === 'PINCH_HELD'; holds the last drag's values
   *  otherwise (harmless stale read, not zeroed between drags). For Renderer
   *  Engine to read directly in its useFrame without waiting for a
   *  DragUpdate event. Returns the engine's own pre-allocated object — DO
   *  NOT store across frames. */
  public getCorners(): QuadCorners {
    return this._corners
  }

  /** Current centroid — same caveat as getCorners(). */
  public getCentroid(): QuadCentroid {
    return this._centroid
  }

  /** The locked anchor point of the current/most recent drag. Meaningful
   *  only once a drag has started at least once (zeroed at construction) —
   *  same "holds last value, not zeroed between drags" caveat as
   *  getCorners()/getCentroid(). For debug/observability consumers, not used
   *  by the gesture logic itself (which reads the private field directly). */
  public getAnchor(): Vec3 {
    return this._anchor
  }

  /** Last-frame squared pinch distance for each hand, regardless of which
   *  (if either) currently owns the drag. Debug/observability only — e.g.
   *  DebugOverlay's threshold sparkline. */
  public getLeftPinchDistSq(): number {
    return this._lastLeftDistSq
  }

  public getRightPinchDistSq(): number {
    return this._lastRightDistSq
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private startDrag(hand: HandId): void {
    if (hand === HandId.Left) {
      this.armedLeft = false
      copyVec3Into(this._anchor, this._leftPoint)
    } else {
      this.armedRight = false
      copyVec3Into(this._anchor, this._rightPoint)
    }
    copyVec3Into(this._current, this._anchor)   // current === anchor at the instant of confirm

    this.activeHand   = hand
    this.gesturePhase = 'PINCH_HELD'

    setCornersFromDiagonal(this._corners, this._anchor, this._current)  // degenerate, zero-area
    setCentroid(this._centroid, this._corners)
    copyVec3Into(this._lastEmittedCurrent, this._current)

    this._prevInactiveDistSq = 0   // fresh baseline — don't compare against the other hand's pre-drag distance

    this.emitPinchStart()
  }

  private resetToIdle(): void {
    this.gesturePhase = 'IDLE'
    this.activeHand   = null
    this.pinchFramesLeft    = 0
    this.pinchFramesRight   = 0
    this.releaseFramesLeft  = 0
    this.releaseFramesRight = 0
    this.armedLeft  = true
    this.armedRight = true
  }

  private emitPinchStart(): void {
    const p = this._pinchStartPayload as {
      anchor: Vec3; corners: QuadCorners; centroid: QuadCentroid; timestamp: number
    }
    copyVec3Into(p.anchor, this._anchor)
    this.copyIntoCornersPayload(p.corners, this._corners)
    setCentroid(p.centroid, this._corners)
    p.timestamp = performance.now()

    this.emit(IntentEventType.PinchStart, this._pinchStartPayload)
  }

  private emitDragUpdate(pinchDistSq: number): void {
    const p = this._dragUpdatePayload as {
      corners: QuadCorners; centroid: QuadCentroid; pinchDistSq: number
    }
    this.copyIntoCornersPayload(p.corners, this._corners)
    setCentroid(p.centroid, this._corners)
    p.pinchDistSq = pinchDistSq

    this.emit(IntentEventType.DragUpdate, this._dragUpdatePayload)
  }

  private emitPinchEnd(wasSignalLoss: boolean): void {
    // Refresh one last time from the live pinch point of whichever hand was
    // active, so the committed rectangle reflects its CURRENT position at
    // commit time — not a position frozen back when pinching first stopped
    // (matches CoreReactor: it re-reads the live point at the commit frame,
    // several frames after physical release, not the last "still pinching" frame).
    if (this.activeHand !== null && !wasSignalLoss) {
      copyVec3Into(
        this._current,
        this.activeHand === HandId.Left ? this._leftPoint : this._rightPoint,
      )
      setCornersFromDiagonal(this._corners, this._anchor, this._current)
      setCentroid(this._centroid, this._corners)
    }
    // On signal loss, sensor data may already be unreliable — commit
    // whatever _corners last validly held rather than reading possibly-stale
    // buffers again.

    const p = this._pinchEndPayload as {
      corners: QuadCorners; centroid: QuadCentroid; wasSignalLoss: boolean
    }
    this.copyIntoCornersPayload(p.corners, this._corners)
    setCentroid(p.centroid, this._corners)
    p.wasSignalLoss = wasSignalLoss

    this.emit(IntentEventType.PinchEnd, this._pinchEndPayload)
  }

  /** Deep-mutate a pre-allocated QuadCorners payload from a source. */
  private copyIntoCornersPayload(dst: QuadCorners, src: QuadCorners): void {
    for (const key of ['tl', 'tr', 'br', 'bl'] as const) {
      copyVec3Into(dst[key], src[key])
    }
  }

  protected onDispose(): void {
    // Nothing to release beyond the listener cleanup the base class handles.
  }
}
