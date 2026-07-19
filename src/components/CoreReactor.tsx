
import { useRef, useEffect, useMemo, useState, memo } from 'react'
import { Canvas, useFrame, useThree }        from '@react-three/fiber'
import * as THREE                             from 'three'
import { videoElement }                       from './BootScreen'
import {
  liveBuffer,
  lastKnownBuffer,
  smoothedBuffer,
  updateSmoothing,
  frameTimestamp,
  handPresence,
  updateFrustum,
  LEFT_HAND_OFFSET,
  RIGHT_HAND_OFFSET,
}                         from '@data/landmarkStore'
import {
  PINCH_THRESHOLD_SQ,
  PINCH_DEBOUNCE_FRAMES,
  PINCH_RELEASE_DEBOUNCE,
  MIN_PANE_SIZE,
  Z_INCREMENT,
  THUMB_TIP_IDX,
  INDEX_TIP_IDX,
  STALE_FRAME_MS,
  SHADER_IDS,
  SHADER_IDS_EXT,
  SHADER_TRANSITION_FRAMES,
  FROZEN_BAKE_SIZE,
  CAMERA_FOV,
  CAMERA_Z,
  PINCH_INDICATOR_RADIUS,
  PANE_DROP_FLASH_FRAMES,
}                         from '@constants/index'
import {
  useUIStore,
  selectPanes,
  selectDebugMode,
  type PaneDescriptor,
}                         from '@stores/useUIStore'
import { HandSkeleton }   from './HandSkeleton'

import passthroughFrag     from '@shaders/passthrough.frag?raw'
import thresholdFrag       from '@shaders/threshold.frag?raw'
import crtFrag             from '@shaders/crt.frag?raw'
import glitchFrag          from '@shaders/glitch.frag?raw'
import wireframeFrag       from '@shaders/wireframe.frag?raw'
import compositeFrag       from '@shaders/composite.frag?raw'
import paneVert            from '@shaders/pane.vert?raw'
import pinchIndicatorVert  from '@shaders/pinch_indicator.vert?raw'
import pinchIndicatorFrag  from '@shaders/pinch_indicator.frag?raw'

// ─── MODULE-LEVEL SCRATCH BUFFERS ────────────────────────────────────────────

const _leftPinchPoint  = new Float32Array(3)  // midpoint of left thumb+index
const _rightPinchPoint = new Float32Array(3)  // midpoint of right thumb+index
const _rectVerts       = new Float32Array(18) // 6 verts × xyz (2 tris) for live preview

// ─── SHARED UNIFORM ──────────────────────────────────────────────────────────

const sharedUniforms = { uTime: { value: 0 } }

// ─── SHADER REGISTRY ─────────────────────────────────────────────────────────

function buildShaderRegistry(videoTexture: THREE.VideoTexture) {
  const mkShared = () => ({
    uTexture: { value: videoTexture },
    uTime:    sharedUniforms.uTime,  // shared ref — one write, all update
  })

  return {
    [SHADER_IDS.PASSTHROUGH]: new THREE.RawShaderMaterial({
      vertexShader: paneVert, fragmentShader: passthroughFrag,
      uniforms: mkShared(), side: THREE.DoubleSide,
    }),
    [SHADER_IDS.THRESHOLD]: new THREE.RawShaderMaterial({
      vertexShader: paneVert, fragmentShader: thresholdFrag,
      uniforms: { ...mkShared(), uThreshold: { value: 0.5 } }, side: THREE.DoubleSide,
    }),
    [SHADER_IDS.CRT]: new THREE.RawShaderMaterial({
      vertexShader: paneVert, fragmentShader: crtFrag,
      uniforms: { ...mkShared(), uIntensity: { value: 0.6 } }, side: THREE.DoubleSide,
    }),
    [SHADER_IDS.GLITCH]: new THREE.RawShaderMaterial({
      vertexShader: paneVert, fragmentShader: glitchFrag,
      uniforms: { ...mkShared(), uGlitch: { value: 0.3 }, uSeed: { value: 0 } }, side: THREE.DoubleSide,
    }),
    [SHADER_IDS.WIREFRAME]: new THREE.RawShaderMaterial({
      vertexShader: paneVert, fragmentShader: wireframeFrag,
      uniforms: { uTime: sharedUniforms.uTime }, side: THREE.DoubleSide, transparent: true,
    }),
    [SHADER_IDS_EXT.COMPOSITE]: new THREE.RawShaderMaterial({
      vertexShader: paneVert, fragmentShader: compositeFrag,
      uniforms: {
        ...mkShared(),
        uThreshold: { value: 0.5 },
        uIntensity: { value: 0.6 },
        uGlitch:    { value: 0.3 },
        uSeed:      { value: 0 },
        uBlend:     { value: 0 },
        uModeA:     { value: SHADER_IDS.PASSTHROUGH },
        uModeB:     { value: SHADER_IDS.PASSTHROUGH },
      },
      side: THREE.DoubleSide,
    }),
  }
}

type ShaderRegistry = ReturnType<typeof buildShaderRegistry>

// ─── FROZEN PANE RENDER CACHE ────────────────────────────────────────────────

const _bakeScene  = new THREE.Scene()
const _bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
const _bakeGeom   = (() => {
  const g   = new THREE.BufferGeometry()
  const pos = new Float32Array([-1, -1, 0,  1, -1, 0,  1, 1, 0,  -1, -1, 0,  1, 1, 0,  -1, 1, 0])
  const uv  = new Float32Array([ 0,  0,      1,  0,     1, 1,      0,  0,     1, 1,     0,  1])
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv',       new THREE.BufferAttribute(uv, 2))
  return g
})()
const _bakeMesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material> =
  new THREE.Mesh(_bakeGeom, new THREE.MeshBasicMaterial())
_bakeScene.add(_bakeMesh)

function bakeMaterialToTexture(
  gl:       THREE.WebGLRenderer,
  material: THREE.Material,
  size = FROZEN_BAKE_SIZE,
): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format:    THREE.RGBAFormat,
  })

  _bakeMesh.material = material
  const prevTarget = gl.getRenderTarget()
  gl.setRenderTarget(target)
  gl.render(_bakeScene, _bakeCamera)
  gl.setRenderTarget(prevTarget)

  return target
}

/** Cheap static display material — just samples the baked texture. */
function buildCacheDisplayMaterial(texture: THREE.Texture): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    vertexShader:   paneVert,
    fragmentShader: passthroughFrag,
    uniforms:       { uTexture: { value: texture } },
    side:           THREE.DoubleSide,
  })
}

// ─── PINCH INDICATOR MESH ────────────────────────────────────────────────────
function buildPinchIndicatorMaterial() {
  return new THREE.RawShaderMaterial({
    vertexShader:   pinchIndicatorVert,
    fragmentShader: pinchIndicatorFrag,
    uniforms: {
      projectionMatrix:  { value: new THREE.Matrix4() },
      viewMatrix:        { value: new THREE.Matrix4() },
      uCenter:           { value: new THREE.Vector3() },
      uRadius:           { value: PINCH_INDICATOR_RADIUS },
      uPinchProgress:    { value: 0 },
      uPinchConfirmed:   { value: 0 },
      uTime:             sharedUniforms.uTime,
    },
    transparent: true,
    depthWrite:  false,
    blending:    THREE.AdditiveBlending,
  })
}

function buildIndicatorGeometry(): THREE.BufferGeometry {
  const SEGMENTS = 32
  const verts: number[] = []
  const uvs:   number[] = []
  const idx:   number[] = []

  // Center vertex
  verts.push(0, 0)
  uvs.push(0, 0)

  for (let i = 0; i <= SEGMENTS; i++) {
    const angle = (i / SEGMENTS) * Math.PI * 2
    verts.push(Math.cos(angle), Math.sin(angle))
    uvs.push(Math.cos(angle), Math.sin(angle))
  }
  for (let i = 1; i <= SEGMENTS; i++) {
    idx.push(0, i, i + 1)
  }
  idx[idx.length - 1] = 1  // close the fan

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 2))
  geom.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(uvs), 2))
  geom.setIndex(idx)
  return geom
}

function writeRectVerts(
  out: Float32Array,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
): void {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1)
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1)
  const z    = (z0 + z1) * 0.5

  // TL, TR, BR, BL
  const TLx = minX, TLy = maxY
  const TRx = maxX, TRy = maxY
  const BRx = maxX, BRy = minY
  const BLx = minX, BLy = minY

  out[0]  = TLx; out[1]  = TLy; out[2]  = z   // TL
  out[3]  = TRx; out[4]  = TRy; out[5]  = z   // TR
  out[6]  = BRx; out[7]  = BRy; out[8]  = z   // BR
  out[9]  = TLx; out[10] = TLy; out[11] = z   // TL (2nd tri)
  out[12] = BRx; out[13] = BRy; out[14] = z   // BR
  out[15] = BLx; out[16] = BLy; out[17] = z   // BL
}

// ─── SCENE ───────────────────────────────────────────────────────────────────

function Scene() {
  const { gl, scene, camera } = useThree()

  const setLiveDist = useUIStore((s) => s.setLiveDistance)
  const debugMode   = useUIStore(selectDebugMode)  // reactive — mount/unmount is rare, not hot-path

  // ── Refs that mirror Zustand state for zero-read hot path ─────────────────
  const uniformsRef      = useRef(useUIStore.getState().uniforms)
  const debugModeRef     = useRef(useUIStore.getState().debugMode)
  const activeShaderRef  = useRef<number>(useUIStore.getState().activeShaderID)
  const smoothingAlphaRef = useRef<number>(useUIStore.getState().smoothingAlpha)

  useEffect(() => {
    return useUIStore.subscribe((state) => {
      uniformsRef.current      = state.uniforms
      debugModeRef.current     = state.debugMode
      activeShaderRef.current  = state.activeShaderID
      smoothingAlphaRef.current = state.smoothingAlpha
    })
  }, [])

  // ── VideoTexture ──────────────────────────────────────────────────────────
  const videoTexture = useMemo(() => {
    if (!videoElement) return null
    const tex      = new THREE.VideoTexture(videoElement)
    tex.minFilter  = THREE.LinearFilter
    tex.magFilter  = THREE.LinearFilter
    tex.format     = THREE.RGBAFormat
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }, [])

  // ── Shader registry ───────────────────────────────────────────────────────
  const shaderRegistry = useMemo<ShaderRegistry | null>(() => {
    if (!videoTexture) return null
    return buildShaderRegistry(videoTexture)
  }, [videoTexture])

  // ── Pinch indicators — one per hand ────────────────────────────────────────
  const leftIndicatorRef  = useRef<THREE.Mesh>(null)
  const rightIndicatorRef = useRef<THREE.Mesh>(null)
  const indicatorMatLeft  = useMemo(() => buildPinchIndicatorMaterial(), [])
  const indicatorMatRight = useMemo(() => buildPinchIndicatorMaterial(), [])
  const indicatorGeom     = useMemo(() => buildIndicatorGeometry(), [])
  const flashFramesRef    = useRef(0)

  // ── Live draw-preview pane ─────────────────────────────────────────────────
  const livePaneRef  = useRef<THREE.Mesh>(null)
  const liveGeomRef  = useRef<THREE.BufferGeometry | null>(null)
  const pinchFrames   = useRef<[number, number]>([0, 0])   // [left, right]
  const releaseFrames = useRef<[number, number]>([0, 0])
  const armed         = useRef<[boolean, boolean]>([true, true])
  const paneZCounter  = useRef(0)
  const drawing = useRef<{ active: boolean; hand: 0 | 1; startX: number; startY: number; startZ: number }>({
    active: false, hand: 0, startX: 0, startY: 0, startZ: 0,
  })

  // ── Live-pane shader transition (COMPOSITE crossfade) ─────────────────────
  const liveShaderIdRef  = useRef<number>(SHADER_IDS.PASSTHROUGH)
  const transitionRef    = useRef<{ from: number; to: number; frame: number } | null>(null)

  // ── Frustum ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const update = () => {
      if (camera instanceof THREE.PerspectiveCamera) {
        updateFrustum(camera.fov, camera.aspect, camera.position.z || CAMERA_Z)
      }
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [camera])

  useEffect(() => {
    if (!shaderRegistry) return
    useUIStore.getState().setBootPhase('COMPILING_SHADERS')

    const dummyGeom = new THREE.PlaneGeometry(0.0001, 0.0001)
    const meshes = [
      ...Object.values(shaderRegistry).map((mat) => new THREE.Mesh(dummyGeom, mat)),
      new THREE.Mesh(indicatorGeom, indicatorMatLeft),
      new THREE.Mesh(indicatorGeom, indicatorMatRight),
    ]
    meshes.forEach((m) => scene.add(m))
    gl.compile(scene, camera)
    meshes.forEach((m) => scene.remove(m))
    dummyGeom.dispose()

    useUIStore.getState().setBootPhase('ACTIVE')
  }, [shaderRegistry, gl, scene, camera, indicatorGeom, indicatorMatLeft, indicatorMatRight])

  // ── Live pane geometry — rebuilt from drawing state every frame ──────────
  const livePaneGeom = useMemo(() => {
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(_rectVerts.slice(), 3))
    geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 1,   1, 1,   1, 0,
      0, 1,   1, 0,   0, 0,
    ]), 2))
    liveGeomRef.current = geom
    return geom
  }, [])

  // ─── useFrame: hot path ───────────────────────────────────────────────────
  useFrame(() => {
    if (!shaderRegistry || !liveGeomRef.current || !livePaneRef.current) return

    // ── 1. uTime — single write propagates to all materials ──────────────
    sharedUniforms.uTime.value = performance.now() * 0.001

    // ── 2. Glitch seed ────────────────────────────────────────────────────
    const glitchSeed = Math.random()
    ;(shaderRegistry[SHADER_IDS.GLITCH] as THREE.RawShaderMaterial)
      .uniforms.uSeed.value = glitchSeed

    // ── 3. Uniform sync from subscribed ref ───────────────────────────────
    const u = uniformsRef.current
    ;(shaderRegistry[SHADER_IDS.THRESHOLD] as any).uniforms.uThreshold.value = u.threshold
    ;(shaderRegistry[SHADER_IDS.CRT]       as any).uniforms.uIntensity.value  = u.crtIntensity
    ;(shaderRegistry[SHADER_IDS.GLITCH]    as any).uniforms.uGlitch.value     = u.glitchAmount

    const compositeMat = (shaderRegistry as any)[SHADER_IDS_EXT.COMPOSITE]
    compositeMat.uniforms.uThreshold.value = u.threshold
    compositeMat.uniforms.uIntensity.value = u.crtIntensity
    compositeMat.uniforms.uGlitch.value    = u.glitchAmount
    compositeMat.uniforms.uSeed.value      = glitchSeed

    // ── 4. Stale-frame / signal loss detection ────────────────────────────
    const now          = performance.now()
    const isStale      = (now - frameTimestamp[0]) > STALE_FRAME_MS
    const isSignalLost = isStale || handPresence[0] === 0
    const src          = isSignalLost ? lastKnownBuffer : liveBuffer

    // ── 4b. EMA-smooth this frame's raw landmarks ──────────────────────────
    updateSmoothing(src, smoothingAlphaRef.current)

    // ── 5. ̥Per-hand pinch points + distances ───────────────────────────────
    const leftPresent  = (handPresence[0] & 0b01) !== 0 && !isSignalLost
    const rightPresent = (handPresence[0] & 0b10) !== 0 && !isSignalLost

    const lThumbBase = LEFT_HAND_OFFSET  + THUMB_TIP_IDX * 3
    const lIndexBase = LEFT_HAND_OFFSET  + INDEX_TIP_IDX * 3
    const rThumbBase = RIGHT_HAND_OFFSET + THUMB_TIP_IDX * 3
    const rIndexBase = RIGHT_HAND_OFFSET + INDEX_TIP_IDX * 3

    const ldx = smoothedBuffer[lThumbBase]     - smoothedBuffer[lIndexBase]
    const ldy = smoothedBuffer[lThumbBase + 1] - smoothedBuffer[lIndexBase + 1]
    const ldz = smoothedBuffer[lThumbBase + 2] - smoothedBuffer[lIndexBase + 2]
    const leftDistSq  = ldx * ldx + ldy * ldy + ldz * ldz

    const rdx = smoothedBuffer[rThumbBase]     - smoothedBuffer[rIndexBase]
    const rdy = smoothedBuffer[rThumbBase + 1] - smoothedBuffer[rIndexBase + 1]
    const rdz = smoothedBuffer[rThumbBase + 2] - smoothedBuffer[rIndexBase + 2]
    const rightDistSq = rdx * rdx + rdy * rdy + rdz * rdz

    _leftPinchPoint[0]  = (smoothedBuffer[lThumbBase]     + smoothedBuffer[lIndexBase])     * 0.5
    _leftPinchPoint[1]  = (smoothedBuffer[lThumbBase + 1] + smoothedBuffer[lIndexBase + 1]) * 0.5
    _leftPinchPoint[2]  = (smoothedBuffer[lThumbBase + 2] + smoothedBuffer[lIndexBase + 2]) * 0.5

    _rightPinchPoint[0] = (smoothedBuffer[rThumbBase]     + smoothedBuffer[rIndexBase])     * 0.5
    _rightPinchPoint[1] = (smoothedBuffer[rThumbBase + 1] + smoothedBuffer[rIndexBase + 1]) * 0.5
    _rightPinchPoint[2] = (smoothedBuffer[rThumbBase + 2] + smoothedBuffer[rIndexBase + 2]) * 0.5

    if (debugModeRef.current) {
      setLiveDist(Math.sqrt(Math.min(leftDistSq, rightDistSq)))
    }

    const isPinchingLeft  = leftPresent  && leftDistSq  < PINCH_THRESHOLD_SQ
    const isPinchingRight = rightPresent && rightDistSq < PINCH_THRESHOLD_SQ
    const isPinching: [boolean, boolean] = [isPinchingLeft, isPinchingRight]

    // ── 6. ̥Per-hand pinch debounce (rising edge = "confirmed" this frame) ──
    const confirmed: [boolean, boolean] = [false, false]
    for (const h of [0, 1] as const) {
      if (isPinching[h] && armed.current[h]) {
        pinchFrames.current[h]++
        releaseFrames.current[h] = 0
        if (pinchFrames.current[h] === PINCH_DEBOUNCE_FRAMES) {
          confirmed[h] = true
        }
      } else if (!isPinching[h]) {
        if (pinchFrames.current[h] > 0) {
          releaseFrames.current[h]++
          if (releaseFrames.current[h] >= PINCH_RELEASE_DEBOUNCE) {
            pinchFrames.current[h]   = 0
            releaseFrames.current[h] = 0
            armed.current[h]         = true
          }
        }
      }
    }

    // ── 7. Draw session state machine ───────────────────────────────────────
    const d = drawing.current

    if (!d.active) {
      if (confirmed[0]) {
        armed.current[0] = false
        d.active = true; d.hand = 0
        d.startX = _leftPinchPoint[0]; d.startY = _leftPinchPoint[1]; d.startZ = _leftPinchPoint[2]
      } else if (confirmed[1]) {
        armed.current[1] = false
        d.active = true; d.hand = 1
        d.startX = _rightPinchPoint[0]; d.startY = _rightPinchPoint[1]; d.startZ = _rightPinchPoint[2]
      }
    } else {
      const pt = d.hand === 0 ? _leftPinchPoint : _rightPinchPoint
      const stillPinching = isPinching[d.hand]

      if (stillPinching) {
        writeRectVerts(_rectVerts, d.startX, d.startY, d.startZ, pt[0], pt[1], pt[2])
        const pos = liveGeomRef.current.attributes.position as THREE.BufferAttribute
        ;(pos.array as Float32Array).set(_rectVerts)
        pos.needsUpdate = true
      }

      if (!isPinching[d.hand] && pinchFrames.current[d.hand] === 0 && releaseFrames.current[d.hand] === 0) {
        const width  = Math.abs(pt[0] - d.startX)
        const height = Math.abs(pt[1] - d.startY)

        if (width >= MIN_PANE_SIZE && height >= MIN_PANE_SIZE) {
          flashFramesRef.current = PANE_DROP_FLASH_FRAMES
          const zOffset  = -(paneZCounter.current++ * Z_INCREMENT)
          const shaderID = activeShaderRef.current
          const corners: [number, number, number, number, number, number] =
            [d.startX, d.startY, d.startZ, pt[0], pt[1], pt[2]]

          queueMicrotask(() => {
            useUIStore.getState().addPane({ id: crypto.randomUUID(), corners, shaderID: shaderID as any, zOffset })
            useUIStore.getState().setPinchConfirmedAt(now)
          })
        }
        d.active = false
      }
    }

    // ── 8. Pinch indicators — one per hand, always tracking pinch progress ──
    const maxDist = Math.sqrt(PINCH_THRESHOLD_SQ) * 2  // show from 2× threshold distance

    if (flashFramesRef.current > 0) flashFramesRef.current--
    const flashValue = flashFramesRef.current / PANE_DROP_FLASH_FRAMES

    if (leftIndicatorRef.current) {
      const ind = leftIndicatorRef.current
      ind.position.set(_leftPinchPoint[0], _leftPinchPoint[1], _leftPinchPoint[2])
      const progress = leftPresent ? Math.max(0, 1 - Math.sqrt(leftDistSq) / maxDist) : 0
      const mat = indicatorMatLeft as THREE.RawShaderMaterial
      mat.uniforms.uCenter.value.set(_leftPinchPoint[0], _leftPinchPoint[1], _leftPinchPoint[2])
      mat.uniforms.uPinchProgress.value  = progress
      mat.uniforms.uPinchConfirmed.value = d.active && d.hand === 0 ? flashValue : 0
      ind.visible = leftPresent
    }

    if (rightIndicatorRef.current) {
      const ind = rightIndicatorRef.current
      ind.position.set(_rightPinchPoint[0], _rightPinchPoint[1], _rightPinchPoint[2])
      const progress = rightPresent ? Math.max(0, 1 - Math.sqrt(rightDistSq) / maxDist) : 0
      const mat = indicatorMatRight as THREE.RawShaderMaterial
      mat.uniforms.uCenter.value.set(_rightPinchPoint[0], _rightPinchPoint[1], _rightPinchPoint[2])
      mat.uniforms.uPinchProgress.value  = progress
      mat.uniforms.uPinchConfirmed.value = d.active && d.hand === 1 ? flashValue : 0
      ind.visible = rightPresent
    }

    // ── 9. Live pane visibility — only shown while a draw is in progress ───
    livePaneRef.current.visible = d.active

    // ── 10. Live pane shader transition / material switch ──────────────────
    if (isSignalLost) {
      transitionRef.current   = null
      liveShaderIdRef.current = SHADER_IDS.WIREFRAME
    } else {
      const desired = activeShaderRef.current
      if (desired !== liveShaderIdRef.current && !transitionRef.current) {
        transitionRef.current = { from: liveShaderIdRef.current, to: desired, frame: 0 }
      }
    }

    let targetMat: THREE.RawShaderMaterial
    if (transitionRef.current) {
      const t = transitionRef.current
      const composite = shaderRegistry[SHADER_IDS_EXT.COMPOSITE] as THREE.RawShaderMaterial & {
        uniforms: Record<string, { value: number }>
      }
      composite.uniforms.uModeA.value = t.from
      composite.uniforms.uModeB.value = t.to
      composite.uniforms.uBlend.value = t.frame / SHADER_TRANSITION_FRAMES

      t.frame++
      if (t.frame > SHADER_TRANSITION_FRAMES) {
        liveShaderIdRef.current = t.to
        transitionRef.current   = null
      }
      targetMat = composite
    } else {
      targetMat = isSignalLost
        ? shaderRegistry[SHADER_IDS.WIREFRAME]
        : shaderRegistry[liveShaderIdRef.current as keyof ShaderRegistry]
    }

    if (livePaneRef.current.material !== targetMat) {
      livePaneRef.current.material = targetMat
    }
  })

  return (
    <>
      <mesh
        ref={livePaneRef}
        geometry={livePaneGeom}
        material={shaderRegistry?.[SHADER_IDS.PASSTHROUGH] ?? undefined}
        visible={false}
      />

      <mesh ref={leftIndicatorRef}  geometry={indicatorGeom} material={indicatorMatLeft}  visible={false} frustumCulled={false} />
      <mesh ref={rightIndicatorRef} geometry={indicatorGeom} material={indicatorMatRight} visible={false} frustumCulled={false} />

      <FrozenPanes shaderRegistry={shaderRegistry} />
      {debugMode && <HandSkeleton />}
      {videoTexture && (
        <mesh position={[0, 0, -10]} scale={[32, 18, 1]}>
          <planeGeometry args={[1, 1]} />
          <meshBasicMaterial map={videoTexture} color={0x444444} />
        </mesh>
      )}
    </>
  )
}

// ─── FROZEN PANES ────────────────────────────────────────────────────────────
const FrozenPanes = memo(function FrozenPanes({
  shaderRegistry,
}: { shaderRegistry: ShaderRegistry | null }) {
  const panes = useUIStore(selectPanes)
  if (!shaderRegistry) return null
  return (
    <>
      {panes.map((pane) => (
        <FrozenPane
          key={pane.id}
          pane={pane}
          material={shaderRegistry[pane.shaderID as keyof ShaderRegistry]}
        />
      ))}
    </>
  )
})

interface FrozenPaneProps {
  pane:           PaneDescriptor
  material:       THREE.RawShaderMaterial
}

const FrozenPane = memo(function FrozenPane({
  pane,
  material,
}: FrozenPaneProps) {
  const { id, corners, zOffset } = pane
  const { gl } = useThree()
  const perPaneUniforms = useUIStore((s) => s.perPaneUniforms[id])
  const setSelectedPane = useUIStore((s) => s.setSelectedPaneId)
  const { geom, centroid } = useMemo(() => {
    const [x0, y0, z0, x1, y1, z1] = corners
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    const cz = (z0 + z1) / 2

    const local = new Float32Array(18)
    writeRectVerts(local, x0 - cx, y0 - cy, z0 - cz, x1 - cx, y1 - cy, z1 - cz)

    const uvs = new Float32Array([
      0, 1,   1, 1,   1, 0,
      0, 1,   1, 0,   0, 0,
    ])
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(local, 3))
    g.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2))
    return { geom: g, centroid: [cx, cy, cz + zOffset] as [number, number, number] }
  }, [corners, zOffset])


  const [displayMaterial, setDisplayMaterial] = useState<THREE.RawShaderMaterial>(material)


  useEffect(() => {
    const mat = material as THREE.RawShaderMaterial & { uniforms: Record<string, { value: number }> }
    if (perPaneUniforms?.threshold    !== undefined && mat.uniforms.uThreshold)
      mat.uniforms.uThreshold.value = perPaneUniforms.threshold
    if (perPaneUniforms?.crtIntensity !== undefined && mat.uniforms.uIntensity)
      mat.uniforms.uIntensity.value = perPaneUniforms.crtIntensity
    if (perPaneUniforms?.glitchAmount !== undefined && mat.uniforms.uGlitch)
      mat.uniforms.uGlitch.value    = perPaneUniforms.glitchAmount

    const target = bakeMaterialToTexture(gl, mat, FROZEN_BAKE_SIZE)
    const cacheMat = buildCacheDisplayMaterial(target.texture)
    setDisplayMaterial(cacheMat)

    return () => {
      target.dispose()     // frees the RT's color texture too
      cacheMat.dispose()
    }
  }, [perPaneUniforms, material, gl])

  return (
    <mesh
      position={centroid}
      geometry={geom}
      material={displayMaterial}
      onClick={() => setSelectedPane(id)}
    />
  )
})

// ─── CANVAS WRAPPER ──────────────────────────────────────────────────────────

export function CoreReactor() {
  return (
    <Canvas
      style={{ position: 'fixed', inset: 0 }}
      camera={{ position: [0, 0, CAMERA_Z], fov: CAMERA_FOV }}
      gl={{
        antialias:             true,
        alpha:                 false,
        powerPreference:       'high-performance',
        preserveDrawingBuffer: false,
      }}
      dpr={[1, 2]}
    >
      <Scene />
    </Canvas>
  )
}
