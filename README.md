# Dock Manager

GNOME Shell extension (GNOME 48) that moves the dash out of the overview into a dock on the desktop. A personal fork of [Dash to Dock](https://github.com/ubuntu/dash-to-dock) v110, cut down to the features I use and with no colors of its own: the dock shows GNOME's own style, and any extension that recolors the shell (such as [Shell Color Manager](https://github.com/vidalwannabe/shell-color-manager)) recolors it too.

## Features

**Position**

| Option | What it does |
| --- | --- |
| Show the dock on / Show on all monitors | The monitor the dock is on, or one dock per monitor |
| Isolate monitors | Each dock shows only the applications with windows on its monitor |
| Position on screen | Left, bottom, top or right |
| Intelligent autohide | On unless the dock is fixed. The dock hides when a window of the focused application touches it. With Show on mouse hover on, it shows when the pointer rests on the screen edge, also in fullscreen and for urgent windows if enabled, with its own animation, show and hide timeouts |

Pinned and running applications of every workspace are always shown. Unless extended, the dock takes up to 90% of the screen edge; icons are 64 px (GNOME's own size) and the ones that don't fit are reached by scrolling over the dock.

**Appearance**

| Option | What it does |
| --- | --- |
| Extended dock | The dock spans the whole screen edge |
| Centralize icons | With Extended dock, the icons sit in the middle of the edge |
| Straight corners | No rounded corners |
| Transparent background | The dock without its background |
| Colored indicator dots | One dot per window (up to four), in the icon's dominant color instead of the dot's |

**Icons**

Click focuses an application, or minimizes it when it is focused already; Shift+click minimizes all its windows; middle click opens a new window. The right-click menu lists the open windows, the application's actions, pin and quit.

## Files

| File | Contents |
| --- | --- |
| `extension.js` | The dock: docking, intellihide, theming and the extension entry point |
| `dash.js` | The row of icons inside the dock |
| `appIcons.js` | Each icon, its menu and the running dots |
| `handlers.js` | Connecting signals and replacing GNOME's methods, undone when the dock is disabled |
| `prefs.js` | The preferences window |
| `stylesheet.css` | The dock's layout |
| `schemas/` | The settings |

## Installation

Clone the repository into `~/.local/share/gnome-shell/extensions/dock-manager@vidalwannabe.github.io`, compile the settings and log out and back in:

```bash
git clone https://github.com/vidalwannabe/dock-manager.git ~/.local/share/gnome-shell/extensions/dock-manager@vidalwannabe.github.io
glib-compile-schemas ~/.local/share/gnome-shell/extensions/dock-manager@vidalwannabe.github.io/schemas
```

Then enable it with GNOME Extensions or `gnome-extensions enable dock-manager@vidalwannabe.github.io`. Disable Dash to Dock or Ubuntu Dock first.

## License

Distributed under the terms of the GNU General Public License, version 2 or later, like Dash to Dock. See the COPYING file for details.
