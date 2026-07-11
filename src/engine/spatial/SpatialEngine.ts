

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

/** Runs after Command (priority 20) — nothing in this stack calls into
 *  SpatialEngine from a lower-priority engine's onUpdate, but keeping it
 *  ordered after Command documents the dependency direction even though
 *  today's flow is event-driven (Command calls createPane()/removePane()
 *  directly), not a per-frame poll. */
export const SPATIAL_ENGINE_PRIORITY = 30

export class SpatialEngine extends Engine implements ISceneGraphPort {
  private readonly nodes = new Map<string, SpatialNode>()
  /** Insertion order, oldest first — the FIFO eviction queue at MAX_PANES.
   *  A plain array of ids parallel to `nodes`, not a duplicate of node data. */
  private readonly insertionOrder: string[] = []

  constructor() {
    super('SpatialEngine', SPATIAL_ENGINE_PRIORITY)
  }

  protected onInitialize(): void {
    this.nodes.clear()
    this.insertionOrder.length = 0
  }

  /** Spatial Engine is event-driven (createPane/removePane are called
   *  directly by Command Engine's dispatch), not polled — nothing to do per
   *  frame today. Reserved for Phase 6, if e.g. continuous manipulation ever
   *  needs a per-frame settle/clamp pass rather than discrete moveNode() calls. */
  protected onUpdate(_frame: FrameContext): void {}

  protected onDispose(): void {
    this.nodes.clear()
    this.insertionOrder.length = 0
  }

  // ── ISceneGraphPort ────────────────────────────────────────────────────────

  public createPane(descriptor: PaneCreateDescriptor): string {
    if (this.insertionOrder.length >= MAX_PANES) {
      // FIFO eviction — oldest pane goes to make room, mirroring the ring-
      // buffer behavior the UI already displays a "wrapping" state for.
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

    this.nodes.set(id, node)
    this.insertionOrder.push(id)
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

  /** Returns the engine's own long-lived SpatialNode object — DO NOT mutate
   *  externally (see SpatialTypes.ts doc); read fresh fields each frame,
   *  same contract as every other engine object in this stack. */
  public getNode(id: string): SpatialNode | undefined {
    return this.nodes.get(id)
  }

  /** All current node ids, oldest first. A copy — safe to iterate while the
   *  engine mutates its own internal state elsewhere. */
  public getAllNodeIds(): readonly string[] {
    return [...this.insertionOrder]
  }

  public getNodeCount(): number {
    return this.nodes.size
  }

  /** Direct children of a node — unexercised today (nothing sets parentId
   *  yet), present for the day a grouping feature needs it. O(n) scan is
   *  fine at MAX_PANES scale; not a hot-path method. */
  public getChildren(parentId: string): SpatialNode[] {
    const result: SpatialNode[] = []
    for (const node of this.nodes.values()) {
      if (node.parentId === parentId) result.push(node)
    }
    return result
  }

  // ── Transform mutation — reserved for Phase 6 ──────────────────────────────

  /** Move a node to an absolute world-space position, in place. Reserved
   *  for Phase 6: a future ScalePaneCommand/MovePaneCommand calls this from
   *  Command Engine in response to IntentEngine's ScaleHint or a grab
   *  gesture — this engine has no opinion on what triggered the move. */
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

/**
 * Bounding-box center + size from a PaneCreateDescriptor's 4 corners — the
 * exact same AABB derivation CoreReactor's own FrozenPane component already
 * does, kept consistent so a node's position/scale mean what a renderer
 * would expect regardless of which system (engine stack or legacy path)
 * ultimately produced them.
 */
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
