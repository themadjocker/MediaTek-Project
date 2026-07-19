/**
 * CommandTypes.ts
 *
 * Spatial Vision Engine (SVE) — Phase 4: Command Engine.
 *
 * "What should actually happen, and can it be undone?" — answered here.
 * This layer sits between:
 *   ← Intent Engine  (Phase 3: semantic gesture events — PinchStart/DragUpdate/PinchEnd)
 *   → Spatial Engine (Phase 5: SceneGraph/SpatialSurfaces — does not exist yet)
 *
 * ── Why Command Engine exists as its own layer ────────────────────────────
 * Intent Engine already knows "the user finished a pinch-drag here". It could
 * call sceneGraph.createPane() directly and skip this layer entirely — but
 * that would make undo/redo impossible (nothing would remember what happened
 * or how to reverse it), and it would let a hardware-detection concern
 * (Intent) reach directly into scene mutation (Spatial), which is exactly the
 * kind of layer-skipping this 5-layer stack exists to prevent. Every mutation
 * of "what exists in the scene" is required to flow through an ICommand, full
 * stop — that's what makes a future undo stack, a command log, or even
 * networked multiplayer (replay the command log) possible later without
 * touching this layer again.
 *
 * ── The Spatial Engine seam ────────────────────────────────────────────────
 * Phase 5 (Spatial Engine) doesn't exist yet, so Command Engine cannot depend
 * on a concrete scene graph implementation. ISceneGraphPort is that seam: the
 * narrowest possible interface Command Engine needs to do its job. Phase 5
 * will implement this interface for real (backed by whatever SceneGraph data
 * structure it defines); until then, any caller of CommandEngine can supply
 * a thin adapter (even one that just calls the existing CoreReactor.tsx
 * addPane/removePane Zustand actions) to get real on-screen results today
 * without CommandEngine ever needing to change when Phase 5 lands for real.
 */

// ─── DURABLE SNAPSHOT SHAPES ──────────────────────────────────────────────────
// Plain, immutable, GC'd-when-done data — deliberately NOT the same object
// references IntentEngine mutates every frame. A command must remain valid
// and inspectable indefinitely (that's the whole point of undo/redo), so it
// can never hold onto Intent Engine's pre-allocated, frame-mutated payloads.
// CommandEngine is responsible for copying (via IntentEngine's copyVec3 /
// copyQuadCorners helpers) before constructing any command below.

export interface Vec3Snapshot {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface QuadCornersSnapshot {
  readonly tl: Vec3Snapshot
  readonly tr: Vec3Snapshot
  readonly br: Vec3Snapshot
  readonly bl: Vec3Snapshot
}

/** Everything needed to (re)create a pane — the durable form of Intent
 *  Engine's PinchEndPayload, safe to hold in an undo stack indefinitely. */
export interface PaneCreateDescriptor {
  readonly corners:  QuadCornersSnapshot
  readonly centroid: Vec3Snapshot
}

// ─── THE SPATIAL ENGINE SEAM ──────────────────────────────────────────────────

/**
 * The narrowest interface Command Engine needs from "whatever owns the scene
 * graph". Phase 5 implements this for real. Reserved optional methods exist
 * now (commented shape only, added for real once Phase 6 needs them) so this
 * interface doesn't need a breaking change later — same pattern IntentTypes
 * already used for ScaleHintPayload.
 */
export interface ISceneGraphPort {
  /** Create a new pane from a durable descriptor. Returns a stable pane id
   *  the command stores so its own undo() can reverse exactly this pane,
   *  not "the most recently created one" (important once multiple undo/redo
   *  cycles are interleaved with new creations). */
  createPane(descriptor: PaneCreateDescriptor): string

  /** Remove a pane by id. Must be a no-op (not a throw) if the id no longer
   *  exists — a command's undo() can legitimately run against a scene graph
   *  that has since been cleared some other way (e.g. a "Clear All" action
   *  that itself should probably be its own undoable command in a future
   *  phase, but shouldn't be able to corrupt an older command's undo call). */
  removePane(id: string): void
}

// ─── COMMAND CONTRACT ─────────────────────────────────────────────────────────

/**
 * The Command pattern, minimal form. Every user-visible mutation of the
 * scene is one of these. `execute()` and `undo()` must be exact inverses —
 * calling execute() then undo() must leave ISceneGraphPort in the state it
 * was in before execute() ran.
 */
export interface ICommand {
  /** Human-readable/loggable command name, e.g. "CreatePane". Not used for
   *  dispatch (there's no command registry/lookup by type) — purely for
   *  event payloads and debug logging. */
  readonly type: string
  execute(): void
  undo(): void
}

// ─── COMMAND ENGINE DOMAIN EVENTS ─────────────────────────────────────────────

export enum CommandEventType {
  /** A new command was dispatched and executed (NOT via redo). */
  Executed = 'command:executed',
  /** The most recent command was reversed via undo(). */
  Undone = 'command:undone',
  /** A previously-undone command was re-applied via redo(). */
  Redone = 'command:redone',
}

export interface CommandEventPayload {
  readonly commandType: string
}

// ─── HISTORY LIMITS ────────────────────────────────────────────────────────────

/** Bounded undo history — oldest entries are dropped once exceeded, rather
 *  than growing the stack unboundedly for a long-running session. 50 covers
 *  far more than a realistic "oops, undo that" use case; this is a safety
 *  cap, not a tuned UX limit. */
export const MAX_UNDO_HISTORY = 50
