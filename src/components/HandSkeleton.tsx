import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import {
  liveBuffer,
  lastKnownBuffer,
  frameTimestamp,
  handPresence,
  LEFT_HAND_OFFSET,
  RIGHT_HAND_OFFSET,
} from '@data/landmarkStore'
import {
  LANDMARKS_PER_HAND,
  HAND_CONNECTIONS,
  STALE_FRAME_MS,
} from '@constants/index'

const JOINT_RADIUS = 0.015
const LEFT_COLOR  = new THREE.Color('#00F5FF')  // cyan — matches CRT accent, this hand = LEFT
const RIGHT_COLOR = new THREE.Color('#FF003C')  // red  — matches GLITCH accent, this hand = RIGHT

const BONE_COUNT       = HAND_CONNECTIONS.length
const FLOATS_PER_BONE  = 2 * 3  // 2 endpoints × xyz
const JOINT_INSTANCES  = LANDMARKS_PER_HAND * 2  // 21 × 2 hands

// ── Module-level scratch — zero per-frame allocation ─────────────────────────
const _m         = new THREE.Matrix4()
const _pos       = new THREE.Vector3()
const _quat      = new THREE.Quaternion()
const _scaleOne  = new THREE.Vector3(1, 1, 1)
const _scaleZero = new THREE.Vector3(0, 0, 0)

export function HandSkeleton() {
  const jointsRef = useRef<THREE.InstancedMesh>(null)
  const bonesRef  = useRef<THREE.LineSegments>(null)

  const jointGeom = useMemo(() => new THREE.SphereGeometry(JOINT_RADIUS, 8, 6), [])
  const jointMat  = useMemo(
    () => new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    [],
  )

  const boneGeom = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const positions = new Float32Array(BONE_COUNT * 2 /* hands */ * FLOATS_PER_BONE)
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    return g
  }, [])
  const boneMat = useMemo(
    () => new THREE.LineBasicMaterial({ color: '#8A9BB5', transparent: true, opacity: 0.6 }),
    [],
  )

  useFrame(() => {
    const joints = jointsRef.current
    const bones  = bonesRef.current
    if (!joints || !bones) return

    const isStale = (performance.now() - frameTimestamp[0]) > STALE_FRAME_MS
    const src     = isStale ? lastKnownBuffer : liveBuffer

    const bonePos = (bones.geometry.attributes.position as THREE.BufferAttribute)
      .array as Float32Array
    let boneCursor = 0

    for (let hand = 0; hand < 2; hand++) {
      const handOffset = hand === 0 ? LEFT_HAND_OFFSET : RIGHT_HAND_OFFSET
      const presentBit  = hand === 0 ? 0b01 : 0b10
      const present     = (handPresence[0] & presentBit) !== 0
      const color       = hand === 0 ? LEFT_COLOR : RIGHT_COLOR

      // ── Joints — every one of the 21 landmarks, not just tips ────────────
      for (let i = 0; i < LANDMARKS_PER_HAND; i++) {
        const base = handOffset + i * 3
        _pos.set(src[base], src[base + 1], src[base + 2])
        _m.compose(_pos, _quat, present ? _scaleOne : _scaleZero)
        const instanceIdx = hand * LANDMARKS_PER_HAND + i
        joints.setMatrixAt(instanceIdx, _m)
        joints.setColorAt(instanceIdx, color)
      }

      // ── Bones — standard MediaPipe HAND_CONNECTIONS graph ────────────────
      for (let c = 0; c < BONE_COUNT; c++) {
        const [a, b] = HAND_CONNECTIONS[c]
        const ba = handOffset + a * 3
        const bb = handOffset + b * 3
        if (present) {
          bonePos[boneCursor++] = src[ba];     bonePos[boneCursor++] = src[ba + 1]; bonePos[boneCursor++] = src[ba + 2]
          bonePos[boneCursor++] = src[bb];     bonePos[boneCursor++] = src[bb + 1]; bonePos[boneCursor++] = src[bb + 2]
        } else {
          // Collapse absent-hand bones to a degenerate zero-length segment
          // rather than branching the draw call — cheaper than toggling
          // per-hand visibility on a single shared LineSegments mesh.
          bonePos[boneCursor++] = 0; bonePos[boneCursor++] = 0; bonePos[boneCursor++] = 0
          bonePos[boneCursor++] = 0; bonePos[boneCursor++] = 0; bonePos[boneCursor++] = 0
        }
      }
    }

    joints.instanceMatrix.needsUpdate = true
    if (joints.instanceColor) joints.instanceColor.needsUpdate = true
    ;(bones.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
  })

  return (
    <>
      <instancedMesh ref={jointsRef} args={[jointGeom, jointMat, JOINT_INSTANCES]} />
      <lineSegments ref={bonesRef} geometry={boneGeom} material={boneMat} />
    </>
  )
}
