/// <reference types="vite/client" />

// GLSL shader imports via vite-plugin-glsl
declare module '*.vert?raw' { const src: string; export default src; }
declare module '*.frag?raw' { const src: string; export default src; }
declare module '*.glsl?raw' { const src: string; export default src; }
