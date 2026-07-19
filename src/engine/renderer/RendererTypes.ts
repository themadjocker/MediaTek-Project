/**
 * RendererTypes.ts
 *
 * Spatial Vision Engine (SVE) — Phase 6: Renderer Engine.
 *
 * "Turn what exists (Spatial Engine's nodes) into what's actually on
 * screen." This is the ONE engine in the stack allowed to import 'three' —
 * every other engine (Sensor/Intent/Command/Spatial) is deliberately
 * framework-agnostic; Renderer Engine's entire reason to exist is being the
 * boundary where SceneGraph data becomes WebGL.
 *
 * ── The material problem, and IMaterialProvider ───────────────────────────
 * Renderer Engine can build a THREE.Mesh from a SpatialNode's position/scale
 * on its own — that part is pure geometry. But it CANNOT decide what
 * MATERIAL that mesh should use: the actual shader materials (CRT, glitch,
 * threshold, composite crossfade, ...) are built by CoreReactor.tsx's own
 * `buildShaderRegistry()`, which needs a THREE.WebGLRenderer and a
 * THREE.VideoTexture that only exist inside the React/R3F tree — things
 * Renderer Engine has no business depending on directly (that would pull
 * React into the engine stack, which every other file in engine/ has
 * explicitly avoided).
 *
 * IMaterialProvider is the seam: Renderer Engine asks it "what material for
 * this node id", and whoever constructs Renderer Engine (application code,
 * inside the Canvas tree, where shaderRegistry already exists) supplies the
 * answer. This is the exact same pattern as ISceneGraphPort in Phase 4 —
 * Renderer Engine depends on an abstract contract, not a concrete
 * implementation, so swapping shader systems later never requires touching
 * this engine.
 *
 * Note this also means SpatialNode (Phase 5) correctly has NO shaderID
 * field — "which shader" is a rendering/appearance decision, not a
 * geometry/hierarchy one, so it doesn't belong on a Spatial Engine node.
 * It's resolved entirely inside whatever IMaterialProvider is supplied here.
 */

import type * as THREE from 'three'

export interface IMaterialProvider {
  /** Called once, the first time Renderer Engine creates a mesh for this
   *  node id. Whatever is returned is applied to that mesh's `material` and
   *  is NOT re-queried on every frame — if a provider needs to change a
   *  node's appearance later, that's a future Phase 6b concern (e.g. a
   *  material-swap event), not something this call is re-invoked for. */
  getMaterial(nodeId: string): THREE.Material

  /** Called when Renderer Engine destroys a node's mesh (node removed from
   *  Spatial Engine). Optional — a provider whose materials are shared
   *  singletons (like CoreReactor's shaderRegistry, one material per shader
   *  type, reused across every pane) has nothing to release per-node and can
   *  omit this entirely. A provider that bakes a unique resource per pane
   *  (e.g. a render-to-texture cache) implements this to dispose it. */
  releaseMaterial?(nodeId: string): void
}
