// quackpit's $.state contract. The engine holds two values for the session,
// so a hot reload or a /config change (which reloads the module) keeps the
// cockpit where it was:
//   cockpit  everything quackpit observed this session (src/model.ts `Cockpit`)
//   ui       what the band and pane draw from besides it: the layout, the
//            detected graphics mode, the guide, the last handover
// Both are declared as plain JSON: the shapes live in the agent-agnostic
// core (src/), which this self-contained contract cannot import, and the
// adapter checks every read (`asCockpit`, `asUi`) before trusting it.

export type QuackpitJson = string | number | boolean | null | QuackpitJson[] | { [key: string]: QuackpitJson }

declare module 'claude-code' {
  interface PluginState {
    quackpit: {
      cockpit: QuackpitJson
      ui: QuackpitJson
    }
  }
}
