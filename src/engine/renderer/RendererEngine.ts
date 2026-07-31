import * as THREE                from 'three'
import { Engine }                from '../core/Engine'
import type { FrameContext, EngineEvent } from '../types/EngineTypes'
import type { SpatialEngine }    from '../spatial/SpatialEngine'
import {
  SpatialEventType,
  type SpatialNode,
  type SpatialNodeEventPayload,
} from '../spatial/SpatialTypes'
import type { IMaterialProvider } from './RendererTypes'

/** Final stage — after Spatial (30). */
export const RENDERER_ENGINE_PRIORITY = 40

export interface RendererValidationReport {
  valid: boolean
  meshCount: number
  invalidMeshes: Array<{ id: string; reason: string }>
  orphanMeshes: string[]
  issues: string[]
}

// ─── SHARED UNIT-QUAD GEOMETRY ───────────────────────────────────────────────

const _unitQuadGeom = (() => {
  const g   = new THREE.BufferGeometry()
  const pos = new Float32Array([-0.5, -0.5, 0,  0.5, -0.5, 0,  -0.5, 0.5, 0,  0.5, 0.5, 0])
  const uv  = new Float32Array([ 0, 0,          1, 0,          0, 1,          1, 1])
  const idx = new Uint16Array([0, 1, 2,  2, 1, 3])
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv',       new THREE.BufferAttribute(uv, 2))
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  return g
})()

export class RendererEngine extends Engine {
  private readonly spatial:   SpatialEngine
  private readonly scene:     THREE.Scene
  private readonly materials: IMaterialProvider

  private readonly meshes = new Map<string, THREE.Mesh>()
  private unsubscribers: Array<() => void> = []

  constructor(spatial: SpatialEngine, scene: THREE.Scene, materials: IMaterialProvider) {
    super('RendererEngine', RENDERER_ENGINE_PRIORITY)
    this.spatial   = spatial
    this.scene     = scene
    this.materials = materials
  }

  protected onInitialize(): void {
    this.unsubscribers = [
      this.spatial.on(SpatialEventType.NodeAdded,       this.handleNodeAdded),
      this.spatial.on(SpatialEventType.NodeRemoved,     this.handleNodeRemoved),
      this.spatial.on(SpatialEventType.NodeTransformed, this.handleNodeTransformed),
    ]

    for (const id of this.spatial.getAllNodeIds()) {
      this.createMeshFor(id)
    }
  }

  protected onUpdate(_frame: FrameContext): void {}

  protected onDispose(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe())
    this.unsubscribers = []

    for (const id of [...this.meshes.keys()]) {
      this.destroyMeshFor(id)
    }
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────

  public getStatistics() {
    return {
      meshCount:     this.meshes.size,
      sceneChildren: this.scene.children.length,
    }
  }

  public validateMeshes(): RendererValidationReport {
    const report: RendererValidationReport = {
      valid: true,
      meshCount: this.meshes.size,
      invalidMeshes: [],
      orphanMeshes: [],
      issues: [],
    }

    for (const [id, mesh] of this.meshes.entries()) {
      let isMeshValid = true

      const invalidate = (message: string) => {
        report.issues.push(message)
        report.invalidMeshes.push({ id, reason: message })
        isMeshValid = false
      }

      if (!mesh.geometry) {
        invalidate(`${id}: Missing geometry`)
      }

      if (!mesh.material) {
        invalidate(`${id}: Missing material`)
      }

      if (mesh.parent !== this.scene) {
        invalidate(`${id}: Mesh exists but is not attached to scene`)
      }

      const { position, scale } = mesh
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
        invalidate(`${id}: Invalid position (non-finite)`)
      }

      if (!Number.isFinite(scale.x) || !Number.isFinite(scale.y) || !Number.isFinite(scale.z)) {
        invalidate(`${id}: Invalid scale (non-finite)`)
      }

      const spatialNode = this.spatial.getNode(id)
      if (!spatialNode) {
        invalidate(`${id}: Missing SpatialNode (Orphaned)`)
        report.orphanMeshes.push(id)
      }

      if (!isMeshValid) {
        report.valid = false
      }
    }

    return report
  }

  // ── Fail-fast validation (SVE migration) ───────────────────────────────────

  private validateNode(node: SpatialNode): void {
    const { position, scale } = node

    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z)
    ) {
      throw new Error(
        `[RendererEngine] Invalid SpatialNode ${node.id} detected — position contains non-finite value (x=${position.x}, y=${position.y}, z=${position.z})`
      )
    }

    if (
      !Number.isFinite(scale.x) ||
      !Number.isFinite(scale.y) ||
      !Number.isFinite(scale.z)
    ) {
      throw new Error(
        `[RendererEngine] Invalid SpatialNode ${node.id} detected — scale contains non-finite value (x=${scale.x}, y=${scale.y}, z=${scale.z})`
      )
    }
  }

  // ── Spatial event handlers ────────────────────────────────────────────────

  private handleNodeAdded = (event: EngineEvent): void => {
    const { id } = event.payload as SpatialNodeEventPayload
    this.createMeshFor(id)
  }

  private handleNodeRemoved = (event: EngineEvent): void => {
    const { id } = event.payload as SpatialNodeEventPayload
    this.destroyMeshFor(id)
  }

  private handleNodeTransformed = (event: EngineEvent): void => {
    const { id } = event.payload as SpatialNodeEventPayload
    const mesh = this.meshes.get(id)
    const node = this.spatial.getNode(id)
    if (!mesh || !node) return   // node may have been removed same-frame; NodeRemoved handler already cleaned up
    mesh.position.set(node.position.x, node.position.y, node.position.z)
    mesh.scale.set(node.scale.x, node.scale.y, node.scale.z)
  }

  // ── Mesh lifecycle ─────────────────────────────────────────────────────────

  private createMeshFor(id: string): void {
    if (this.meshes.has(id)) return   // defensive: don't double-create on a redundant event

    const node = this.spatial.getNode(id)
    if (!node) {
      console.warn(`[RendererEngine] Node ${id} not found in SpatialEngine.`)
      return
    }

    // Temporary diagnostic logging to assist remote debugging
    console.groupCollapsed('[RendererEngine] createMesh')
    console.log(node)
    console.log(node.position)
    console.log(node.scale)
    console.groupEnd()

    // Fail-fast: catch corrupted data before Three.js starts complaining
    this.validateNode(node)

    const material = this.materials.getMaterial(id)
    const mesh = new THREE.Mesh(_unitQuadGeom, material)
    mesh.name = `RendererMesh_${id}`   // helpful in Three.js inspector
    mesh.position.set(node.position.x, node.position.y, node.position.z)
    mesh.scale.set(node.scale.x, node.scale.y, node.scale.z)

    this.scene.add(mesh)
    this.meshes.set(id, mesh)
  }

  private destroyMeshFor(id: string): void {
    const mesh = this.meshes.get(id)
    if (!mesh) return
    this.scene.remove(mesh)
    this.meshes.delete(id)
    this.materials.releaseMaterial?.(id)
  }
}