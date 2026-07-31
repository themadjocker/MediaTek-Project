import { useEffect, useRef, useMemo } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

import { useEngineRuntime } from './EngineRuntime'
import type { IMaterialProvider } from '../engine/renderer/RendererTypes'
import type { FrameContext } from '../engine/types/EngineTypes'

class WireframeMaterialProvider implements IMaterialProvider {
    private material: THREE.MeshBasicMaterial

    constructor() {
        this.material = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            wireframe: true,
            transparent: true,
            opacity: 0.6,
        })
    }

    getMaterial = () => this.material
    releaseMaterial = () => {}
    dispose = () => {
        this.material.dispose()
    }
}

export function RendererHost() {
    const bootstrap = useEngineRuntime()
    const { scene } = useThree()
    const frameCounter = useRef(0)

    //   Setup scene reference for development
    useEffect(() => {
        if (import.meta.env.DEV) {
            (window as any).__scene = scene;
        }
        return () => {
            delete (window as any).__scene;
        };
    }, [scene]);

    const materialProvider = useMemo(() => new WireframeMaterialProvider(), [])

    // Material memory management
    useEffect(() => {
        return () => {
            materialProvider.dispose()
        }
    }, [materialProvider])

    // Attach RendererEngine when component mounts
    useEffect(() => {
        console.log('[RendererHost] Mounted')
        bootstrap.attachRenderer(scene, materialProvider)
        console.log('[RendererHost] Renderer attached')

        return () => {
            try {
                bootstrap.detachRenderer()
            } catch (error) {
                console.error('[RendererHost] Failed to detach RendererEngine:', error)
            }
        }
    }, [bootstrap, scene, materialProvider])

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