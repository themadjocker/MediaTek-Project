precision mediump float;

uniform float uTime;

varying vec2 vUv;

void main() {
  // Animated wireframe lines using screen-space derivatives
  float lineWidth = 0.03;
  vec2 grid = abs(fract(vUv * 8.0 - 0.5) - 0.5);
  float d = min(grid.x, grid.y);
  float line = step(d, lineWidth);

  // Matrix Green with animated flicker
  float flicker = 0.8 + 0.2 * sin(uTime * 12.0 + vUv.y * 30.0);
  vec3 color = vec3(0.0, 1.0, 0.255) * line * flicker;  // #00FF41

  // Scanline overlay
  float scan = sin(vUv.y * 200.0 + uTime * 3.0) * 0.05;
  color += scan * vec3(0.0, 0.3, 0.0);

  gl_FragColor = vec4(color, 0.85);
}
