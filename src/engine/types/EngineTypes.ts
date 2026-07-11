/**
 * EngineTypes.ts
 *
 * Spatial Vision Engine (SVE) — Phase 1: Engine Core.
 *
 * This file defines the SHARED CONTRACTS every engine in the 5-layer stack
 * (Sensor -> Intent -> Command -> Spatial -> Renderer) must implement and
 * agree on. Nothing in this file knows about MediaPipe, Three.js, React, or
 * hand-tracking specifically — that is the entire point. These types are the
 * "operating system" the domain-specific engines run on top of.
 *
 * Design intent:
 *  - Every engine shares the exact same lifecycle (EngineState) and the exact
 *    same per-frame timing data (FrameContext), so a coordinator (built in
 *    Phase 7) can drive all five engines identically without knowing what
 *    each one actually does internally.
 *  - Engines communicate laterally (Sensor -> Intent -> Command -> ...) via
 *    their own domain-specific event payloads, but the ENVELOPE those events
 *    travel in (EngineEvent) and the taxonomy of lifecycle-level events
 *    (EngineEventType) is shared infrastructure, defined once here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// ENGINE STATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The lifecycle every engine passes through. Deliberately small and linear —
 * this is NOT meant to model domain logic (e.g. "is a gesture in progress"),
 * only whether the engine itself is currently doing work.
 *
 * Legal transitions (enforced by the abstract Engine class in Phase 1's
 * second file, not by this enum itself):
 *
 *   Created ──initialize()──► Initializing ──(success)──► Running
 *                                   │
 *                                   └──(failure)──► Stopped
 *
 *   Running ──pause()──► Paused ──resume()──► Running
 *   Running / Paused ──stop()──► Stopped
 *   (any state) ──dispose()──► Disposed   [terminal — no transitions out]
 */
export enum EngineState {
  /** Constructed, but initialize() has not been called yet. Nothing is running. */
  Created = 'CREATED',
  /** initialize() is currently executing (may be async in future engines). */
  Initializing = 'INITIALIZING',
  /** Fully initialized and actively receiving update(frame) calls. */
  Running = 'RUNNING',
  /** Initialized, but update(frame) calls are being skipped until resume(). */
  Paused = 'PAUSED',
  /** Deliberately halted. Can be inspected but will not process further frames. */
  Stopped = 'STOPPED',
  /** Terminal. Resources released. This engine instance may not be reused. */
  Disposed = 'DISPOSED',
}

// ─────────────────────────────────────────────────────────────────────────────
// FRAME TIMING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-frame timing data, computed ONCE per frame by whatever drives the top
 * of the engine stack (in this app, that will end up being R3F's useFrame —
 * but nothing in this file may assume that), and passed identically to every
 * engine's update(frame) call so they all agree on "now".
 *
 * Deliberately POJO / plain-data — no methods, no class instance, so it can
 * be constructed once per frame and mutated in place by the coordinator
 * (Phase 7) rather than reallocated, matching this project's existing
 * zero-allocation-in-the-hot-path discipline.
 */
export interface FrameContext {
  /** Seconds elapsed since the previous frame. Not milliseconds — seconds,
   *  to match Three.js / R3F convention and avoid unit-mismatch bugs at the
   *  Renderer Engine boundary. */
  readonly deltaTime: number
  /** Seconds elapsed since this engine's initialize() completed. Distinct
   *  from "since the app started" — an engine started later (e.g. hot-added)
   *  gets its own clock. */
  readonly elapsedTime: number
  /** Monotonically increasing frame counter since initialize(). Useful for
   *  debounce/cooldown logic expressed in "N frames" (as this project's
   *  gesture debounce already is) rather than wall-clock time. */
  readonly frameCount: number
}

// ─────────────────────────────────────────────────────────────────────────────
// ENGINE CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The contract EVERY engine in the stack implements — Sensor, Intent,
 * Command, Spatial, and Renderer engines are all, first and foremost, an
 * IEngine. A coordinator can hold `IEngine[]`, sort by `priority`, and drive
 * all five without a single domain-specific import.
 */
export interface IEngine {
  /** Stable unique identifier for this engine INSTANCE (not its type/class).
   *  Useful once multiple instances of the same engine type could exist. */
  readonly id: string

  /** Human-readable engine name for logging/debugging, e.g. "SensorEngine". */
  readonly name: string

  /** Determines update() ordering when multiple engines run in the same
   *  frame — LOWER numbers run first. Sensor must run before Intent, which
   *  must run before Command, and so on, so the natural priority order
   *  mirrors the 5-layer stack (e.g. 0, 10, 20, 30, 40). */
  readonly priority: number

  /** Current lifecycle state. Read-only from the outside — only the
   *  engine's own lifecycle methods may change it. */
  readonly state: EngineState

  /**
   * Transition Created -> Initializing -> Running. Called exactly once per
   * engine instance. Calling it again (or calling it on a non-Created
   * engine) is a programmer error and the implementation MUST throw rather
   * than silently no-op — a silently-skipped initialize() is exactly the
   * kind of bug this shared lifecycle exists to prevent.
   */
  initialize(): void

  /**
   * Called once per frame while state === Running. Implementations should
   * treat `frame` as read-only and must not retain a reference to it past
   * the call (the coordinator may mutate/reuse the same FrameContext object
   * across frames to avoid allocation).
   */
  update(frame: FrameContext): void

  /** Running -> Paused. update() calls are ignored (not erroring, just
   *  skipped) until resume(). */
  pause(): void

  /** Paused -> Running. */
  resume(): void

  /** Running or Paused -> Stopped. Distinct from dispose(): a stopped engine
   *  still holds its resources and COULD theoretically be inspected, it's
   *  just permanently done processing frames. */
  stop(): void

  /**
   * -> Disposed, from any state. Terminal. Releases whatever resources this
   * engine holds (buffers, subscriptions, GPU objects once Renderer Engine
   * exists). Must be safe to call multiple times (idempotent) — the second
   * and subsequent calls are no-ops, not errors, since cleanup code often
   * can't guarantee it only runs once.
   */
  dispose(): void
}

// ─────────────────────────────────────────────────────────────────────────────
// INTER-ENGINE EVENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle-level event taxonomy — these are about the ENGINE itself
 * (did it start, did it error, did its state change), not about domain
 * events like "pinch started" or "pane created". Domain events are defined
 * by each specific engine in later phases (e.g. Intent Engine will define
 * its own IntentEventType enum for PINCH_START / DRAG_UPDATE / PINCH_END)
 * and are carried using this same EngineEvent envelope, but are NOT added
 * to this shared enum — this file must never need to change when a new
 * domain engine is added.
 */
export enum EngineEventType {
  /** Fired once, immediately after a successful initialize(). */
  Initialized = 'engine:initialized',
  /** Fired every time `state` changes, for ANY reason (pause, resume, stop,
   *  dispose, or a failed initialize forcing a transition to Stopped). */
  StateChanged = 'engine:stateChanged',
  /** Fired when an engine catches an internal error it can recover from
   *  (i.e. it does NOT necessarily transition to Stopped/Disposed — that's
   *  the engine implementation's judgment call, this event just reports it
   *  happened so a coordinator or dev overlay can surface it). */
  Error = 'engine:error',
  /** Fired once, at the end of dispose(), after resources are released and
   *  immediately before state becomes Disposed. Last event this engine
   *  instance will ever emit. */
  Disposed = 'engine:disposed',
}

/**
 * The envelope every engine event — lifecycle or domain-specific — travels
 * in. `payload` is intentionally `unknown`, not generic-typed here: each
 * later engine phase will define its own narrowly-typed event payload
 * interfaces and its own strongly-typed `on()` overloads at the point where
 * that specific event type is emitted, rather than this shared file trying
 * to enumerate every payload shape every future engine will ever need.
 */
export interface EngineEvent {
  /** What kind of event this is. Lifecycle events use EngineEventType;
   *  domain events use that engine's own event-type enum (as a string). */
  readonly type: string
  /** id of the IEngine instance that emitted this event. */
  readonly source: string
  /** performance.now()-style timestamp (ms) of emission, for ordering/debug. */
  readonly timestamp: number
  /** Event-specific data. Consumers should narrow this via the event's
   *  `type` field before reading it — see each engine's own event docs. */
  readonly payload?: unknown
}

/** A subscriber callback for engine events. Returns nothing — if a consumer
 *  needs to unsubscribe, `Engine.on()` (Phase 1's second file) returns an
 *  unsubscribe function directly rather than requiring the caller to hold
 *  onto and pass back the original handler reference. */
export type EngineEventHandler = (event: EngineEvent) => void
