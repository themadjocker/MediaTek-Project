# SPATIAL VIDEO PANES

> Maps live webcam textures onto dynamic 2D WebGL geometries morphed in real-time by 3D hand-tracking.

## Quick Start

```bash
# Install dependencies
pnpm install

# Dev server (COOP/COEP headers are pre-configured in vite.config.ts)
pnpm dev
```

## Architecture — Phase 1 Complete

```
src/
  components/
    SimulationVault.tsx   — Layout-only parent. No logic.
    BootScreen.tsx        — Boot state machine (cam → WASM → WebGL gate)
    NeuralLink.tsx        — MediaPipe rAF loop. Zero React re-renders.
    CoreReactor.tsx       — Three.js canvas + useFrame loop
    EncryptedChannel.tsx  — Zustand-connected UI overlay
  constants/
    index.ts              — PINCH_THRESHOLD_SQ, MAX_PANES, Z_INCREMENT, etc.
  data/
    landmarkStore.ts      — Module-level Float32Array buffers. Zero GC.
  shaders/
    pane.vert             — Shared vertex shader
    passthrough.frag      — Raw webcam passthrough
    threshold.frag        — Cyber Red / Matrix Green luminance cutoff
    crt.frag              — Scanline + vignette
    glitch.frag           — Chromatic aberration + block shift
    wireframe.frag        — Signal-loss wireframe fallback
  stores/
    useUIStore.ts         — Zustand (UI only — landmark data never enters here)
```

## Boot State Machine
BOOT_SCREEN → REQUESTING_CAM → LOADING_WASM → WASM_READY → COMPILING_SHADERS → ACTIVE → TRACKING ⇄ SIGNAL_LOSS

## The Core Mechanic
Hold Left Thumb + Left Index together for 8 frames (≥133ms) to freeze a pane.
New pane instantiates tethered to live hand data.

## Performance Contract
- 0 React re-renders per tracking frame
- 1 React re-render per pinch gesture (new pane)
- All landmark data lives in pre-allocated Float32Array(126)
- VideoTexture: one GPU upload shared across all pane materials
- uTime: one uniform write propagated to all shaders
