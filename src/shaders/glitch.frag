precision mediump float;

uniform sampler2D uTexture;
uniform float uGlitch;
uniform float uSeed;      // CPU-side PRNG, updated each frame

varying vec2 vUv;

float hash(float n) {
  return fract(sin(n) * 43758.5453);
}

void main() {
  // Chromatic aberration offsets driven by CPU seed (cheap)
  float shift = uGlitch * 0.01 * (hash(uSeed) * 2.0 - 1.0);

  float r = texture2D(uTexture, vec2(vUv.x + shift, vUv.y)).r;
  float g = texture2D(uTexture, vUv).g;
  float b = texture2D(uTexture, vec2(vUv.x - shift, vUv.y)).b;

  // Block shift: occasional horizontal band displacement
  float band = floor(vUv.y * 20.0);
  float bandShift = hash(band + uSeed) > (1.0 - uGlitch * 0.3)
    ? (hash(band * 3.7 + uSeed) - 0.5) * 0.1 * uGlitch
    : 0.0;

  r = texture2D(uTexture, vec2(vUv.x + shift + bandShift, vUv.y)).r;

  gl_FragColor = vec4(r, g, b, 1.0);
}
