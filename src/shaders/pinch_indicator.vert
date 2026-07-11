precision mediump float;

attribute vec2 position;   // unit quad [-1..1]

uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform vec3 uCenter;      // world-space pinch midpoint
uniform float uRadius;     // world-space radius

varying vec2 vUv;

void main() {
  vUv = position;
  // Offset from center in camera-facing plane
  vec3 worldPos = uCenter + vec3(position * uRadius, 0.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
