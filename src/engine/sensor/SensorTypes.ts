/**
 * SensorTypes.ts
 *
 * Spatial Vision Engine (SVE) — Phase 2: Sensor Engine.
 *
 * Defines the shape of "what the hardware is doing right now", with zero
 * gesture interpretation in it. Whether a pinch is happening, whether a
 * drag has started — none of that lives here. This is deliberately dumb:
 * presence, position, confidence. The Intent Engine (Phase 3) is what turns
 * this into meaning.
 */

import type { EngineEvent } from '../types/EngineTypes'

/** Which hand a piece of sensor data belongs to. */
export enum HandId {
  Left = 'LEFT',
  Right = 'RIGHT',
}

/**
 * Snapshot of one hand's tracking data for the current frame.
 *
 * `landmarks` is a 63-float view (21 landmarks × xyz, world-space — already
 * smoothed and already mirror/frustum-corrected by landmarkStore) into the
 * SAME underlying buffer every frame — a subarray VIEW, not a copy, created
 * once in SensorEngine.onInitialize(). Treat it as read-only: nothing stops
 * you from writing to it, but doing so would corrupt landmarkStore's own
 * buffer for every other consumer, sensor engine included.
 */
export interface HandSensorData {
  present: boolean
  landmarks: Float32Array
  /** Average MediaPipe visibility score across this hand's 21 landmarks,
   *  [0..1]. 0 when the hand isn't present. Not used by anything yet —
   *  exposed now because it's already computed and free, for the Intent
   *  Engine to optionally weight gesture confidence against later. */
  confidence: number
}

/**
 * The full per-frame sensor snapshot. One instance is created once by
 * SensorEngine and its FIELDS are mutated in place every frame — the object
 * identity never changes, so holding a reference across frames and reading
 * fresh values each frame (rather than re-calling getState()) is fine and
 * intentional, matching this project's zero-allocation discipline.
 */
export interface SensorState {
  /** performance.now()-style ms timestamp of the last frame MediaPipe
   *  actually delivered new landmarks (NOT this engine's own update() time). */
  frameTimestamp: number
  /** True if no hands are present OR the last delivered frame is older than
   *  STALE_FRAME_MS — the single source of truth for "don't trust this
   *  frame's positions", replacing the isStale/isSignalLost check that used
   *  to be duplicated inline in CoreReactor's useFrame. */
  isSignalLost: boolean
  left: HandSensorData
  right: HandSensorData
}

/**
 * Consumer-facing view of SensorState — same object, but typed so
 * subscribers (Intent Engine) get a compile-time reminder not to mutate it.
 * (Shallow + one level deep; genuinely enforcing deep immutability on a
 * Float32Array isn't practical in TS and isn't the point here — this is
 * "don't accidentally reassign a field", not a security boundary.)
 */
export type ReadonlySensorState = Readonly<{
  frameTimestamp: number
  isSignalLost: boolean
  left: Readonly<HandSensorData>
  right: Readonly<HandSensorData>
}>

/**
 * Domain events SensorEngine emits on top of the shared EngineEventType
 * lifecycle events. All presence-change events — nothing about gestures.
 */
export enum SensorEventType {
  /** A hand that was NOT present last frame is present this frame. */
  HandAcquired = 'sensor:handAcquired',
  /** A hand that WAS present last frame is not present this frame. */
  HandLost = 'sensor:handLost',
  /** isSignalLost flipped false -> true this frame (either hand loss or staleness). */
  SignalLost = 'sensor:signalLost',
  /** isSignalLost flipped true -> false this frame. */
  SignalRestored = 'sensor:signalRestored',
}

export interface HandPresenceEventPayload {
  readonly hand: HandId
}

/** Convenience alias — a SensorEngine event is just an EngineEvent whose
 *  `type` happens to be a SensorEventType and whose `payload` happens to be
 *  a HandPresenceEventPayload (for the two Hand* events) or undefined (for
 *  the two Signal* events). Narrow on `type` before reading `payload`. */
export type SensorEvent = EngineEvent
