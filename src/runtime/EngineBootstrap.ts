import { SensorEngine } from '../engine/sensor/SensorEngine'
import { IntentEngine } from '../engine/intent/IntentEngine'
import { CommandEngine } from '../engine/command/CommandEngine'
import { SpatialEngine } from '../engine/spatial/SpatialEngine'
import { RendererEngine, type RendererValidationReport } from '../engine/renderer/RendererEngine'
import type { FrameContext, IEngine } from '../engine/types/EngineTypes'
import type { IMaterialProvider } from '../engine/renderer/RendererTypes'
import type * as THREE from 'three'

// ───────────────────────────────────────────────────────────────────────────
// Runtime state
// ───────────────────────────────────────────────────────────────────────────
export enum RuntimeState {
  Created = 0,
  Running = 1,
  Paused = 2,
  Stopped = 3,
  Disposed = 4,
  InitializationFailed = 5, // Added to allow retry after a failure
}

interface Diagnostics {
  frameCount: number
  initializedAt?: number
  disposedAt?: number
}

/** Unified diagnostic payload for the Phase 3 / Phase A Diagnostics Hub. */
export interface DiagnosticsSnapshot {
  timestamp: string
  engineStatus: 'ACTIVE' | 'AWAITING_CANVAS'
  spatial: ReturnType<SpatialEngine['getStatistics']>
  renderer: ReturnType<RendererEngine['getStatistics']> | null
  runtimeState: string
  engineCount: number
  frameCount: number
  uptimeMs: number
}

/** Read-only scene validation report coordinated by EngineBootstrap. */
export interface SceneValidationReport {
  valid: boolean
  runtimeState: string
  rendererAttached: boolean
  engineCount: number
  spatialNodeCount: number
  rendererMeshCount: number
  rendererValidation: RendererValidationReport | null
  issues: string[]
}

export interface ILogger {
  warn(message?: any, ...optionalParams: any[]): void
  error(message?: any, ...optionalParams: any[]): void
  info(message?: any, ...optionalParams: any[]): void
}

export class EngineBootstrap {
  // ─────────────────────────────────────────────────────────────────────────
  // Fields
  // ─────────────────────────────────────────────────────────────────────────

  public readonly sensor: SensorEngine
  public readonly intent: IntentEngine
  public readonly command: CommandEngine
  public readonly spatial: SpatialEngine
  private readonly logger: ILogger

  // Dynamic engine, exposed via getter to prevent external reassignment.
  private _renderer?: RendererEngine
  public get renderer(): RendererEngine | undefined {
    return this._renderer
  }

  private engines: IEngine[]

  private state: RuntimeState = RuntimeState.Created
  private readonly _diagnostics: Diagnostics = { frameCount: 0 }
  private readonly createdAt = Date.now()

  // ─────────────────────────────────────────────────────────────────────────
  // Constructor
  // ─────────────────────────────────────────────────────────────────────────

  constructor(logger: ILogger = console) {
    this.logger = logger

    // Construct in pure dependency order.
    this.sensor = new SensorEngine()
    this.intent = new IntentEngine(this.sensor)
    this.spatial = new SpatialEngine()
    this.command = new CommandEngine(this.intent, this.spatial)

    this.engines = [this.sensor, this.intent, this.command, this.spatial]
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  public initialize(): void {
    // Allow initialization if it's fresh OR if a previous attempt failed.
    if (this.state !== RuntimeState.Created && this.state !== RuntimeState.InitializationFailed) {
      throw new Error(
        `[EngineBootstrap] Cannot initialize: state is "${RuntimeState[this.state]}", expected "Created" or "InitializationFailed".`
      )
    }

    this.sortEngines()

    const started: IEngine[] = []
    try {
      for (const engine of this.engines) {
        engine.initialize()
        started.push(engine)
      }
    } catch (error) {
      this.logger.error('[EngineBootstrap] Initialization failed. Unwinding...', error)
      for (const engine of [...started].reverse()) {
        try {
          engine.dispose()
        } catch (disposeError) {
          this.logger.error(`[EngineBootstrap] "${engine.constructor.name}" failed to dispose during rollback.`, disposeError)
        }
      }

      this.state = RuntimeState.InitializationFailed
      throw error
    }

    this.state = RuntimeState.Running
    this._diagnostics.initializedAt = Date.now()
  }

  public tick(frame: FrameContext): void {
    if (this.state !== RuntimeState.Running) return

    this._diagnostics.frameCount++

    for (const engine of this.engines) {
      try {
        engine.update(frame)
      } catch (error) {
        this.logger.error(
          `[EngineBootstrap] "${engine.constructor.name}" threw during tick(); continuing with remaining engines this frame.`,
          error
        )
      }
    }
  }

  public pause(): void {
    if (this.state !== RuntimeState.Running) return
    this.state = RuntimeState.Paused
    for (const engine of this.engines) {
      engine.pause()
    }
  }

  public resume(): void {
    if (this.state !== RuntimeState.Paused) return
    this.state = RuntimeState.Running
    for (const engine of this.engines) {
      engine.resume()
    }
  }

  public stop(): void {
    if (this.state !== RuntimeState.Running && this.state !== RuntimeState.Paused) return
    this.state = RuntimeState.Stopped
    for (const engine of this.engines) {
      engine.stop()
    }
  }

  public dispose(): void {
    if (this.state === RuntimeState.Disposed) return
    this.state = RuntimeState.Disposed
    this._diagnostics.disposedAt = Date.now()

    this.detachRenderer()

    // Reverse dependency order disposal: consumers release before providers.
    for (const engine of [...this.engines].reverse()) {
      try {
        engine.dispose()
      } catch (error) {
        this.logger.error(`[EngineBootstrap] "${engine.constructor.name}" failed to dispose cleanly.`, error)
      }
    }

    this.engines = []
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Engine Registry & Resolution
  // ─────────────────────────────────────────────────────────────────────────

  public registerEngine(engine: IEngine): void {
    if (this.state === RuntimeState.Disposed) {
      throw new Error('[EngineBootstrap] Cannot register engine: bootstrap is disposed.')
    }
    if (this.state === RuntimeState.Stopped) {
      throw new Error('[EngineBootstrap] Cannot register engine: runtime is stopped.')
    }

    this.engines.push(engine)
    this.sortEngines()

    if (this.state !== RuntimeState.Created && this.state !== RuntimeState.InitializationFailed) {
      try {
        engine.initialize()
        if (this.state === RuntimeState.Paused) engine.pause()
      } catch (error) {
        this.logger.error('[EngineBootstrap] Dynamic engine registration failed. Rolling back.', error)
        this.unregisterEngine(engine)
        throw error
      }
    }
  }

  public unregisterEngine(engine: IEngine): void {
    if (!this.removeEngine(engine)) return

    try {
      engine.dispose()
    } catch (error) {
      this.logger.error(`[EngineBootstrap] "${engine.constructor.name}" failed to dispose during unregister.`, error)
    }
  }

  private removeEngine(engine: IEngine): boolean {
    const index = this.engines.indexOf(engine)
    if (index === -1) return false
    this.engines.splice(index, 1)
    return true
  }

  public resolve<T extends IEngine>(engineClass: new (...args: any[]) => T): T | undefined {
    return this.engines.find((e): e is T => e instanceof engineClass)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Renderer (Dynamic Attachment)
  // ─────────────────────────────────────────────────────────────────────────

  public attachRenderer(scene: THREE.Scene, materials: IMaterialProvider): void {
    if (this._renderer) {
      this.logger.warn('[EngineBootstrap] Renderer already attached.')
      return
    }
    if (this.state === RuntimeState.Disposed) {
      throw new Error('[EngineBootstrap] Cannot attach renderer: bootstrap is disposed.')
    }

    const newRenderer = new RendererEngine(this.spatial, scene, materials)
    this._renderer = newRenderer

    try {
      this.registerEngine(newRenderer)
    } catch (error) {
      // registerEngine already unregistered/disposed it on failure; just clear the reference.
      this._renderer = undefined
      throw error
    }
  }

  public detachRenderer(): void {
    if (!this._renderer) return
    this.unregisterEngine(this._renderer)
    this._renderer = undefined
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command Shortcuts
  // ─────────────────────────────────────────────────────────────────────────

  public undo(): boolean { return this.command.undo() }
  public redo(): boolean { return this.command.redo() }
  public canUndo(): boolean { return this.command.canUndo() }
  public canRedo(): boolean { return this.command.canRedo() }

  // ─────────────────────────────────────────────────────────────────────────
  // Diagnostics Hub (Phase A)
  // ─────────────────────────────────────────────────────────────────────────

  public validateScene(): SceneValidationReport {
    const spatialStats = this.spatial.getStatistics()

    const report: SceneValidationReport = {
      valid: true,
      runtimeState: RuntimeState[this.state],
      rendererAttached: false,
      engineCount: this.engines.length,
      spatialNodeCount: spatialStats.nodeCount,
      rendererMeshCount: 0,
      rendererValidation: null,
      issues: [],
    }

    // Rule 1 — Renderer must be attached
    if (!this._renderer) {
      report.valid = false
      report.issues.push('Renderer is not attached.')
      return report
    }

    report.rendererAttached = true

    // Rule 2 — Collect renderer statistics + self-validation
    const rendererStats = this._renderer.getStatistics()
    const rendererValidation = this._renderer.validateMeshes()

    report.rendererMeshCount = rendererStats.meshCount
    report.rendererValidation = rendererValidation

    // Rule 3 — Cross-engine consistency (node count vs mesh count)
    if (report.spatialNodeCount !== report.rendererMeshCount) {
      report.valid = false
      report.issues.push(
        `Spatial contains ${report.spatialNodeCount} nodes while Renderer manages ${report.rendererMeshCount} meshes.`
      )
    }

    // Rule 4 — Cascade renderer validation failures (forward as-is)
    if (rendererValidation.valid === false) {
      report.valid = false
      report.issues.push(...rendererValidation.issues)
    }

    return report
  }

  public getRendererStatistics(): ReturnType<RendererEngine['getStatistics']> | null {
    if (!this._renderer) {
      this.logger.warn('[EngineBootstrap] Renderer is not attached yet.')
      return null
    }
    return this._renderer.getStatistics()
  }

  public getDiagnosticsSnapshot(): DiagnosticsSnapshot {
    return {
      timestamp:    new Date().toISOString(),
      engineStatus: this._renderer ? 'ACTIVE' : 'AWAITING_CANVAS',
      spatial:      this.spatial.getStatistics(),
      renderer:     this.getRendererStatistics(),
      // retained runtime fields
      runtimeState: RuntimeState[this.state],
      engineCount:  this.engines.length,
      frameCount:   this._diagnostics.frameCount,
      uptimeMs:     this._diagnostics.initializedAt
        ? (this._diagnostics.disposedAt ?? Date.now()) - this._diagnostics.initializedAt
        : 0,
    }
  }

  public dumpScene(): void {
    if (!this._renderer) {
      this.logger.warn('[EngineBootstrap] Renderer is not attached yet — cannot dump scene.')
      return
    }

    // Structural access for diagnostics (avoids `any`)
    const scene = (this._renderer as unknown as { scene: THREE.Scene }).scene
    if (!scene) {
      this.logger.warn('[EngineBootstrap] Renderer has no accessible scene.')
      return
    }

    const tree = this.printSceneGraph(scene)
    console.log('[EngineBootstrap] THREE.js Scene Graph:\n' + tree)
  }

  private printSceneGraph(
    object: THREE.Object3D,
    depth: number = 0,
    isLast: boolean = true,
    prefix: string = '',
  ): string {
    const connector = depth === 0 ? '' : isLast ? '└─ ' : '├─ '
    const name = object.name || object.type || 'Object3D'

    let extra = ''
    if (object.type === 'Mesh') {
      extra = ' (Mesh)'
    } else if (object.type === 'Scene') {
      extra = ` (Scene, children=${object.children.length})`
    } else if (object.children.length > 0) {
      extra = ` (children=${object.children.length})`
    }

    let result = `${prefix}${connector}${name}${extra}\n`

    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ')
    const children = object.children
    for (let i = 0; i < children.length; i++) {
      const last = i === children.length - 1
      result += this.printSceneGraph(children[i], depth + 1, last, childPrefix)
    }

    return result
  }

  public dumpRuntime(): void {
    const uptimeMs = Date.now() - this.createdAt
    const engineStatus = this._renderer ? 'ACTIVE' : 'AWAITING_CANVAS'

    // Safe environment detection without relying on Node's `process`
    let environment = 'Development'
    try {
      if (typeof import.meta !== 'undefined' && (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE) {
        environment = (import.meta as ImportMeta & { env?: { MODE?: string } }).env!.MODE!
      }
    } catch {}

    console.groupCollapsed('[EngineBootstrap] Runtime State')
    console.table({
      uptime: `${(uptimeMs / 1000).toFixed(1)}s (${uptimeMs} ms)`,
      environment,
      engineStatus,
      runtimeState: RuntimeState[this.state],
      frameCount: this._diagnostics.frameCount,
      engineCount: this.engines.length,
    })
    console.groupEnd()
  }

  public dumpEngines(): void {
    console.groupCollapsed('[EngineBootstrap] Connected Engines')

    const statusTable = {
      Sensor:   this.sensor   ? 'INSTANTIATED' : 'undefined',
      Intent:   this.intent   ? 'INSTANTIATED' : 'undefined',
      Command:  this.command  ? 'INSTANTIATED' : 'undefined',
      Spatial:  this.spatial  ? 'INSTANTIATED' : 'undefined',
      Renderer: this._renderer ? 'INSTANTIATED' : 'undefined',
    }
    console.table(statusTable)

    // Nested statistics for engines that expose getStatistics()
    if (this.spatial) {
      console.groupCollapsed('[EngineBootstrap] SpatialEngine statistics')
      console.table(this.spatial.getStatistics())
      console.groupEnd()
    }

    if (this._renderer) {
      console.groupCollapsed('[EngineBootstrap] RendererEngine statistics')
      console.table(this._renderer.getStatistics())
      console.groupEnd()
    }

    console.groupEnd()
  }

  public dumpRenderer(): void {
    if (!this._renderer) {
      this.logger.warn('[EngineBootstrap] Renderer is not attached yet — cannot dump renderer.')
      return
    }
    console.log('[EngineBootstrap] Dumping RendererEngine Instance:')
    console.log(this._renderer)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private sortEngines(): void {
    this.engines.sort((a, b) => a.priority - b.priority)
  }
}