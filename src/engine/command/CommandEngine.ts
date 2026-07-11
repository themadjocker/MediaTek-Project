/**
 * CommandEngine.ts
 *
 * Spatial Vision Engine (SVE) — Phase 4: Command Engine.
 *
 * Turns Intent Engine's semantic gesture events into dispatched, undoable
 * ICommand objects. This is the ONLY layer allowed to call ISceneGraphPort
 * mutation methods — Intent Engine never touches the scene graph directly.
 *
 * ── What this engine owns ─────────────────────────────────────────────────
 *  - Subscribing to Intent Engine's domain events (PinchEnd, for now)
 *  - Constructing durable command objects from transient Intent payloads
 *    (copying via IntentEngine's copyVec3/copyQuadCorners — see IntentEngine
 *    file-level docs re: why this copy is mandatory, not optional)
 *  - The undo/redo stack itself: dispatch(), undo(), redo(), bounded history
 *
 * ── What this engine does NOT own ─────────────────────────────────────────
 *  - Gesture detection / debouncing — that's Intent Engine (Phase 3)
 *  - Actual scene mutation — that's whatever implements ISceneGraphPort
 *    (Phase 5's Spatial Engine, or a temporary adapter until Phase 5 lands)
 *  - Live drag preview — Intent Engine's DragUpdate / getCorners() are read
 *    directly by the Renderer (Phase 6); Command Engine only cares about the
 *    committed result at PinchEnd, because "preview while dragging" is not
 *    an undoable action — only the final drop is.
 *
 * ── Why PinchEnd is the only event consumed so far ────────────────────────
 * PinchStart and DragUpdate describe an in-progress gesture with no durable
 * outcome yet — there's nothing to undo until the user actually commits by
 * releasing the pinch. ScaleHint is intentionally left unhandled here: Phase
 * 3 emits it now so Phase 6 (manipulation) only needs to ADD a handler here,
 * not invent a new event type. Wiring it up before there's a pane-scaling
 * command to dispatch would just be dead code.
 */

import { Engine }                      from '../core/Engine'
import type { FrameContext, EngineEvent } from '../types/EngineTypes'
import type { IntentEngine }           from '../intent/IntentEngine'
import { copyVec3, copyQuadCorners }   from '../intent/IntentEngine'
import { IntentEventType, type PinchEndPayload } from '../intent/IntentTypes'
import {
  CommandEventType,
  MAX_UNDO_HISTORY,
  type ICommand,
  type ISceneGraphPort,
  type PaneCreateDescriptor,
} from './CommandTypes'

/** Runs after Intent (priority 10) — must see gesture events before it could
 *  possibly need to react to one this same frame. */
export const COMMAND_ENGINE_PRIORITY = 20

// ─── COMMANDS ──────────────────────────────────────────────────────────────────

/**
 * Create a pane from a committed pinch-drag. Stores the id the scene graph
 * assigns on execute() so undo() reverses exactly THIS pane — not "whatever
 * the most recently created pane happens to be", which would break the
 * moment undo/redo are interleaved with new creations.
 */
class CreatePaneCommand implements ICommand {
  public readonly type = 'CreatePane'
  private paneId: string | null = null

  constructor(
    private readonly sceneGraph: ISceneGraphPort,
    private readonly descriptor: PaneCreateDescriptor,
  ) {}

  execute(): void {
    this.paneId = this.sceneGraph.createPane(this.descriptor)
  }

  undo(): void {
    if (this.paneId === null) return  // never successfully executed — nothing to reverse
    this.sceneGraph.removePane(this.paneId)
    this.paneId = null
  }
}

// ─── COMMAND ENGINE ────────────────────────────────────────────────────────────

export class CommandEngine extends Engine {
  private readonly intent:     IntentEngine
  private readonly sceneGraph: ISceneGraphPort

  private readonly undoStack: ICommand[] = []
  private readonly redoStack: ICommand[] = []
  private unsubscribers: Array<() => void> = []

  constructor(intent: IntentEngine, sceneGraph: ISceneGraphPort) {
    super('CommandEngine', COMMAND_ENGINE_PRIORITY)
    this.intent     = intent
    this.sceneGraph = sceneGraph
  }

  protected onInitialize(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.unsubscribers = [
      this.intent.on(IntentEventType.PinchEnd, this.handlePinchEnd),
    ]
  }

  /** Command Engine is purely event-driven (reacts to Intent's emit() calls,
   *  which happen inside Intent's own onUpdate — already ordered before this
   *  engine's update() via priority). Nothing to poll per frame. */
  protected onUpdate(_frame: FrameContext): void {}

  protected onDispose(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe())
    this.unsubscribers = []
    this.undoStack.length = 0
    this.redoStack.length = 0
  }

  // ── Public undo/redo API ──────────────────────────────────────────────────
  // Not gesture-driven — intended to be wired to a keyboard shortcut or a
  // PaneEditor button. Returns whether anything actually happened, so a
  // caller can e.g. disable its "Undo" button when canUndo() is false
  // without needing a separate check-then-act race.

  public undo(): boolean {
    const command = this.undoStack.pop()
    if (!command) return false
    command.undo()
    this.redoStack.push(command)
    this.emit(CommandEventType.Undone, { commandType: command.type })
    return true
  }

  public redo(): boolean {
    const command = this.redoStack.pop()
    if (!command) return false
    command.execute()
    this.pushUndo(command)
    this.emit(CommandEventType.Redone, { commandType: command.type })
    return true
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0
  }

  // ── Intent event handlers ─────────────────────────────────────────────────

  /** Arrow-function class field (not a prototype method) so `this` is bound
   *  correctly when Intent Engine's `on()` calls it directly — matches how
   *  Engine.on() hands back a plain function reference with no bind step. */
  private handlePinchEnd = (event: EngineEvent): void => {
    const payload = event.payload as PinchEndPayload

    // Per Phase 3's design note: a gesture aborted by signal loss produced no
    // deliberate user action — discard rather than commit a half-drawn pane.
    if (payload.wasSignalLoss) return

    // MANDATORY copy — payload.corners/centroid are Intent Engine's own
    // pre-allocated objects and will be mutated again next frame. Everything
    // past this line uses only the copied, durable snapshot.
    const descriptor: PaneCreateDescriptor = {
      corners:  copyQuadCorners(payload.corners),
      centroid: copyVec3(payload.centroid),
    }

    this.dispatch(new CreatePaneCommand(this.sceneGraph, descriptor))
  }

  // ── Internal dispatch ──────────────────────────────────────────────────────

  private dispatch(command: ICommand): void {
    command.execute()
    this.pushUndo(command)
    this.redoStack.length = 0  // a fresh action invalidates any old redo chain
    this.emit(CommandEventType.Executed, { commandType: command.type })
  }

  private pushUndo(command: ICommand): void {
    this.undoStack.push(command)
    if (this.undoStack.length > MAX_UNDO_HISTORY) {
      this.undoStack.shift()  // bounded history — drop the oldest entry
    }
  }
}
