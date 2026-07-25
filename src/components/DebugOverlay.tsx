import { memo, useEffect, useRef, useState } from 'react';
import { useUIStore, selectDebugMode, selectBootPhase, selectShaderID, selectLiveDistance, selectSmoothingAlpha } from '@stores/useUIStore';
import { handPresence, frameTimestamp } from '@data/landmarkStore';
import { PINCH_THRESHOLD_SQ, SHADER_IDS } from '@constants/index';

const PINCH_THRESHOLD = Math.sqrt(PINCH_THRESHOLD_SQ);

const SHADER_NAMES: Record<number, string> = {
  [SHADER_IDS.PASSTHROUGH]: 'PASSTHROUGH',
  [SHADER_IDS.THRESHOLD]: 'THRESHOLD',
  [SHADER_IDS.CRT]: 'CRT',
  [SHADER_IDS.GLITCH]: 'GLITCH',
  [SHADER_IDS.WIREFRAME]: 'WIREFRAME',
};

export const DebugOverlay = memo(function DebugOverlay() {
  const debugMode = useUIStore(selectDebugMode);
  if (!debugMode) return null;

  return <DebugPanel />;
});

// ─── Inner Panel — only mounted when debug mode is on ────────────────────────
function DebugPanel() {
  const bootPhase = useUIStore(selectBootPhase);
  const activeShader = useUIStore(selectShaderID);
  const liveDistance = useUIStore(selectLiveDistance);
  const smoothingAlpha = useUIStore(selectSmoothingAlpha);
  const setSmoothingAlpha = useUIStore((s) => s.setSmoothingAlpha);

  // FPS counter
  const fpsRef = useRef<number[]>([]);
  const lastTimeRef = useRef(performance.now());
  const [fps, setFps] = useState(0);
  const [msSinceFrame, setMsSinceFrame] = useState(0);
  const [presence, setPresence] = useState(0);

  // Poll at ~60fps for debug info
  useEffect(() => {
    let raf: number;

    function tick() {
      const now = performance.now();
      const delta = now - lastTimeRef.current;
      lastTimeRef.current = now;

      // Rolling 60-frame average FPS
      fpsRef.current.push(1000 / delta);
      if (fpsRef.current.length > 60) fpsRef.current.shift();

      const avgFps = fpsRef.current.reduce((a, b) => a + b, 0) / fpsRef.current.length;

      setFps(Math.round(avgFps));
      setMsSinceFrame(Math.round(now - frameTimestamp[0]));
      setPresence(handPresence[0]);

      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, []);

  const isPinching = liveDistance < PINCH_THRESHOLD;
  const isStale = msSinceFrame > 50;
  const leftPresent = (presence & 0b01) !== 0;
  const rightPresent = (presence & 0b10) !== 0;

  return (
    <div style={overlayStyle}>
      {/* Header */}
      <div style={headerStyle}>◈ DEBUG CONSOLE</div>

      {/* FPS + Timing */}
      <DebugRow label="FPS">
        <span style={{ color: fps >= 55 ? '#00FF41' : fps >= 30 ? '#FFAB00' : '#FF003C' }}>
          {fps}
        </span>
        <span style={{ color: '#8A9BB5' }}> / 60</span>
      </DebugRow>

      <DebugRow label="FRAME AGE">
        <span style={{ color: isStale ? '#FF003C' : '#00FF41' }}>
          {msSinceFrame}ms
        </span>
        {isStale && <span style={{ color: '#FF003C', marginLeft: 4 }}>STALE</span>}
      </DebugRow>

      <Divider />

      {/* Hand Presence */}
      <DebugRow label="HANDS">
        <span style={{ color: leftPresent ? '#00FF41' : '#1A2740' }}>L</span>
        <span style={{ color: '#8A9BB5', margin: '0 4px' }}>·</span>
        <span style={{ color: rightPresent ? '#00FF41' : '#1A2740' }}>R</span>
        <span style={{ color: '#8A9BB5', marginLeft: 8, fontSize: 10 }}>
          (0b{presence.toString(2).padStart(2, '0')})
        </span>
      </DebugRow>

      <Divider />

      {/* Pinch distance */}
      <DebugRow label="PINCH DIST">
        <span style={{ color: isPinching ? '#00FF41' : '#E8F0FE' }}>
          {liveDistance.toFixed(4)}
        </span>
      </DebugRow>

      <DebugRow label="THRESHOLD">
        <span style={{ color: '#FFAB00' }}>{PINCH_THRESHOLD.toFixed(4)}</span>
      </DebugRow>

      {/* Visual threshold bar */}
      <div style={{ margin: '4px 0 8px' }}>
        <div
          style={{
            height: 4,
            background: '#0A1220',
            borderRadius: 2,
            overflow: 'hidden',
            border: '1px solid #1A2740',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${Math.min(100, (liveDistance / (PINCH_THRESHOLD * 2)) * 100)}%`,
              background: isPinching ? '#00FF41' : '#FF003C',
              transition: 'width 0.05s linear',
              borderRadius: 2,
            }}
          />
        </div>
        <div style={{ position: 'relative', height: 4, marginTop: -4 }}>
          <div
            style={{
              position: 'absolute',
              left: '50%',
              width: 1,
              height: 8,
              background: '#FFAB00',
              top: -2,
            }}
            title="threshold"
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          <span style={{ fontSize: 9, color: '#8A9BB5' }}>0</span>
          <span style={{ fontSize: 9, color: '#FFAB00' }}>← threshold</span>
          <span style={{ fontSize: 9, color: '#8A9BB5' }}>2×</span>
        </div>
      </div>

      <Divider />

      {/* Smoothing */}
      <DebugRow label="SMOOTHING α">
        <span style={{ color: '#00F5FF' }}>{smoothingAlpha.toFixed(2)}</span>
      </DebugRow>
      <input
        type="range"
        min={0.05}
        max={1}
        step={0.05}
        value={smoothingAlpha}
        title="landmark smoothing alpha"
        onChange={(e) => setSmoothingAlpha(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: '#00F5FF', cursor: 'pointer', margin: '2px 0 8px' }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: -4 }}>
        <span style={{ fontSize: 9, color: '#8A9BB5' }}>smoother/laggier</span>
        <span style={{ fontSize: 9, color: '#8A9BB5' }}>snappier/jitterier</span>
      </div>

      <Divider />

      {/* State */}
      <DebugRow label="BOOT PHASE">
        <span style={{ color: '#00F5FF', fontSize: 10 }}>{bootPhase}</span>
      </DebugRow>

      <DebugRow label="SHADER">
        <span style={{ color: '#9D00FF' }}>{SHADER_NAMES[activeShader] ?? activeShader}</span>
      </DebugRow>

      <Divider />

      {/* Buffer reference */}
      <div style={{ fontSize: 9, color: '#8A9BB5', lineHeight: 1.7, fontFamily: 'JetBrains Mono, monospace' }}>
        <div style={{ color: '#1E3A5F', marginBottom: 2 }}>— BUFFER MAP —</div>
        <div><span style={{ color: '#00F5FF' }}>[0..62]</span> LEFT hand</div>
        <div><span style={{ color: '#00F5FF' }}>[63..125]</span> RIGHT hand</div>
        <div style={{ marginTop: 4 }}>
          <span style={{ color: '#FFAB00' }}>LM4</span>=thumb tip 
          <span style={{ color: '#FFAB00' }}>LM8</span>=index tip
        </div>
        <div style={{ color: '#8A9BB5', marginTop: 2 }}>
          Marquee: EITHER hand&apos;s thumb+index midpoint = anchor/current.
        </div>
        <div style={{ color: '#8A9BB5', marginTop: 2 }}>
          Edit <span style={{ color: '#00FF41' }}>PINCH_THRESHOLD_SQ</span> in constants/index.ts
        </div>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function DebugRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' }}>
      <span style={{
          fontSize: 9,
          color: '#8A9BB5',
          letterSpacing: '0.15em',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        {label}
      </span>
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700 }}>{children}</span>
    </div>
  )
}

function Divider() {
  return <div style={{ height: 1, background: '#1A2740', margin: '6px 0' }} />
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const overlayStyle: React.CSSProperties = {
  position:      'fixed',
  bottom:        '1.5rem',
  left:          '1.5rem',
  width:         '210px',
  background:    '#070D14EE',
  border:        '1px solid #FFAB00',
  borderTop:     '2px solid #FFAB00',
  borderRadius:  '4px',
  padding:       '0.75rem 1rem',
  zIndex:        200,
  backdropFilter:'blur(8px)',
}

const headerStyle: React.CSSProperties = {
  fontFamily:    'JetBrains Mono, monospace',
  fontSize:      '0.6rem',
  letterSpacing: '0.3em',
  color:         '#FFAB00',
  marginBottom:  '0.6rem',
  textTransform: 'uppercase',
}