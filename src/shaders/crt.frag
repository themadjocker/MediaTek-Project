precision mediump float;

uniform sampler2D uTexture;
uniform float uTime;
uniform float uIntensity;

varying vec2 vUv;

void main() {
  vec4 tex = texture2D(uTexture, vUv);

  // Scanlines
  float scanline = sin(vUv.y * 800.0 + uTime * 4.0) * 0.04 * uIntensity;

  // Vignette
  vec2 uv2 = vUv * 2.0 - 1.0;
  float vignette = 1.0 - dot(uv2, uv2) * 0.4 * uIntensity;

  // Slight green tint for CRT feel
  vec3 crt = tex.rgb;
  crt.g *= 1.0 + 0.08 * uIntensity;
  crt -= scanline;
  crt *= vignette;

  gl_FragColor = vec4(crt, 1.0);
}
