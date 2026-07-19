

import { useEffect, useRef } from 'react'
import { SensorEngine }      from '@/engine/sensor/SensorEngine'
import { IntentEngine }      from '@/engine/intent/IntentEngine'
import { CommandEngine }     from '@/engine/command/CommandEngine'
import type { FrameContext } from '@/engine/types/EngineTypes'
import { ZustandSceneGraphAdapter } from '@/adapters/ZustandSceneGraphAdapter'
import { useUIStore }        from '@/stores/useUIStore'

// Module-level singletons — same pattern BootScreen.tsx already uses for
// handLandmarker/videoElement. DebugOverlay is a SIBLING of whatever mounts
// this hook (CoreReactor), not a descendant, so it has no prop-drilling path
// to the live engine instances; these exports are that path. Null whenever
// the hook isn't mounted/enabled — consumers must handle that.
export let activeSensorEngine:  SensorEngine  | null = null
export let activeIntentEngine:  IntentEngine  | null = null
export let activeCommandEngine: CommandEngine | null = null

export function useEngineStack(enabled: boolean) {
  const commandRef = useRef<CommandEngine | null>(null)

  useEffect(() => {
    if (!enabled) return

    const sensor  = new SensorEngine()
    const intent  = new IntentEngine(sensor)
    const command = new CommandEngine(intent, new ZustandSceneGraphAdapter())

    // Priority order: Sensor (0) → Intent (10) → Command (20). Each reads
    // the previous engine's freshly-updated output within the same tick.
    sensor.initialize()
    intent.initialize()
    command.initialize()
    commandRef.current = command

    activeSensorEngine  = sensor
    activeIntentEngine  = intent
    activeCommandEngine = command

    useUIStore.getState().setEngineStackActive(true)

    // Mutated in place every tick — matches the zero-allocation-in-the-hot-
    // path discipline every engine in this stack already follows.
    const frame = { deltaTime: 0, elapsedTime: 0, frameCount: 0 }
    let lastTime = performance.now()
    let rafId = 0

    const tick = (now: number): void => {
      frame.deltaTime    = (now - lastTime) / 1000
      frame.elapsedTime += frame.deltaTime
      frame.frameCount++
      lastTime = now

      const ctx = frame as FrameContext
      sensor.update(ctx)
      intent.update(ctx)
      command.update(ctx)

      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      // Reverse priority order for teardown — mirrors dependency direction.
      command.dispose()
      intent.dispose()
      sensor.dispose()
      commandRef.current = null
      activeSensorEngine  = null
      activeIntentEngine  = null
      activeCommandEngine = null
      useUIStore.getState().setEngineStackActive(false)
    }
  }, [enabled])

  return commandRef
}
