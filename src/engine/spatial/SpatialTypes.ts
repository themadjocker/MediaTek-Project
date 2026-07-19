
import type { EngineEvent } from '../types/EngineTypes'

// ─── SPATIAL NODE ──────────────────────────────────────────────────────────────

/** Plain mutable 3-vector — SpatialEngine's internal representation, same
 *  shape as Intent Engine's Vec3 but intentionally not importing that type:
 *  this is a scene-graph position, not a gesture-tracking point, even though
 *  the numbers happen to originate from one at creation time. */
export interface Vec3Mutable {
  x: number
  y: number
  z: number
}

/**
 * One node in the (currently flat) scene graph. Long-lived object identity —
 * created once by SpatialEngine.createPane(), its `position`/`scale` fields
 * are mutated in place by moveNode()/scaleNode() for the node's entire
 * lifetime rather than replaced. A future Renderer Engine can hold a
 * reference to a SpatialNode and read fresh position/scale each frame
 * exactly like every other buffer/object in this codebase — same contract
 * as Sensor/Intent's pre-allocated payloads: don't mutate it externally
 * (nothing enforces that at the type level, same convention as
 * HandSensorData.landmarks — see SensorTypes.ts).
 */
export interface SpatialNode {
  readonly id: string
  readonly createdAt: number

  /** Reserved for future nesting/grouping — see file-level docs. Every node
   *  today is a root node. */
  parentId: string | null

  /** World-space center of the pane (for a root node; local === world since
   *  nothing is nested yet). */
  readonly position: Vec3Mutable

  /** Non-uniform scale — (width, height, 1). A Renderer applies this to a
   *  shared unit quad rather than baking size into per-node geometry. */
  readonly scale: Vec3Mutable
}

// ─── SPATIAL ENGINE DOMAIN EVENTS ─────────────────────────────────────────────
// Deliberately carry only an id, not a snapshot — SpatialNode objects are
// long-lived and mutated in place (see doc above), so a consumer reacting to
// one of these just calls spatial.getNode(id) to read current values, the
// same pull-then-react pattern Sensor/Intent already established.

export enum SpatialEventType {
  /** A new node was added to the scene graph. */
  NodeAdded = 'spatial:nodeAdded',
  /** A node was removed from the scene graph. */
  NodeRemoved = 'spatial:nodeRemoved',
  /** A node's position and/or scale changed. Reserved for Phase 6
   *  (manipulation) — emitted now so Phase 6 only needs to call
   *  moveNode()/scaleNode(), not add a new event type. */
  NodeTransformed = 'spatial:nodeTransformed',
}

export interface SpatialNodeEventPayload {
  readonly id: string
}

/** Convenience alias — a SpatialEngine event is just an EngineEvent whose
 *  `type` happens to be a SpatialEventType and whose `payload` happens to be
 *  a SpatialNodeEventPayload. */
export type SpatialEvent = EngineEvent
