# OpenFront Toolkit

A Tampermonkey userscript for [openfront.io](https://openfront.io) that bundles three quality-of-life features into a single lightweight script.

## Features

### Alliance Auto-Renew
Automatically re-accepts alliance renewal requests from players you've queued. When an alliance renewal prompt appears, an extra **★ AUTO Renew** button is added alongside the normal Renew button. Clicking it accepts the current renewal *and* queues that player so all future renewals with them are handled silently. A **✕ Stop AUTO** button appears in the notification so you can opt out immediately. The managed list is visible in the toolkit panel and players are automatically dequeued if their alliance is broken.

### Turbo Place
Continuously fires placement events while a build key is held down, so structures are placed as fast as the game accepts them. The active unit type is shown in an on-screen indicator. Placement interval is adjustable from **50 ms** to **2000 ms** (default 150 ms) via ± buttons or a direct numeric input in the panel. Off by default — enable it in the panel before use.

### Nuke Tracker
Renders a transparent overlay on the game canvas showing:
- **Trajectory arc** (dashed red Bézier curve) from launch site to impact
- **Impact zone circles** sized to the weapon type (Atom Bomb, Hydrogen Bomb, MIRV Warhead)
- **Countdown timer** in seconds above each impact zone

The tracker hooks into the game's Web Worker messages to detect nukes the moment they spawn, and measures actual in-flight speed to improve countdown accuracy.

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open Tampermonkey → **Create a new script**.
3. Paste the contents of `openfront-toolkit.user.js` and save.

Or install directly by opening the raw `.user.js` file — Tampermonkey will detect it and prompt for installation.

## Usage

A **🛠️** button is injected into the game's right sidebar (between the Settings and Exit buttons) once a game starts. Clicking it opens the toolkit panel, which has three tabs:

| Tab | What you can do |
|---|---|
| **Auto-Renew** | Toggle the feature on/off; view and remove queued players |
| **Turbo Place** | Toggle on/off; adjust the placement interval |
| **Nuke Tracker** | Toggle on/off |

All toggle states and the Turbo Place interval are persisted to `localStorage` and restored on every page load.

### Default key bindings (Turbo Place)

Turbo Place respects your in-game keybind settings. The defaults are:

| Key | Structure |
|---|---|
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

Custom keybinds saved via the in-game Settings menu are picked up automatically on next key press.

## Compatibility

- **Browser:** Any Chromium or Firefox browser with Tampermonkey support
- **Site:** `https://openfront.io/*` and `https://www.openfront.io/*`
- **Permissions:** None (`@grant none`) — runs in the page world with no elevated privileges

## Notes

- The nuke tracker overlay is canvas-based and uses `pointer-events: none`, so it never interferes with game input.
- Turbo Place pauses automatically when the browser tab is backgrounded (RAF-based timer).
- Auto-Renew queued players are session-specific — smallIDs change between games, so the list resets naturally.
