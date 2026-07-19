import { createContext, useContext, useEffect, useRef, ReactNode } from 'react'
import { EngineBootstrap } from './EngineBootstrap'
import type { ILogger } from './EngineBootstrap'

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

const EngineRuntimeContext = createContext<EngineBootstrap | null>(null)

EngineRuntimeContext.displayName = 'EngineRuntimeContext'

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

interface EngineRuntimeProviderProps {
  children: ReactNode
  /** Optional custom logger (defaults to console) */
  logger?: ILogger
}

export function EngineRuntimeProvider({
  children,
  logger = console
}: EngineRuntimeProviderProps) {

  // Stable bootstrap instance across renders
  const bootstrapRef = useRef<EngineBootstrap | null>(null)

  if (!bootstrapRef.current) {
    bootstrapRef.current = new EngineBootstrap(logger)
  }

  // Initialize on mount, dispose on unmount
  useEffect(() => {
    const bootstrap = bootstrapRef.current!

    try {
      bootstrap.initialize()
    } catch (error) {
      // Clean up any partially allocated resources
      bootstrap.dispose()

      throw error
    }

    return () => {
      bootstrap.dispose()
      bootstrapRef.current = null
    }
  }, []) // Empty dependency array guarantees exact single execution

  return (
    <EngineRuntimeContext.Provider value={bootstrapRef.current}>
      {children}
    </EngineRuntimeContext.Provider>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useEngineRuntime(): EngineBootstrap {
  const bootstrap = useContext(EngineRuntimeContext)

  if (!bootstrap) {
    throw new Error(
      'useEngineRuntime() must be used within an <EngineRuntimeProvider>. ' +
      'Wrap your root component (SimulationVault) with it.'
    )
  }

  return bootstrap
}