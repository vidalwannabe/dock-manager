# Dash to Dock (Dock Manager fork)

Personal fork of [Dash to Dock](https://github.com/ubuntu/dash-to-dock) v110. Its only change: `stylesheet.css` keeps the dock's layout (margins, padding, sizes, spacing) and has no colors, backgrounds, corners or transparencies, so the dock shows GNOME's own style and any extension that recolors the shell recolors it too.

## A dock for the GNOME Shell
This extension enhances the dash moving it out of the overview and transforming it in a dock for an easier launching of applications and a faster switching between windows and desktops without having to leave the desktop view.

[<img src="https://micheleg.github.io/dash-to-dock/media/get-it-on-ego.png" height="100">](https://extensions.gnome.org/extension/307/dash-to-dock)

For additional installation instructions and more information visit [https://micheleg.github.io/dash-to-dock/](https://micheleg.github.io/dash-to-dock/).

## Installation from source

The extension can be installed directly from source, either for the convenience of using git or to test the latest development version. Clone the desired branch with git

### Build Dependencies

`glib-compile-schemas` and `gettext`. No SASS: this fork keeps a plain `stylesheet.css` with only the dock's layout, so it has no colors of its own (see the top of this file).

### Building

Clone the repository or download the branch from github. A simple Makefile is included.

Next use `make` to install the extension into your home directory. A Shell reload is required <kbd>Alt</kbd> + <kbd>F2</kbd> <kbd>r</kbd> <kbd>Enter</kbd> under Xorg or under Wayland you may have to logout and login. The extension has to be enabled  with *gnome-extensions-app* (GNOME Extensions) or with *dconf*.

```bash
git clone https://github.com/micheleg/dash-to-dock.git
make -C dash-to-dock install
```

If `msgfmt` is not available on your system, you will see an error message like the following:

```bash
make: msgfmt: No such file or directory
```

In this case install the `gettext` package from your distribution's repository.


## Bug Reporting

Bugs should be reported to the Github bug tracker [https://github.com/micheleg/dash-to-dock/issues](https://github.com/micheleg/dash-to-dock/issues).

## License
Dash to Dock Gnome Shell extension is distributed under the terms of the GNU General Public License,
version 2 or later. See the COPYING file for details.
