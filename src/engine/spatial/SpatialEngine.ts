
import { Engine }                from '../core/Engine'
import type { FrameContext }     from '../types/EngineTypes'
import {
  SpatialEventType,
  type SpatialNode,
  type Vec3Mutable,
  type SpatialNodeEventPayload,
} from './SpatialTypes'
import type { ISceneGraphPort, PaneCreateDescriptor } from '../command/CommandTypes'
import { MAX_PANES, MIN_PANE_SIZE } from '@constants/index'

export const SPATIAL_ENGINE_PRIORITY = 30

export class SpatialEngine extends Engine implements ISceneGraphPort {
  private readonly nodes = new Map<string, SpatialNode>()
  private readonly insertionOrder: string[] = []

  constructor() {
    super('SpatialEngine', SPATIAL_ENGINE_PRIORITY)
  }

  protected onInitialize(): void {
    this.nodes.clear()
    this.insertionOrder.length = 0
  }

  protected onUpdate(_frame: FrameContext): void {}

  protected onDispose(): void {
    this.nodes.clear()
    this.insertionOrder.length = 0
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
        `[SpatialEngine] Invalid Node ${node.id} detected at insertion — position contains non-finite value (x=${position.x}, y=${position.y}, z=${position.z})`
      )
    }

    if (
      !Number.isFinite(scale.x) ||
      !Number.isFinite(scale.y) ||
      !Number.isFinite(scale.z)
    ) {
      throw new Error(
        `[SpatialEngine] Invalid Node ${node.id} detected at insertion — scale contains non-finite value (x=${scale.x}, y=${scale.y}, z=${scale.z})`
      )
    }
  }

  public addNode(node: SpatialNode): void {
    this.validateNode(node)

    this.nodes.set(node.id, node)

    // Avoid duplicate entries in insertionOrder (O(n) but rare)
    if (!this.insertionOrder.includes(node.id)) {
      this.insertionOrder.push(node.id)
    }
  }

  // ── ISceneGraphPort ────────────────────────────────────────────────────────

  public createPane(descriptor: PaneCreateDescriptor): string {
    if (this.insertionOrder.length >= MAX_PANES) {
      const oldestId = this.insertionOrder.shift()
      if (oldestId !== undefined) {
        this.nodes.delete(oldestId)
        this.emit(SpatialEventType.NodeRemoved, { id: oldestId } satisfies SpatialNodeEventPayload)
      }
    }

    const id = crypto.randomUUID()
    const { position, scale } = boundsFromCorners(descriptor)

    const node: SpatialNode = {
      id,
      createdAt: Date.now(),
      parentId:  null,
      position,
      scale,
    }

    // Fail-fast: validate before any Map mutation
    this.addNode(node)

    this.emit(SpatialEventType.NodeAdded, { id } satisfies SpatialNodeEventPayload)

    return id
  }

  public removePane(id: string): void {
    if (!this.nodes.has(id)) return   // no-op on unknown id — see ISceneGraphPort contract
    this.nodes.delete(id)
    const idx = this.insertionOrder.indexOf(id)
    if (idx !== -1) this.insertionOrder.splice(idx, 1)
    this.emit(SpatialEventType.NodeRemoved, { id } satisfies SpatialNodeEventPayload)
  }

  // ── Query API — for a future Renderer Engine (Phase 6) ────────────────────

  public getNode(id: string): SpatialNode | undefined {
    return this.nodes.get(id)
  }

  public getAllNodeIds(): readonly string[] {
    return this.insertionOrder
  }

  public getNodeCount(): number {
    return this.nodes.size
  }

  public getChildren(parentId: string): SpatialNode[] {
    const result: SpatialNode[] = []
    for (const node of this.nodes.values()) {
      if (node.parentId === parentId) result.push(node)
    }
    return result
  }

  public getStatistics() {
    return {
      nodeCount: this.nodes.size,
      // Return the live array reference (readonly contract) instead of spreading
      insertionOrder: this.insertionOrder as readonly string[],
    }
  }

  // ── Transform mutation — reserved for Phase 6 ──────────────────────────────

  public moveNode(id: string, position: Readonly<Vec3Mutable>): void {
    const node = this.nodes.get(id)
    if (!node) return
    node.position.x = position.x
    node.position.y = position.y
    node.position.z = position.z
    this.emit(SpatialEventType.NodeTransformed, { id } satisfies SpatialNodeEventPayload)
  }

  /** Scale a node in place. Same Phase 6 reservation as moveNode(). */
  public scaleNode(id: string, scale: Readonly<Vec3Mutable>): void {
    const node = this.nodes.get(id)
    if (!node) return
    node.scale.x = Math.max(MIN_PANE_SIZE, scale.x)
    node.scale.y = Math.max(MIN_PANE_SIZE, scale.y)
    node.scale.z = scale.z
    this.emit(SpatialEventType.NodeTransformed, { id } satisfies SpatialNodeEventPayload)
  }
}

// ─── MATH ──────────────────────────────────────────────────────────────────────

function boundsFromCorners(
  descriptor: PaneCreateDescriptor,
): { position: Vec3Mutable; scale: Vec3Mutable } {
  const { tl, tr, br, bl } = descriptor.corners
  const xs = [tl.x, tr.x, br.x, bl.x]
  const ys = [tl.y, tr.y, br.y, bl.y]
  const zs = [tl.z, tr.z, br.z, bl.z]

  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const avgZ = (zs[0] + zs[1] + zs[2] + zs[3]) * 0.25

  return {
    position: { x: (minX + maxX) * 0.5, y: (minY + maxY) * 0.5, z: avgZ },
    scale:    { x: Math.max(MIN_PANE_SIZE, maxX - minX), y: Math.max(MIN_PANE_SIZE, maxY - minY), z: 1 },
  }
}