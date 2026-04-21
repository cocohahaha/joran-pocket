/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNALING_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
