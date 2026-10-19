/** Desktop-only host API; Electron is provided by Obsidian rather than bundled. */
declare module 'electron' {
  export const shell: {openPath(path: string): Promise<string>};
}
