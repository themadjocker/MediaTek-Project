/**
 * SensorEngine.ts
 *
 * Spatial Vision Engine (SVE) — Phase 2: Sensor Engine.
 *
 * Wraps this project's EXISTING tracking pipeline (NeuralLink.tsx writes
 * MediaPipe output into landmarkStore's module-level buffers every frame)
 * into the shared Engine lifecycle from Phase 1. This engine does not talk
 * to MediaPipe, the webcam, or WASM directly, and does not replace any of
 * NeuralLink.tsx's existing responsibilities — it reads the buffers
 * NeuralLink already populates and exposes them as a stable, engine-shaped
 * contract (SensorState) for the Intent Engine (Phase 3) to consume.
 *
 * Why not fold camera/MediaPipe bootstrapping into this engine too, since
 * we're building a "Sensor Engine" anyway? Because BootScreen.tsx's
 * getUserMedia + GPU-delegate + WASM boot sequence is the one part of this
 * app that reliably works today, and folding it into the new engine stack
 * now would mean risking that boundary for zero behavioral benefit this
 * phase needs. SensorEngine reads landmarkStore's buffers; it does not own
 * populating them. That ownership move, if wanted later, is a clean,
 * separate, optional Phase 2b — not bundled into this one.
 */

import { Engine } from '../core/Engine'
import type { FrameContext } from '../types/EngineTypes'
import {
  HandId,
  SensorEventType,
  type HandSensorData,
  type SensorState,
  type ReadonlySensorState,
  type HandPresenceEventPayload,
} from './SensorTypes'
import {
  smoothedBuffer,
  frameTimestamp,
  handPresence,
  landmarkConfidence,
  LEFT_HAND_OFFSET,
  RIGHT_HAND_OFFSET,
} from '@data/landmarkStore'
import { STALE_FRAME_MS, FLOATS_PER_HAND, LANDMARKS_PER_HAND } from '@constants/index'

const LEFT_PRESENT_BIT  = 0b01
const RIGHT_PRESENT_BIT = 0b10

/** Runs first in the stack — Intent/Command/Spatial/Renderer all depend,
 *  directly or transitively, on SensorEngine's output for this frame. */
export const SENSOR_ENGINE_PRIORITY = 0

export class SensorEngine extends Engine {
  // Built once in onInitialize, mutated in place every frame after that —
  // see SensorTypes.ts docs for why these are long-lived object identities,
  // not re-created snapshots.
  private leftHand!: HandSensorData
  private rightHand!: HandSensorData
  private sensorState!: SensorState

  // Previous-frame values, for edge-detecting presence transitions
  // (HandAcquired/HandLost/SignalLost/SignalRestored are all "did this
  // change since last frame", not "is this true right now").
  private prevPresenceBits = 0
  private prevSignalLost   = false

  constructor() {
    super('SensorEngine', SENSOR_ENGINE_PRIORITY)
  }

  protected onInitialize(): void {
    // .subarray() is a VIEW, not a copy — zero allocation per frame to read
    // from it, and it automatically reflects whatever landmarkStore's own
    // updateSmoothing() most recently wrote, with no work on this engine's
    // part beyond having taken the view once here.
    this.leftHand = {
      present:    false,
      landmarks:  smoothedBuffer.subarray(LEFT_HAND_OFFSET, LEFT_HAND_OFFSET + FLOATS_PER_HAND),
      confidence: 0,
    }
    this.rightHand = {
      present:    false,
      landmarks:  smoothedBuffer.subarray(RIGHT_HAND_OFFSET, RIGHT_HAND_OFFSET + FLOATS_PER_HAND),
      confidence: 0,
    }
    this.sensorState = {
      frameTimestamp: 0,
      isSignalLost:   true,
      left:           this.leftHand,
      right:          this.rightHand,
    }
  }

  // `frame` (the coordinator's relative clock) is intentionally unused here —
  // SensorEngine reports the hardware's OWN absolute timestamp
  // (frameTimestamp[0], written by NeuralLink from performance.now() at the
  // moment MediaPipe actually delivered a result), not "how long since this
  // engine started". Prefixed with _ so noUnusedParameters doesn't flag an
  // abstract-method override that genuinely doesn't need its argument.
  protected onUpdate(_frame: FrameContext): void {
    const ts    = frameTimestamp[0]
    const bits  = handPresence[0]
    const stale = (performance.now() - ts) > STALE_FRAME_MS

    const leftPresent  = (bits & LEFT_PRESENT_BIT)  !== 0
    const rightPresent = (bits & RIGHT_PRESENT_BIT) !== 0
    const isSignalLost = stale || bits === 0

    this.leftHand.present     = leftPresent
    this.leftHand.confidence  = leftPresent  ? averageConfidence(0) : 0
    this.rightHand.present    = rightPresent
    this.rightHand.confidence = rightPresent ? averageConfidence(1) : 0

    this.sensorState.frameTimestamp = ts
    this.sensorState.isSignalLost   = isSignalLost

    this.emitPresenceTransitions(bits, isSignalLost)

    this.prevPresenceBits = bits
    this.prevSignalLost   = isSignalLost
  }

  /**
   * Pull-based access for the Intent Engine (Phase 3) and anything else that
   * wants "the current sensor snapshot" without subscribing to events for
   * it. Always returns the SAME object reference — already updated for
   * whatever frame most recently ran. Read fields fresh each frame rather
   * than caching them; don't expect a field read now to still be true next
   * frame, same contract as every other buffer in this codebase.
   */
  public getState(): ReadonlySensorState {
    return this.sensorState
  }

  private emitPresenceTransitions(bits: number, isSignalLost: boolean): void {
    const wasLeft = (this.prevPresenceBits & LEFT_PRESENT_BIT) !== 0
    const isLeft  = (bits & LEFT_PRESENT_BIT) !== 0
    if (isLeft && !wasLeft) {
      this.emit(SensorEventType.HandAcquired, { hand: HandId.Left } satisfies HandPresenceEventPayload)
    }
    if (!isLeft && wasLeft) {
      this.emit(SensorEventType.HandLost, { hand: HandId.Left } satisfies HandPresenceEventPayload)
    }

    const wasRight = (this.prevPresenceBits & RIGHT_PRESENT_BIT) !== 0
    const isRight  = (bits & RIGHT_PRESENT_BIT) !== 0
    if (isRight && !wasRight) {
      this.emit(SensorEventType.HandAcquired, { hand: HandId.Right } satisfies HandPresenceEventPayload)
    }
    if (!isRight && wasRight) {
      this.emit(SensorEventType.HandLost, { hand: HandId.Right } satisfies HandPresenceEventPayload)
    }

    if (isSignalLost && !this.prevSignalLost) this.emit(SensorEventType.SignalLost)
    if (!isSignalLost && this.prevSignalLost) this.emit(SensorEventType.SignalRestored)
  }

  protected onDispose(): void {
    // Nothing owned to release — the buffers belong to landmarkStore, not
    // this engine. Present for symmetry with the other lifecycle hooks, and
    // for the day this engine does own something (e.g. its own subscription
    // to a future non-module-level data source).
  }
}

/** Average MediaPipe `visibility` across one hand's 21 landmarks, [0..1].
 *  handIndex 0 = left (landmarkConfidence[0..20]), 1 = right ([21..41]) —
 *  matches how NeuralLink.tsx already writes this array. */
function averageConfidence(handIndex: 0 | 1): number {
  const base = handIndex * LANDMARKS_PER_HAND
  let sum = 0
  for (let i = 0; i < LANDMARKS_PER_HAND; i++) sum += landmarkConfidence[base + i]
  return sum / LANDMARKS_PER_HAND
}
