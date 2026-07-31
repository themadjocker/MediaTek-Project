import ReactDOM from 'react-dom/client'
import { EngineRuntimeProvider } from './runtime/EngineRuntime'
import { SimulationVault } from './components/SimulationVault'
import './styles/index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <EngineRuntimeProvider>
    <SimulationVault />
  </EngineRuntimeProvider>
)