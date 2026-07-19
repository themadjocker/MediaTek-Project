import React from 'react'
import ReactDOM from 'react-dom/client'
import { SimulationVault } from './components/SimulationVault'
import './styles/index.css'

// React 18 — Strict Mode disabled intentionally to prevent double-invoking
// MediaPipe initialization in development
ReactDOM.createRoot(document.getElementById('root')!).render(
  <SimulationVault />
)
