import { useEffect, useRef, useMemo } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

import { useEngineRuntime } from './EngineRuntime'
import type { IMaterialProvider } from '../engine/renderer/RendererTypes'
import type { FrameContext } from '../engine/types/EngineTypes' // Added missing import

class WireframeMaterialProvider implements IMaterialProvider {
    private material: THREE.MeshBasicMaterial

    constructor() {
        this.material = new THREE.MeshBasicMaterial({
            color: 0x00ffff,     // Cyan
            wireframe: true,
            transparent: true,
            opacity: 0.6,
        })
    }

    getMaterial = () => this.material

    releaseMaterial = () => {
    }

    dispose = () => {
        this.material.dispose()
    }
}

export function RendererHost() {
    const bootstrap = useEngineRuntime()
    const { scene } = useThree()

    const frameCounter = useRef(0)

    const materialProvider = useMemo(() => new WireframeMaterialProvider(), [])

    // Material memory management
    useEffect(() => {
        return () => {
        materialProvider.dispose()
        }
    }, [materialProvider])

    // Attach RendererEngine when component mounts
    useEffect(() => {
        bootstrap.attachRenderer(scene, materialProvider)

        return () => {
            try {
            bootstrap.detachRenderer()
            } catch (error) {
            console.error('[RendererHost] Failed to detach RendererEngine:', error)
            }
        }
    },   [bootstrap, scene, materialProvider])

    //   Forward R3F frame to Bootstrap
    useFrame((threeState, delta) => {
        frameCounter.current++

        const frameContext: FrameContext = {
            deltaTime: delta,
            elapsedTime: threeState.clock.getElapsedTime(),
            frameCount: frameCounter.current,
        }

        bootstrap.tick(frameContext)
    })

    //   This component renders nothing — it's purely a side-effect bridge
    return null
}