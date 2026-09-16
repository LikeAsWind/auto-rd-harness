/**
 * Ambient declaration for DSH's native directory picker.
 *
 * `@deepseek-ai/dsh-host-directory-picker-native` is NOT installed in
 * this repo's dev `node_modules` — it lives inside DSH's runtime. We
 * import it lazily (see services/pick-directory-route.ts) and declare
 * the minimal surface we use here so `tsc` can type-check without the
 * package on disk.
 */
declare module '@deepseek-ai/dsh-host-directory-picker-native' {
  /**
   * Open the platform-native single-directory chooser.
   *
   * Windows: Win32 COM dialog in a spawned child (koffi).
   * macOS: osascript "choose folder".
   * Linux: zenity, falling back to kdialog.
   *
   * @param signal abort to cancel / close the dialog; rejects on abort.
   * @returns the absolute path, or null when the user cancels.
   */
  export function pickNativeDirectory(signal: AbortSignal): Promise<string | null>
}
