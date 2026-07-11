/**
 * Engine.ts
 *
 * Spatial Vision Engine (SVE) — Phase 1: Engine Core.
 *
 * Abstract base class every concrete engine (SensorEngine, IntentEngine,
 * CommandEngine, SpatialEngine, RendererEngine — Phases 2 through 6) will
 * extend. This file contains ZERO domain logic. What it provides:
 *
 *  1. Safe, enforced state transitions (you cannot pause a stopped engine —
 *     this throws instead of silently doing the wrong thing).
 *  2. A small pub/sub event system so engines can announce lifecycle events
 *     (and, once a subclass defines its own event types, domain events too)
 *     without every consumer needing a direct reference to every engine.
 *  3. A `protected` set of "on*" hook methods for subclasses to override —
 *     subclasses NEVER override initialize()/update()/pause()/etc. directly;
 *     they override onInitialize()/onUpdate()/onPause()/etc., and this base
 *     class guarantees those hooks are only ever called from a legal state.
 *
 * This separation (public lifecycle method enforces the rule, protected hook
 * contains the subclass's actual behavior) is what makes "you cannot pause a
 * stopped engine" a guarantee instead of a convention every subclass author
 * has to remember to re-implement correctly.
 */

import {
  EngineState,
  EngineEventType,
  type IEngine,
  type FrameContext,
  type EngineEvent,
  type EngineEventHandler,
} from '../types/EngineTypes'

/**
 * Legal state transition map: for each CURRENT state, the set of states it
 * may transition to. Anything not listed here is rejected. Disposed has no
 * outgoing transitions — it is genuinely terminal.
 *
 * Kept as a static lookup table (rather than a chain of if-statements spread
 * across each lifecycle method) so the entire legal state graph is visible
 * and auditable in one place.
 */
const VALID_TRANSITIONS: Readonly<Record<EngineState, ReadonlySet<EngineState>>> = {
  [EngineState.Created]:      new Set([EngineState.Initializing, EngineState.Disposed]),
  [EngineState.Initializing]: new Set([EngineState.Running, EngineState.Stopped, EngineState.Disposed]),
  [EngineState.Running]:      new Set([EngineState.Paused, EngineState.Stopped, EngineState.Disposed]),
  [EngineState.Paused]:       new Set([EngineState.Running, EngineState.Stopped, EngineState.Disposed]),
  [EngineState.Stopped]:      new Set([EngineState.Disposed]),
  [EngineState.Disposed]:     new Set([]),
}

/**
 * Thrown when a lifecycle method is called while the engine is in a state
 * that doesn't legally permit it (e.g. calling pause() on a Stopped engine).
 * A distinct error class (rather than a bare Error) so calling code — or a
 * future EngineManager in Phase 7 — can specifically catch and handle
 * misuse separately from genuine runtime failures inside onInitialize/onUpdate.
 */
export class EngineStateError extends Error {
  constructor(
    public readonly engineName: string,
    public readonly from: EngineState,
    public readonly to: EngineState,
  ) {
    super(`[${engineName}] Illegal state transition: ${from} -> ${to}`)
    this.name = 'EngineStateError'
  }
}

export abstract class Engine implements IEngine {
  public readonly id: string
  public readonly name: string
  public readonly priority: number

  private _state: EngineState = EngineState.Created
  public get state(): EngineState {
    return this._state
  }

  /** type -> set of handlers. Using a Set (not an array) so repeated
   *  subscribe/unsubscribe of the same handler reference can't create
   *  duplicate entries. */
  private readonly listeners = new Map<string, Set<EngineEventHandler>>()

  protected constructor(name: string, priority = 0) {
    this.id = Engine.generateId(name)
    this.name = name
    this.priority = priority
  }

  // ───────────────────────────────────────────────────────────────────────
  // PUBLIC LIFECYCLE — enforces legality, then delegates to subclass hooks.
  // Subclasses must NOT override any of these five methods directly.
  // ───────────────────────────────────────────────────────────────────────

  public initialize(): void {
    this.assertTransition(EngineState.Initializing)
    this.setState(EngineState.Initializing)

    try {
      this.onInitialize()
    } catch (err) {
      // Fail safe rather than fail stuck: an engine that threw during
      // initialization is not Running, and it is also not still
      // Initializing (that would make a second initialize() call look
      // legal-but-nonsensical). Stopped is the honest description of
      // "tried to start, didn't work, not going to retry automatically".
      this.setState(EngineState.Stopped)
      this.emit(EngineEventType.Error, { phase: 'initialize', error: err })
      throw err
    }

    this.setState(EngineState.Running)
    this.emit(EngineEventType.Initialized)
  }

  public update(frame: FrameContext): void {
    // Deliberately NOT an assertTransition/throw here: update() is called
    // every frame by the coordinator (Phase 7) regardless of every engine's
    // individual state — a Paused or Stopped engine should silently skip
    // its own work, not force every caller to check state before calling.
    if (this._state !== EngineState.Running) return
    this.onUpdate(frame)
  }

  public pause(): void {
    this.assertTransition(EngineState.Paused)
    this.setState(EngineState.Paused)
    this.onPause()
  }

  public resume(): void {
    this.assertTransition(EngineState.Running)
    this.setState(EngineState.Running)
    this.onResume()
  }

  public stop(): void {
    this.assertTransition(EngineState.Stopped)
    this.setState(EngineState.Stopped)
    this.onStop()
  }

  public dispose(): void {
    // Idempotent by design (see IEngine.dispose docs) — cleanup code often
    // can't guarantee it only ever runs once, so the second call is a
    // silent no-op rather than an EngineStateError.
    if (this._state === EngineState.Disposed) return

    this.onDispose()
    this.setState(EngineState.Disposed)
    this.emit(EngineEventType.Disposed)
    this.listeners.clear()
  }

  // ───────────────────────────────────────────────────────────────────────
  // SUBCLASS HOOKS — override these, never the public methods above.
  // onInitialize/onUpdate are abstract (every engine must define real
  // behavior for both); the rest have harmless no-op defaults since not
  // every engine will care about e.g. onPause.
  // ───────────────────────────────────────────────────────────────────────

  /** Do this engine's actual setup here. Throwing is fine and expected for
   *  genuine failures — the base class will catch it, transition to
   *  Stopped, and re-throw so the caller sees the failure too. */
  protected abstract onInitialize(): void

  /** Do this engine's actual per-frame work here. Guaranteed to only be
   *  called while state === Running. */
  protected abstract onUpdate(frame: FrameContext): void

  protected onPause(): void {
    /* no-op default — override if pausing needs side effects */
  }

  protected onResume(): void {
    /* no-op default — override if resuming needs side effects */
  }

  protected onStop(): void {
    /* no-op default — override if stopping needs side effects beyond state */
  }

  protected onDispose(): void {
    /* no-op default — override to release buffers/subscriptions/GPU objects */
  }

  // ───────────────────────────────────────────────────────────────────────
  // EVENTS
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Subscribe to events of a given type. Returns an unsubscribe function —
   * callers don't need to retain the original handler reference to remove
   * it later, just call the returned function.
   *
   * `type` is `string` rather than strictly `EngineEventType` so subclasses
   * introducing their own event-type enums (IntentEventType, etc. in later
   * phases) can use this same `on()` without EngineTypes.ts needing to know
   * about them.
   */
  public on(type: string, handler: EngineEventHandler): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(handler)
    return () => set!.delete(handler)
  }

  /** Emit an event of the given type to all current subscribers. Protected —
   *  only this engine (or its subclass) may emit its own events; external
   *  consumers may only subscribe via on(). */
  protected emit(type: string, payload?: unknown): void {
    const event: EngineEvent = {
      type,
      source: this.id,
      timestamp: performance.now(),
      payload,
    }
    this.listeners.get(type)?.forEach((handler) => handler(event))
  }

  // ───────────────────────────────────────────────────────────────────────
  // INTERNAL
  // ───────────────────────────────────────────────────────────────────────

  private assertTransition(to: EngineState): void {
    const allowed = VALID_TRANSITIONS[this._state]
    if (!allowed.has(to)) {
      throw new EngineStateError(this.name, this._state, to)
    }
  }

  private setState(next: EngineState): void {
    const prev = this._state
    this._state = next
    this.emit(EngineEventType.StateChanged, { from: prev, to: next })
  }

  private static generateId(name: string): string {
    // crypto.randomUUID() is available in both browser and modern Node —
    // no dependency needed. Prefixing with the engine name keeps ids
    // human-scannable in logs (e.g. "SensorEngine-3f9a...") without
    // requiring a lookup back to `name` elsewhere.
    return `${name}-${crypto.randomUUID()}`
  }
}
