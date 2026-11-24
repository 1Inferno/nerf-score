/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare module 'virtual:project-sources' {
  export interface ProjectSourceFile {
    path: string;
    encoding: 'utf8' | 'base64';
    content: string;
  }
  export const PROJECT_FILES: ProjectSourceFile[];
}
