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

export const COMMAND_ENGINE_PRIORITY = 20

// ─── HISTORY MODEL ─────────────────────────────────────────────────────────────

/** Lightweight description of a single command currently sitting in a stack. */
export interface CommandHistoryEntry {
  index: number
  type: string
  stack: 'UNDO' | 'REDO'
}

/** Structured snapshot of both undo and redo stacks. */
export interface CommandHistory {
  undo: CommandHistoryEntry[]
  redo: CommandHistoryEntry[]
}

// ─── COMMANDS ──────────────────────────────────────────────────────────────────

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

  protected onUpdate(_frame: FrameContext): void {}

  protected onDispose(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe())
    this.unsubscribers = []
    this.undoStack.length = 0
    this.redoStack.length = 0
  }

  // ── Public undo/redo API ──────────────────────────────────────────────────

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

  // ── Command History Diagnostics (Phase 3 / Commit 3.1) ────────────────────

  public getHistory(): CommandHistory {
    const undo: CommandHistoryEntry[] = this.undoStack.map((command, index) => ({
      index,
      type: command.type,
      stack: 'UNDO' as const,
    }))

    const redo: CommandHistoryEntry[] = this.redoStack.map((command, index) => ({
      index,
      type: command.type,
      stack: 'REDO' as const,
    }))

    return { undo, redo }
  }

  public dumpHistory(): void {
    const history = this.getHistory()

    console.groupCollapsed('[CommandEngine] Command History')

    console.groupCollapsed(`Undo Stack (${history.undo.length})`)
    if (history.undo.length === 0) {
      console.log('(empty)')
    } else {
      console.table(history.undo)
    }
    console.groupEnd()

    console.groupCollapsed(`Redo Stack (${history.redo.length})`)
    if (history.redo.length === 0) {
      console.log('(empty)')
    } else {
      console.table(history.redo)
    }
    console.groupEnd()

    console.groupEnd()
  }

  // ── Intent event handlers ─────────────────────────────────────────────────

  private handlePinchEnd = (event: EngineEvent): void => {
    const payload = event.payload as PinchEndPayload
    if (payload.wasSignalLoss) return
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