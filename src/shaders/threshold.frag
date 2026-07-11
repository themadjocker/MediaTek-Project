precision mediump float;

uniform sampler2D uTexture;
uniform float uThreshold;

varying vec2 vUv;

void main() {
  vec4 tex = texture2D(uTexture, vUv);
  float luma = dot(tex.rgb, vec3(0.299, 0.587, 0.114));

  vec3 shadow    = vec3(1.0, 0.0, 0.235);  // #FF003C Cyber Red
  vec3 highlight = vec3(0.0, 1.0, 0.255);  // #00FF41 Matrix Green

  vec3 color = luma > uThreshold ? highlight : shadow;
  gl_FragColor = vec4(color, 1.0);
}
