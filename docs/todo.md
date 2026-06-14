# Follow-ups / verify after next build

## True-peak ceiling default should open at -1.0 dB
- **Reported:** an earlier build showed the True-peak ceiling defaulting to **-2.3** dB.
- **Finding:** the code default is already `-1.0` ([main.go:129](../main.go#L129),
  `ceiling.SetValue(-1.0)`), and `-2.3` was never committed (verified via `git log -S`).
  There is no settings persistence, so the -2.3 was a manual edit / a stale screenshot
  build — not a code default.
- **Action:** on the next CI build, confirm a **fresh launch** opens the ceiling spinner at
  **-1.0**. If it still shows -2.3 (a GTK init quirk where `SetValue` doesn't render until
  the widget is realized), fix by setting the value after `win.ShowAll()` or via an explicit
  `gtk.AdjustmentNew(...)`. No engine recompile involved — GUI-only.
