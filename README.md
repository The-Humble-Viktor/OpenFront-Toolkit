# OpenFront Toolkit

A Tampermonkey userscript for [OpenFront.io](https://openfront.io) that bundles Alliance Auto-Renew, Turbo Place, Nuke/Boat Trackers, and Performance tools into a single panel.

**Version:** 1.4.0

---

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open `openfront-toolkit.user.js` and click **Install**, or paste its contents into a new Tampermonkey script.
3. Navigate to [openfront.io](https://openfront.io) — the toolbar icon (🛠️) appears in the in-game sidebar between the settings and exit buttons.

---

## Features

### Auto-Renew (Tab 0)

Automates alliance renewal so you never lose an ally to an expired timer.

- When an alliance renewal prompt appears, a **⭐ AUTO Renew** button is added alongside the normal renew button. Clicking it queues that player and immediately renews.
- When an incoming alliance request arrives from a queued player, it is **auto-accepted**.
- Every 5 seconds, the script proactively sends extension events for alliances within ~20 seconds of expiry and new alliance requests to queued players you are not currently allied with.
- When an alliance is broken, the player is automatically removed from the queue.
- The queued player list is visible and editable inside the panel (✕ to remove).

### Turbo Place (Tab 1)

Continuously places structures while a build key is held down.

- Hold any build keybind (default: `1`–`0`) to repeatedly place that structure at your cursor position.
- Respects custom keybinds saved in `localStorage` (`settings.keybinds`).
- **Placement Interval:** 50–2000 ms (default 150 ms). Adjust with the − / + buttons or click the label to type a value directly.
- A heads-up banner shows the active unit type while turbo is running.
- Releasing the key stops placement cleanly.

| Default Key | Structure |
|-------------|-----------|
| `1` | City |
| `2` | Factory |
| `3` | Port |
| `4` | Defense Post |
| `5` | Missile Silo |
| `6` | SAM Launcher |
| `7` | Warship |
| `8` | Atom Bomb |
| `9` | Hydrogen Bomb |
| `0` | MIRV |

### Trackers (Tab 2)

Renders an overlay canvas on top of the game canvas. No modifications to game rendering — purely additive.

**Nuke Tracker**
- Draws the bezier flight arc for every airborne nuke (Atom Bomb, Hydrogen Bomb, MIRV Warhead).
- Draws inner and outer blast-radius circles at the target tile.
- Shows a live countdown timer (seconds to impact) above each target.
- Direction (arc up/down) is inferred once the nuke has traveled ≥10% of its path.

**Boat Tracker**
- Draws an orange dashed line from each transport ship's current position to its landing zone.
- Highlights the exact target tile with an orange fill and border.
- Shows a dot at the ship's current position.

### Performance (Tab 3)

**Live Stats** — updates every 500 ms:
- FPS and frame time
- TPS (ticks per second) and active nuke/unit counts

**FPS Limit** — segmented control: `15` / `30` / `Off`
Wraps `requestAnimationFrame` with a `setTimeout` throttle when a limit is active.

**Render Toggles** — suppress unit types from the game's render pipeline (sends a one-time `isActive: false` kill signal, then omits the unit entirely on subsequent ticks):
- Disable Nuke Rendering
- Disable Warship Rendering
- Disable Train Rendering
- Disable Trade Boat Rendering

**Anti-AFK Ping** — sends a keep-alive `ping` over the game WebSocket every 2 seconds to prevent the server from marking you as disconnected during lag spikes.

---

## Preferences

All settings (enabled states, turbo interval, FPS limit, render toggles, anti-AFK) are persisted to `localStorage` under the key `ofToolkit.prefs` and restored on page load.

---

## Notes

- The script uses `@run-at document-start` and `@grant none` to run in the page world directly, allowing it to wrap `requestAnimationFrame`, `fetch`, `WebSocket`, and canvas APIs before the game loads.
- The overlay canvas is `pointer-events: none` and does not interfere with game input.
- The panel is draggable by its header.
