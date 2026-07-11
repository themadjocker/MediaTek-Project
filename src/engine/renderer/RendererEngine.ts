/**
 * RendererEngine.ts
 *
 * Spatial Vision Engine (SVE) — Phase 6: Renderer Engine.
 *
 * Subscribes to SpatialEngine's domain events and mirrors its node map as
 * real THREE.Mesh objects in a THREE.Scene. This is the final layer:
 *
 *   Sensor → Intent → Command → Spatial → Renderer
 *
 * Every node SpatialEngine creates gets a mesh added to the scene; every
 * node it removes gets its mesh removed; every transform mutation
 * (moveNode/scaleNode, reserved for Phase 6b manipulation) gets mirrored
 * onto the existing mesh's position/scale.
 *
 * ── What this engine owns ─────────────────────────────────────────────────
 *  - One THREE.Mesh per SpatialNode, added/removed from the supplied Scene
 *  - A SHARED unit-quad geometry (module-level, one instance for every mesh
 *    this engine ever creates) — mirrors the exact pattern CoreReactor's own
 *    non-engine rendering already settled on: a pane's size is a `scale`
 *    transform, never baked into per-node vertex data
 *  - Keeping mesh.position/scale in sync with SpatialNode.position/scale
 *
 * ── What this engine does NOT own ─────────────────────────────────────────
 *  - Deciding what material a pane gets — see RendererTypes.ts's
 *    IMaterialProvider doc for why that's an injected seam, not something
 *    this file resolves itself
 *  - The THREE.Scene/Camera/WebGLRenderer lifecycle — those are owned by
 *    whatever React/R3F code constructs this engine (a Canvas already
 *    manages its own render loop; this engine only adds/removes objects
 *    from a scene graph it's handed, it does not call renderer.render()
 *    itself or run its own rAF loop)
 */

import * as THREE                from 'three'
import { Engine }                from '../core/Engine'
import type { FrameContext, EngineEvent } from '../types/EngineTypes'
import type { SpatialEngine }    from '../spatial/SpatialEngine'
import { SpatialEventType, type SpatialNodeEventPayload } from '../spatial/SpatialTypes'
import type { IMaterialProvider } from './RendererTypes'

/** Final stage — after Spatial (30). */
export const RENDERER_ENGINE_PRIORITY = 40

// ─── SHARED UNIT-QUAD GEOMETRY ───────────────────────────────────────────────
// One geometry, reused by every mesh this engine ever creates — a node's
// actual position/size is a THREE.Object3D transform, never vertex data.
// Same corner/UV convention CoreReactor's own _unitQuadGeom already uses:
// BL, BR, TL, TR with v=1 at the top, so a video texture displays right-side up.
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

    // Defensive sync: if SpatialEngine already had nodes at the moment this
    // engine initialized (e.g. re-initializing Renderer without a matching
    // Spatial reset), mirror them now rather than waiting for a future event
    // that will never fire for already-existing nodes.
    for (const id of this.spatial.getAllNodeIds()) {
      this.createMeshFor(id)
    }
  }

  /** Renderer Engine is purely event-driven — Spatial Engine's emit() calls
   *  (themselves triggered synchronously by Command Engine's dispatch) are
   *  what create/update/destroy meshes. Nothing to poll per frame. The
   *  actual screen render is driven by R3F's own Canvas loop, which this
   *  engine does not touch. */
  protected onUpdate(_frame: FrameContext): void {}

  protected onDispose(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe())
    this.unsubscribers = []

    for (const id of [...this.meshes.keys()]) {
      this.destroyMeshFor(id)
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
    if (!node) return   // NodeAdded fired but node already gone (rapid create+remove same frame) — nothing to do

    const material = this.materials.getMaterial(id)
    const mesh = new THREE.Mesh(_unitQuadGeom, material)
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
    // Geometry is the shared module-level singleton — never disposed here.
    // Material ownership belongs to IMaterialProvider (may be a shared
    // singleton itself, e.g. one material per shader type) — only the
    // provider knows whether disposing is correct, hence the optional hook.
    this.materials.releaseMaterial?.(id)
  }
}
