precision mediump float;

uniform float uPinchProgress;   // [0..1] pinch amount
uniform float uPinchConfirmed;  // 0..1 flash value on commit
uniform float uTime;

varying vec2 vUv;               // [-1..1] from center

void main() {
  float dist = length(vUv);
  if (dist > 1.0) discard;      // clip to circle

  // ── Outer ring ────────────────────────────────────────────────────────────
  float ring     = smoothstep(0.75, 0.8, dist) * smoothstep(1.0, 0.95, dist);

  // ── Crosshair lines ───────────────────────────────────────────────────────
  float lineW    = 0.04;
  float hLine    = smoothstep(lineW, lineW * 0.5, abs(vUv.y)) * step(dist, 0.7);
  float vLine    = smoothstep(lineW, lineW * 0.5, abs(vUv.x)) * step(dist, 0.7);
  float cross_   = max(hLine, vLine);

  // ── Center dot — grows as pinch closes ───────────────────────────────────
  float dotR     = 0.08 + uPinchProgress * 0.18;
  float dot_     = smoothstep(dotR + 0.02, dotR, dist);

  // ── Radial fill — grows with pinch progress ───────────────────────────────
  float fill     = smoothstep(uPinchProgress + 0.1, uPinchProgress, dist) * 0.15;

  // ── Colour: matrix green → cyber red as pinch closes ─────────────────────
  vec3 green     = vec3(0.0, 1.0, 0.255);
  vec3 red       = vec3(1.0, 0.0, 0.235);
  vec3 white     = vec3(1.0);
  vec3 color     = mix(green, red, uPinchProgress);
  color          = mix(color, white, uPinchConfirmed * 0.9);

  // ── Pulse animation ───────────────────────────────────────────────────────
  float pulse    = 0.75 + 0.25 * sin(uTime * 5.0 + uPinchProgress * 3.14);

  float alpha    = (ring * 0.9 + cross_ * 0.7 + dot_ + fill) * pulse;
  alpha          = clamp(alpha, 0.0, 1.0);

  // Flash white burst on confirmed drop
  alpha         += uPinchConfirmed * ring * 0.5;

  gl_FragColor   = vec4(color, alpha * 0.92);
}
