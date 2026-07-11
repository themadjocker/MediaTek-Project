precision mediump float;

/**
 * composite.frag  —  Phase 4
 *
 * Blends the output of TWO shader effects (uModeA -> uModeB) with a single
 * uBlend uniform, so CoreReactor can crossfade a pane between shader states
 * (e.g. CRT -> GLITCH) over N frames instead of hard-swapping materials.
 *
 * Deliberately does NOT do this via two offscreen render passes + a real
 * "composite of two materials" — that would cost 2 extra full-screen render
 * targets per transitioning pane per frame. Instead every effect this file
 * knows about is inlined as a callable function, both are evaluated against
 * the SAME source texture in one pass, and the results are mixed. This is
 * consistent with the blueprint's "RawShaderMaterial for maximum control /
 * avoid runtime branching in JS" stance — the branching happens once, in
 * GLSL, on a uniform (not a texture read), which compiles to simple
 * predicated moves on any target hardware.
 *
 * uModeA / uModeB use the SAME integer values as SHADER_IDS in
 * constants/index.ts — keep these in sync if that enum changes.
 */

uniform sampler2D uTexture;
uniform float uTime;
uniform float uThreshold;
uniform float uIntensity;
uniform float uGlitch;
uniform float uSeed;
uniform float uBlend;   // 0.0 = pure uModeA, 1.0 = pure uModeB
uniform int   uModeA;
uniform int   uModeB;

varying vec2 vUv;

const int MODE_PASSTHROUGH = 0;
const int MODE_THRESHOLD   = 1;
const int MODE_CRT         = 2;
const int MODE_GLITCH      = 3;
const int MODE_WIREFRAME   = 4;

float hash(float n) {
  return fract(sin(n) * 43758.5453);
}

vec3 effectPassthrough() {
  return texture2D(uTexture, vUv).rgb;
}

vec3 effectThreshold() {
  vec4 tex  = texture2D(uTexture, vUv);
  float luma = dot(tex.rgb, vec3(0.299, 0.587, 0.114));

  vec3 shadow    = vec3(1.0, 0.0, 0.235);  // #FF003C Cyber Red
  vec3 highlight = vec3(0.0, 1.0, 0.255);  // #00FF41 Matrix Green

  return luma > uThreshold ? highlight : shadow;
}

vec3 effectCrt() {
  vec4 tex = texture2D(uTexture, vUv);

  float scanline = sin(vUv.y * 800.0 + uTime * 4.0) * 0.04 * uIntensity;

  vec2 uv2 = vUv * 2.0 - 1.0;
  float vignette = 1.0 - dot(uv2, uv2) * 0.4 * uIntensity;

  vec3 crt = tex.rgb;
  crt.g *= 1.0 + 0.08 * uIntensity;
  crt -= scanline;
  crt *= vignette;

  return crt;
}

vec3 effectGlitch() {
  float shift = uGlitch * 0.01 * (hash(uSeed) * 2.0 - 1.0);

  float band = floor(vUv.y * 20.0);
  float bandShift = hash(band + uSeed) > (1.0 - uGlitch * 0.3)
    ? (hash(band * 3.7 + uSeed) - 0.5) * 0.1 * uGlitch
    : 0.0;

  float r = texture2D(uTexture, vec2(vUv.x + shift + bandShift, vUv.y)).r;
  float g = texture2D(uTexture, vUv).g;
  float b = texture2D(uTexture, vec2(vUv.x - shift, vUv.y)).b;

  return vec3(r, g, b);
}

vec3 effectWireframe() {
  float lineWidth = 0.03;
  vec2 grid = abs(fract(vUv * 8.0 - 0.5) - 0.5);
  float d = min(grid.x, grid.y);
  float line = step(d, lineWidth);

  float flicker = 0.8 + 0.2 * sin(uTime * 12.0 + vUv.y * 30.0);
  vec3 color = vec3(0.0, 1.0, 0.255) * line * flicker;

  float scan = sin(vUv.y * 200.0 + uTime * 3.0) * 0.05;
  color += scan * vec3(0.0, 0.3, 0.0);

  return color;
}

vec3 evalMode(int mode) {
  if (mode == MODE_THRESHOLD) return effectThreshold();
  if (mode == MODE_CRT)       return effectCrt();
  if (mode == MODE_GLITCH)    return effectGlitch();
  if (mode == MODE_WIREFRAME) return effectWireframe();
  return effectPassthrough();
}

void main() {
  // Skip evaluating the far side entirely once a blend has fully settled —
  // cheap early-out for the (common) t=0 and t=1 endpoints.
  if (uBlend <= 0.0) {
    gl_FragColor = vec4(evalMode(uModeA), 1.0);
    return;
  }
  if (uBlend >= 1.0) {
    gl_FragColor = vec4(evalMode(uModeB), 1.0);
    return;
  }

  vec3 colorA = evalMode(uModeA);
  vec3 colorB = evalMode(uModeB);
  gl_FragColor = vec4(mix(colorA, colorB, uBlend), 1.0);
}
