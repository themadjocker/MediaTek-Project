/**
 * SimulationVault.tsx  —  Phase 3 update
 *
 * Added: PaneEditor — floating per-pane shader editor, appears on pane click.
 * Layout: Layout-only parent, zero logic of its own.
 */

import { NeuralLink }       from './NeuralLink'
import { CoreReactor }      from './CoreReactor'
import { EncryptedChannel } from './EncryptedChannel'
import { DebugOverlay }     from './DebugOverlay'
import { PaneEditor }       from './PaneEditor'
import { BootScreen }       from './BootScreen'
import { useUIStore, selectBootPhase } from '@stores/useUIStore'

export function SimulationVault() {
  const bootPhase = useUIStore(selectBootPhase)

  const showCanvas = (
    bootPhase === 'COMPILING_SHADERS' ||
    bootPhase === 'ACTIVE'            ||
    bootPhase === 'TRACKING'          ||
    bootPhase === 'SIGNAL_LOSS'
  )

  const showTracking = (
    bootPhase === 'COMPILING_SHADERS' ||
    bootPhase === 'ACTIVE'            ||
    bootPhase === 'TRACKING'          ||
    bootPhase === 'SIGNAL_LOSS'
  )

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: '#030508' }}>
      {!showCanvas    && <BootScreen />}
      {showTracking   && <NeuralLink />}
      {showCanvas     && <CoreReactor />}
      {showCanvas     && <EncryptedChannel />}
      {showCanvas     && <PaneEditor />}
      {showCanvas     && <DebugOverlay />}
    </div>
  )
}
