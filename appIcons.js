// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Extension from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Docking from './extension.js';
import * as Locations from './locations.js';
import * as Utils from './utils.js';

// Use __() and N__() for the extension gettext domain, and the shell domain with _() and N_().
const {gettext: __, ngettext: N__} = Extension;
const {signals: Signals} = imports;
const {cairo: Cairo} = imports;

const Labels = Object.freeze({
    ISOLATE_MONITORS: Symbol('isolate-monitors'),
    URGENT_WINDOWS: Symbol('urgent-windows'),
});

// module "Dash" did not export DASH_ITEM_LABEL_SHOW_TIME, so let's define it.
const DASH_ITEM_LABEL_SHOW_TIME = Dash.DASH_ITEM_LABEL_SHOW_TIME ?? 150;

/**
 * Extend AppIcon
 *
 * - Apply a css class based on the number of windows of each application (#N);
 * - Customized indicators for running applications in place of the default "dot" style which is hidden (#N);
 *   a class of the form "running#N" is applied to the AppWellIcon actor.
 *   like the original .running one.
 * - Add a .focused style to the focused app
 * - Customize click actions.
 * - Update minimization animation target
 * - Update menu if open on windows change
 */
export const DockAbstractAppIcon = GObject.registerClass({
    GTypeFlags: GObject.TypeFlags.ABSTRACT,
    Properties: {
        'focused': GObject.ParamSpec.boolean(
            'focused', 'focused', 'focused',
            GObject.ParamFlags.READWRITE,
            false),
        'running': GObject.ParamSpec.boolean(
            'running', 'running', 'running',
            GObject.ParamFlags.READWRITE,
            false),
        'urgent': GObject.ParamSpec.boolean(
            'urgent', 'urgent', 'urgent',
            GObject.ParamFlags.READWRITE,
            false),
        'updating': GObject.ParamSpec.boolean(
            'updating', 'updating', 'updating',
            GObject.ParamFlags.READWRITE,
            false),
        'windows-count': GObject.ParamSpec.uint(
            'windows-count', 'windows-count', 'windows-count',
            GObject.ParamFlags.READWRITE,
            0, GLib.MAXUINT32, 0),
    },
}, class DockAbstractAppIcon extends Dash.DashIcon {
    // settings are required inside.
    _init(app, monitorIndex) {
        super._init(app);

        // a prefix is required to avoid conflicting with the parent class variable
        this.monitorIndex = monitorIndex;
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);
        this._indicator = new RunningIndicatorDots(this);
        this._urgentWindows = new Set();

        // Monitor windows-changes instead of app state.
        // Keep using the same Id and function callback (that is extended)
        if (this._stateChangedId > 0) {
            this.app.disconnect(this._stateChangedId);
            this._stateChangedId = 0;
        }

        this._signalsHandler.add(this.app, 'windows-changed', () => this._updateWindows());
        this._signalsHandler.add(this.app, 'notify::state', () => this._updateRunningState());
        this._signalsHandler.add(global.display, 'window-demands-attention', (_dpy, window) =>
            this._onWindowDemandsAttention(window));
        this._signalsHandler.add(global.display, 'window-marked-urgent', (_dpy, window) =>
            this._onWindowDemandsAttention(window));

        // In Wayland sessions, this signal is needed to track the state of windows dragged
        // from one monitor to another. As this is triggered quite often (whenever a new
        // window of any application opened or moved to a different desktop),
        // we restrict this signal to  the case when Labels.ISOLATE_MONITORS is true,
        // and if there are at least 2 monitors.
        if (Docking.DockManager.settings.isolateMonitors &&
            Main.layoutManager.monitors.length > 1) {
            this._signalsHandler.addWithLabel(Labels.ISOLATE_MONITORS,
                global.display,
                'window-entered-monitor',
                this._onWindowEntered.bind(this));
        }

        this.connect('notify::running', () => {
            if (this.running)
                this.add_style_class_name('running');
            else
                this.remove_style_class_name('running');
        });
        this.notify('running');

        this.connect('notify::focused', () => {
            if (this.focused)
                this.add_style_class_name('focused');
            else
                this.remove_style_class_name('focused');
        });
        this.notify('focused');

        this.connect('notify::updating', () => {
            if (this.updating)
                this.add_style_class_name('updating');
            else
                this.remove_style_class_name('updating');
        });
        this.notify('updating');

        this.connect('notify::urgent', () => {
            this._signalsHandler.removeWithLabel(Labels.URGENT_WINDOWS);
            if (this.urgent) {
                if (this.running && !this._urgentWindows.size) {
                    const urgentWindows = this.getInterestingWindows();
                    urgentWindows.forEach(w => (w._manualUrgency = true));
                    this._updateUrgentWindows(urgentWindows);
                }
            } else {
                this._urgentWindows.forEach(w => delete w._manualUrgency);
                this._updateUrgentWindows();
            }
        });
        this.notify('urgent');

        this._updateState();
    }

    _onDestroy() {
        super._onDestroy();

        delete this._menu;
    }

    ownsWindow(window) {
        return this.app === Docking.DockManager.windowTracker.get_window_app(window);
    }

    _onWindowEntered(metaScreen, monitorIndex, metaWin) {
        if (this.ownsWindow(metaWin))
            this._updateWindows();
    }

    _updateWindows() {
        if (this._menu && this._menu.isOpen)
            this._menu.update();

        this._updateState();
        this.updateIconGeometry();
    }

    _updateState() {
        this._urgentWindows.clear();
        const interestingWindows = this.getInterestingWindows();
        this.windowsCount = interestingWindows.length;
        this._updateRunningState();
        this._updateFocusState();
        this._updateUrgentWindows(interestingWindows);
    }

    _updateRunningState() {
        this.running = (this.app.state === Shell.AppState.RUNNING) && this.windowsCount;
    }

    _updateFocusState() {
        this.focused = this.running &&
            Docking.DockManager.windowTracker.focus_app === this.app;
    }

    _updateUrgentWindows(interestingWindows) {
        this._signalsHandler.removeWithLabel(Labels.URGENT_WINDOWS);
        this._urgentWindows.clear();
        if (interestingWindows === undefined)
            interestingWindows = this.getInterestingWindows();
        interestingWindows.filter(isWindowUrgent).forEach(win => this._addUrgentWindow(win));
        this.urgent = !!this._urgentWindows.size;
    }

    _onWindowDemandsAttention(window) {
        if (this.ownsWindow(window) && isWindowUrgent(window))
            this._addUrgentWindow(window);
    }

    _updateDotStyle() {
        super._updateDotStyle();
        const themeNode = this._dot.get_theme_node();
        this._dot.translationX = themeNode.get_length('offset-x');
        this._dot.translationY = 0;
    }

    _addUrgentWindow(window) {
        if (this._urgentWindows.has(window))
            return;

        if (window._manualUrgency && window.has_focus()) {
            delete window._manualUrgency;
            return;
        }

        this._urgentWindows.add(window);
        this.urgent = true;

        const onDemandsAttentionChanged = () => {
            if (!isWindowUrgent(window))
                this._updateUrgentWindows();
        };

        if (window.demandsAttention) {
            this._signalsHandler.addWithLabel(Labels.URGENT_WINDOWS, window,
                'notify::demands-attention', () => onDemandsAttentionChanged());
        }
        if (window.urgent) {
            this._signalsHandler.addWithLabel(Labels.URGENT_WINDOWS, window,
                'notify::urgent', () => onDemandsAttentionChanged());
        }
        if (window._manualUrgency) {
            this._signalsHandler.addWithLabel(Labels.URGENT_WINDOWS, window,
                'focus', () => {
                    delete window._manualUrgency;
                    onDemandsAttentionChanged();
                });
        }
    }

    /**
     * Update target for minimization animation
     */
    updateIconGeometry() {
        // If (for unknown reason) the actor is not on the stage the reported size
        // and position are random values, which might exceeds the integer range
        // resulting in an error when assigned to the a rect. This is a more like
        // a workaround to prevent flooding the system with errors.
        if (!this.get_stage())
            return;

        const rect = new Mtk.Rectangle();

        [rect.x, rect.y] = this.get_transformed_position();
        [rect.width, rect.height] = this.get_transformed_size();

        let windows = this.getWindows();
        if (Docking.DockManager.settings.multiMonitor) {
            const {monitorIndex} = this;
            windows = windows.filter(w => w.get_monitor() === monitorIndex);
        }
        windows.forEach(w => w.set_icon_geometry(rect));
    }

    _updateRunningStyle() {
        // The logic originally in this function has been moved to
        // RunningIndicatorDots.update(). However it cannot be removed as
        // it called by the parent constructor.
    }

    notifyAppIconUpdating(monitorIndex) {
        const icon = Gio.Icon.new_for_string('action-unavailable-symbolic');
        const {osdWindowManager} = Main;
        const showOsd = osdWindowManager.showOne ?? osdWindowManager.show;
        showOsd.call(osdWindowManager, monitorIndex ?? this.monitorIndex, icon,
            __('%s is updating, try again later').format(this.name), null);
    }

    popupMenu() {
        this._removeMenuTimeout?.();
        this.fake_release();
        this._draggable.fakeRelease?.();

        if (!this._menu) {
            this._menu = new DockAppIconMenu(this);
            this._menu.connect('activate-window', (menu, window) => {
                if (window) {
                    Main.activateWindow(window);
                } else {
                    Main.overview.hide();
                    Main.panel.closeCalendar();
                }
            });
            this._menu.connect('open-state-changed', (menu, isPoppedUp) => {
                if (!isPoppedUp) {
                    this._onMenuPoppedDown();
                } else {
                    // Setting the max-height is s useful if part of the menu is
                    // scrollable so the minimum height is smaller than the natural height.
                    const monitorIndex = Main.layoutManager.findIndexForActor(this);
                    const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
                    const position = Utils.getPosition();
                    const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
                    const isHorizontal = position === St.Side.TOP || position === St.Side.BOTTOM;
                    // If horizontal also remove the height of the dash
                    const {dockFixed: fixedDock} = Docking.DockManager.settings;
                    const additionalMargin = isHorizontal && !fixedDock ? Main.overview.dash.height : 0;
                    const verticalMargins = this._menu.actor.margin_top + this._menu.actor.margin_bottom;
                    const maxMenuHeight = workArea.height - additionalMargin - verticalMargins;
                    // Also set a max width to the menu, so long labels (long windows title) get truncated
                    this._menu.actor.style = 'max-width: 400px; ' +
                        `max-height: ${Math.round(maxMenuHeight / scaleFactor)}px;`;
                }
            });
            const id = Main.overview.connect('hiding', () => {
                this._menu.close();
            });
            this._menu.actor.connect('destroy', () => {
                Main.overview.disconnect(id);
            });

            this._menuManager.addMenu(this._menu);
        }

        this.emit('menu-state-changed', true);

        this.set_hover(true);
        this._menu.popup();
        // Removed in GNOME 50.
        this._menuManager.ignoreRelease?.();
        this.emit('sync-tooltip');

        return false;
    }

    activate(button) {
        const event = Clutter.get_current_event();
        this._activate({
            button,
            modifiers: event?.get_state() ?? 0,
        });
    }

    // Primary click on a running application focuses it, or minimizes all its windows
    // when it is focused already; Shift+click minimizes all its windows; middle click opens
    // a new window. Any other click is GNOME's own.
    _activate({button, modifiers}) {
        // Only consider SHIFT and CONTROL as modifiers (exclude SUPER, CAPS-LOCK, etc.)
        modifiers &= Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK;
        const isPrimaryClick = button === 1 && !(modifiers & Clutter.ModifierType.CONTROL_MASK);
        const isMiddleClick = button === 2 && !modifiers;
        if (!isPrimaryClick && !isMiddleClick) {
            super.activate(button);
            return;
        }

        if (!this.running || isMiddleClick) {
            this.launchNewWindow();
        } else if (modifiers & Clutter.ModifierType.SHIFT_MASK) {
            this._minimizeWindow(true);
        } else if (Main.overview.visible) {
            // In the overview, a click just shows the application.
            Main.activateWindow(this.getInterestingWindows()[0]);
        } else if (this.focused && !this._urgentWindows.size) {
            this._minimizeWindow(true);
        } else {
            this._activateAllWindows();
        }
        Main.overview.hide();
    }

    // Try to do the right thing when attempting to launch a new window of an app. In
    // particular, if the application doesn't allow to launch a new window, activate
    // the existing window instead.
    launchNewWindow() {
        if (this.updating) {
            this.notifyAppIconUpdating();
            return;
        }

        if (this.app.state === Shell.AppState.RUNNING &&
            this.app.can_open_new_window()) {
            this.animateLaunch();
            this.app.open_new_window(-1);
        } else {
            // Try to manually activate the first window. Otherwise, when the
            // app is activated by switching to a different workspace, a launch
            // spinning icon is shown and disappears only after a timeout.
            const windows = this.getWindows();
            if (windows.length > 0) {
                Main.activateWindow(windows[0]);
            } else {
                this.app.activate();
                this.animateLaunch();
            }
        }
    }

    _minimizeWindow(param) {
        // Param true make all app windows minimize
        const windows = this.getInterestingWindows();
        const currentWorkspace = global.workspace_manager.get_active_workspace();
        for (let i = 0; i < windows.length; i++) {
            const w = windows[i];
            if (w.get_workspace() === currentWorkspace && w.showing_on_its_workspace()) {
                w.minimize();
                // Just minimize one window. By specification it should be the
                // focused window on the current workspace.
                if (!param)
                    break;
            }
        }
    }

    // By default only non minimized windows are activated.
    // This activates all windows in the current workspace.
    _activateAllWindows() {
        // First activate first window so workspace is switched if needed.
        // We don't do this if isolation is on!
        if (!Docking.DockManager.settings.isolateMonitors) {
            if (!this.running)
                this.animateLaunch();
            this.app.activate();
        }

        // then activate all other app windows in the current workspace
        const windows = this.getInterestingWindows();
        const activeWorkspace = global.workspace_manager.get_active_workspace_index();

        if (windows.length <= 0)
            return;

        for (let i = windows.length - 1; i >= 0; i--) {
            if (windows[i].get_workspace()?.index() === activeWorkspace)
                Main.activateWindow(windows[i]);
        }
    }

    // This closes all windows of the app.
    closeAllWindows() {
        const windows = this.getInterestingWindows();
        const time = global.get_current_time();
        windows.forEach(w => w.delete(time));
    }

    getWindows() {
        return this.app.get_windows();
    }

    // Filter out unnecessary windows, for instance
    // nautilus desktop window.
    getInterestingWindows() {
        const interestingWindows = getInterestingWindows(this.getWindows(),
            this.monitorIndex);

        if (!this._urgentWindows.size)
            return interestingWindows;

        return [...new Set([...this._urgentWindows, ...interestingWindows])];
    }

    getSnapName() {
        return this.app.appInfo?.get_string('X-SnapInstanceName');
    }
});

const DockAppIcon = GObject.registerClass({
}, class DockAppIcon extends DockAbstractAppIcon {
    _init(app, monitorIndex) {
        super._init(app, monitorIndex);

        const {windowTracker} = Docking.DockManager;
        this._signalsHandler.add(windowTracker, 'notify::focus-app',
            () => this._updateFocusState());
    }
});

const DockLocationAppIcon = GObject.registerClass({
}, class DockLocationAppIcon extends DockAbstractAppIcon {
    _init(app, monitorIndex) {
        if (!(app.appInfo instanceof Locations.LocationAppInfo))
            throw new Error('Provided application %s is not a Location'.format(app));

        super._init(app, monitorIndex);

        this._signalsHandler.add(global.display, 'notify::focus-window',
            () => this._updateFocusState());

        this._signalsHandler.add(this.app, 'notify::icon', () => this.icon.update());
    }

    get location() {
        return this.app.location;
    }

    _updateFocusState() {
        this.focused = this.app.isFocused && this.running;
    }
});

/**
 * @param app
 * @param monitorIndex
 */
export function makeAppIcon(app, monitorIndex) {
    if (app.appInfo instanceof Locations.LocationAppInfo)
        return new DockLocationAppIcon(app, monitorIndex);

    return new DockAppIcon(app, monitorIndex);
}

/**
 * DockAppIconMenu
 *
 * - set popup arrow side based on dash orientation
 * - Add close windows option based on quitfromdash extension
 *   (https://github.com/deuill/shell-extension-quitfromdash)
 * - Add open windows thumbnails instead of list
 * - update menu when application windows change
 */
const DockAppIconMenu = class DockAppIconMenu extends PopupMenu.PopupMenu {
    constructor(source) {
        super(source, 0.5, Utils.getPosition());

        this._signalsHandler = new Utils.GlobalSignalsHandler(this);

        // We want to keep the item hovered while the menu is up
        this.blockSourceEvents = true;

        this.actor.add_style_class_name('app-menu');
        this.actor.add_style_class_name('dock-app-menu');

        // Chain our visibility and lifecycle to that of the source
        this._signalsHandler.add(source, 'notify::mapped', () => {
            if (!source.mapped)
                this.close();
        });
        this._signalsHandler.add(source, 'destroy', () => this.destroy());

        Main.uiGroup.add_child(this.actor);
    }

    destroy() {
        super.destroy();
        delete this.sourceActor;
        delete this._signalsHandler;
    }

    _appendSeparator() {
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    _appendMenuItem(labelText, params) {
        const item = new PopupMenu.PopupMenuItem(labelText, params);
        this.addMenuItem(item);
        return item;
    }

    popup(_activatingButton) {
        this._rebuildMenu();
        this.open(BoxPointer.PopupAnimation.FULL);
    }

    removeAll() {
        super.removeAll();

        delete this._quitMenuItem;
    }

    _rebuildMenu() {
        this.removeAll();

        const appItemLabel = this.sourceActor.updating
            ? __('%s is being updated…').format(this.sourceActor.name)
            : this.sourceActor.name;
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(appItemLabel));

        const {app} = this.sourceActor;

        const windows = this.sourceActor.getInterestingWindows();
        if (windows.length > 0)
            this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Open Windows')));

        windows.forEach(window => {
            const title = window.title ? window.title : app.get_name();
            const item = this._appendMenuItem(title);
            item.connect('activate', () => {
                this.emit('activate-window', window);
            });
        });

        if (!app.is_window_backed()) {
            this._appendSeparator();

            const appInfo = app.get_app_info();
            const actions = this.sourceActor.updating ? [] : appInfo.list_actions();
            if (!this.sourceActor.updating &&
                app.can_open_new_window() &&
                actions.indexOf('new-window') === -1) {
                const newMenuItem = this._appendMenuItem(_('New Window'));
                newMenuItem.connect('activate', () => {
                    if (app.state === Shell.AppState.STOPPED)
                        this.sourceActor.animateLaunch();

                    app.open_new_window(-1);
                    this.emit('activate-window', null);
                });
                this._appendSeparator();
            }

            if (!this.sourceActor.updating &&
                Docking.DockManager.getDefault().discreteGpuAvailable &&
                app.state === Shell.AppState.STOPPED) {
                const appPrefersNonDefaultGPU = appInfo.get_boolean('PrefersNonDefaultGPU');
                const gpuPref = appPrefersNonDefaultGPU
                    ? Shell.AppLaunchGpu.DEFAULT
                    : Shell.AppLaunchGpu.DISCRETE;
                const gpuMenuItem = this._appendMenuItem(appPrefersNonDefaultGPU
                    ? __('Launch using Integrated Graphics Card')
                    : __('Launch using Discrete Graphics Card'));
                gpuMenuItem.connect('activate', () => {
                    this.sourceActor.animateLaunch();
                    app.launch(0, -1, gpuPref);
                    this.emit('activate-window', null);
                });
            }

            for (let i = 0; i < actions.length; i++) {
                const action = actions[i];
                const item = this._appendMenuItem(appInfo.get_action_name(action));
                item.sensitive = !appInfo.busy;
                item.connect('activate', (emitter, event) => {
                    app.launch_action(action, event.get_time(), -1);
                    this.emit('activate-window', null);
                });
            }

            const canFavorite = global.settings.is_writable('favorite-apps') &&
                (this.sourceActor instanceof DockAppIcon) &&
                ParentalControlsManager.getDefault().shouldShowApp(app.appInfo);

            if (canFavorite) {
                this._appendSeparator();

                const isFavorite = AppFavorites.getAppFavorites().isFavorite(app.get_id());
                if (isFavorite) {
                    const item = this._appendMenuItem(_('Unpin'));
                    item.connect('activate', () => {
                        const favs = AppFavorites.getAppFavorites();
                        favs.removeFavorite(app.get_id());
                    });
                } else {
                    const item = this._appendMenuItem(__('Pin to Dock'));
                    item.connect('activate', () => {
                        const favs = AppFavorites.getAppFavorites();
                        favs.addFavorite(app.get_id());
                    });
                }
            }

            if (Shell.AppSystem.get_default().lookup_app('org.gnome.Software.desktop') &&
                this.sourceActor instanceof DockAppIcon &&
                !this.sourceActor.getSnapName()) {
                this._appendSeparator();
                const item = this._appendMenuItem(_('App Details'));
                item.connect('activate', () => {
                    const id = app.get_id();
                    const args = GLib.Variant.new('(ss)', [id, '']);
                    Gio.DBus.get(Gio.BusType.SESSION, null,
                        (o, res) => {
                            const bus = Gio.DBus.get_finish(res);
                            bus.call('org.gnome.Software',
                                '/org/gnome/Software',
                                'org.gtk.Actions', 'Activate',
                                GLib.Variant.new('(sava{sv})',
                                    ['details', [args], null]),
                                null, 0, -1, null, null);
                            Main.overview.hide();
                        });
                });
            }

            if (this.sourceActor instanceof DockAppIcon) {
                const snapName = this.sourceActor.getSnapName();
                const snapStore = snapName
                    ? Shell.AppSystem.get_default().lookup_app(
                        'snap-store_snap-store.desktop') : null;

                if (snapStore) {
                    this._appendSeparator();
                    const item = this._appendMenuItem(_('App Details'));
                    item.connect('activate', (_, event) => {
                        snapStore.activate_full(-1, event.get_time());
                        Util.spawnApp(
                            [...snapStore.appInfo.get_commandline().split(' '), snapName]);
                        Main.overview.hide();
                    });
                }
            }
        }

        // quit menu
        this._appendSeparator();
        this._quitMenuItem = this._appendMenuItem(_('Quit'));
        this._quitMenuItem.connect('activate', () => this.sourceActor.closeAllWindows());

        this.update();
    }

    // update menu content when application windows change. This is desirable as actions
    // acting on windows (closing) are performed while the menu is shown.
    update() {
        const {windowsCount} = this.sourceActor;

        // update, show or hide the quit menu
        if (windowsCount > 0) {
            if (windowsCount === 1) {
                this._quitMenuItem.label.set_text(_('Quit'));
            } else {
                this._quitMenuItem.label.set_text(N__(
                    'Quit %d Window', 'Quit %d Windows', windowsCount).format(
                    windowsCount));
            }

            this._quitMenuItem.actor.show();
        } else {
            this._quitMenuItem.actor.hide();
        }

        // Update separators
        this._getMenuItems().forEach(item => {
            if ('label' in item)
                this._updateSeparatorVisibility(item);
        });
    }
};

/**
 * @param w
 */
function isWindowUrgent(w) {
    return w.urgent || w.demandsAttention || w._manualUrgency;
}

/**
 * Filter out unnecessary windows, for instance
 * nautilus desktop window.
 *
 * @param windows
 * @param monitorIndex
 */
export function getInterestingWindows(windows, monitorIndex) {
    const {settings} = Docking.DockManager;

    if (settings.isolateMonitors && monitorIndex >= 0) {
        windows = windows.filter(w => {
            return w.get_monitor() === monitorIndex;
        });
    }

    return windows.filter(w => !w.skipTaskbar);
}

/**
 * A ShowAppsIcon improved class.
 *
 * - set label position based on dash orientation
 *   Note: we are am reusing most machinery of the appIcon class.
 * - implement a popupMenu based on the AppIcon code
 *   Note: we are reusing most machinery of the appIcon class)
 *
 */

export const DockShowAppsIcon = GObject.registerClass({
    Signals: {
        'menu-state-changed': {param_types: [GObject.TYPE_BOOLEAN]},
        'sync-tooltip': {},
    },
}
, class DockShowAppsIcon extends Dash.ShowAppsIcon {
    _init(position) {
        super._init();

        // Re-use appIcon methods
        const {prototype: appIconPrototype} = AppDisplay.AppIcon;
        this.toggleButton.y_expand = false;
        this.toggleButton.connect('popup-menu', () =>
            appIconPrototype._onKeyboardPopupMenu.call(this));
        this.toggleButton.connect('clicked', () =>
            this._removeMenuTimeout());

        this.reactive = true;
        this.toggleButton.popupMenu = (...args) =>
            this.popupMenu(...args);
        this.toggleButton._setPopupTimeout = (...args) =>
            this._setPopupTimeout(...args);
        this.toggleButton._removeMenuTimeout = (...args) =>
            this._removeMenuTimeout(...args);

        this.label?.add_style_class_name(Docking.PositionStyleClass[position]);

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menuTimeoutId = 0;

        this._maybeEnablePopupGestures();
    }

    _createIcon(size) {
        this._iconActor = super._createIcon(size);
        this._iconActor.fallbackIconName = this._iconActor.iconName;
        this._iconActor.fallbackGicon = this._iconActor.gicon;
        this._iconActor.iconName = `view-app-grid-${Main.sessionMode.currentMode}-symbolic`;
        return this._iconActor;
    }

    vfunc_leave_event(...args) {
        return AppDisplay.AppIcon.prototype.vfunc_leave_event.call(
            this.toggleButton, ...args);
    }

    vfunc_button_press_event(...args) {
        try {
            // TODO: Drop this when not supporting GNOME 48 (and older) anymore.
            return AppDisplay.AppIcon.prototype.vfunc_button_press_event.call(
                this.toggleButton, ...args);
        } catch {
            return Clutter.EVENT_PROPAGATE;
        }
    }

    vfunc_touch_event(...args) {
        try {
            // TODO: Drop this when not supporting GNOME 48 (and older) anymore.
            return AppDisplay.AppIcon.prototype.vfunc_touch_event.call(
                this.toggleButton, ...args);
        } catch {
            return Clutter.EVENT_PROPAGATE;
        }
    }

    showLabel(...args) {
        itemShowLabel.call(this, ...args);
    }

    setForcedHighlight(...args) {
        AppDisplay.AppIcon.prototype.setForcedHighlight.call(this, ...args);
    }

    _onMenuPoppedDown(...args) {
        AppDisplay.AppIcon.prototype._onMenuPoppedDown.call(this, ...args);
    }

    _setPopupTimeout(...args) {
        AppDisplay.AppIcon.prototype._setPopupTimeout.call(this, ...args);
    }

    _removeMenuTimeout(...args) {
        AppDisplay.AppIcon.prototype._removeMenuTimeout?.call(this, ...args);
    }

    _hasPopupMenu() {
        return Docking.DockManager.extension.uuid !== 'ubuntu-dock@ubuntu.com';
    }

    _maybeEnablePopupGestures() {
        if (!this._hasPopupMenu())
            return;

        if (!Clutter.LongPressGesture || !Clutter.ClickGesture)
            return;

        const longPressGesture = new Clutter.LongPressGesture();
        longPressGesture.connect('recognize', () => this.popupMenu());
        this.add_action(longPressGesture);

        const rightClickGesture = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_SECONDARY,
            recognize_on_press: true,
        });
        rightClickGesture.connect('recognize', () => this.popupMenu());
        this.add_action(rightClickGesture);
    }

    popupMenu() {
        if (!this._hasPopupMenu())
            return false;

        this._removeMenuTimeout();
        this.toggleButton.fake_release();

        if (!this._menu) {
            this._menu = new DockShowAppsIconMenu(this);
            this._menu.connect('open-state-changed', (menu, isPoppedUp) => {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            });
            const id = Main.overview.connect('hiding', () => {
                this._menu.close();
            });
            this._menu.actor.connect('destroy', () => {
                Main.overview.disconnect(id);
            });
            this._menuManager.addMenu(this._menu);
        }

        this.emit('menu-state-changed', true);

        this.toggleButton.set_hover(true);
        this._menu.popup();
        // Removed in GNOME 50.
        this._menuManager.ignoreRelease?.();
        this.emit('sync-tooltip');

        return false;
    }
});

/**
 * A menu for the showAppsIcon
 */
class DockShowAppsIconMenu extends DockAppIconMenu {
    _rebuildMenu() {
        this.removeAll();

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(__('Dock Manager')));

        const item = this._appendMenuItem(_('Settings'));
        item.connect('activate', () =>
            Docking.DockManager.extension.openPreferences());
    }
}

/**
 * This function is used for both DockShowAppsIcon and DockDashItemContainer
 */
export function itemShowLabel() {
    /* eslint-disable no-invalid-this */
    // Check if the label is still present at all. When switching workspace, the
    // item might have been destroyed in between.
    if (!this._labelText || !this.label.get_stage())
        return;

    this.label.set_text(this._labelText);
    this.label.opacity = 0;
    this.label.show();

    const [stageX, stageY] = this.get_transformed_position();
    const node = this.label.get_theme_node();

    const itemWidth  = this.allocation.x2 - this.allocation.x1;
    const itemHeight = this.allocation.y2 - this.allocation.y1;

    const labelWidth = this.label.get_width();
    const labelHeight = this.label.get_height();

    let x, y, xOffset, yOffset;

    const position = Utils.getPosition();
    const labelOffset = node.get_length('-x-offset');

    switch (position) {
    case St.Side.LEFT:
        yOffset = Math.floor((itemHeight - labelHeight) / 2);
        y = stageY + yOffset;
        xOffset = labelOffset;
        x = stageX + this.get_width() + xOffset;
        break;
    case St.Side.RIGHT:
        yOffset = Math.floor((itemHeight - labelHeight) / 2);
        y = stageY + yOffset;
        xOffset = labelOffset;
        x = Math.round(stageX) - labelWidth - xOffset;
        break;
    case St.Side.TOP:
        y = stageY + labelOffset + itemHeight;
        xOffset = Math.floor((itemWidth - labelWidth) / 2);
        x = stageX + xOffset;
        break;
    case St.Side.BOTTOM:
        yOffset = labelOffset;
        y = stageY - labelHeight - yOffset;
        xOffset = Math.floor((itemWidth - labelWidth) / 2);
        x = stageX + xOffset;
        break;
    }

    // keep the label inside the screen border
    // Only needed fot the x coordinate.

    // Leave a few pixel gap
    const gap = 5;
    const monitor = Main.layoutManager.findMonitorForActor(this);
    if (x - monitor.x < gap)
        x += monitor.x - x + labelOffset;
    else if (x + labelWidth > monitor.x + monitor.width - gap)
        x -= x + labelWidth - (monitor.x + monitor.width) + gap;

    this.label.remove_all_transitions();
    this.label.set_position(x, y);
    this.label.ease({
        opacity: 255,
        duration: DASH_ITEM_LABEL_SHOW_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
    /* eslint-enable no-invalid-this */
}

// ---------- Running indicators ----------

const MAX_WINDOWS_CLASSES = 4;

const IndicatorDrawingArea = GObject.registerClass(
class IndicatorDrawingArea extends St.DrawingArea {
    vfunc_allocate(box) {
        if (box.x1 !== 0 || box.y1 !== 0)
            return super.vfunc_allocate(box);

        // We assume that the are is a rectangle in the operations below:
        const size = Math.min(box.get_width(), box.get_height());
        box.x2 = size;
        box.y2 = size;
        this.set_allocation(box);

        return super.vfunc_allocate(box);
    }
});

// The running dots: one per window, up to MAX_WINDOWS_CLASSES, drawn in place of GNOME's dot
// (kept hidden, so the icon keeps its layout) with the dot's style or the icon's dominant color.
class RunningIndicatorDots {
    constructor(source) {
        this._source = source;
        this._signalsHandler = new Utils.GlobalSignalsHandler(source);
        this._side = Utils.getPosition();
        this._dominantColorExtractor = new DominantColorExtractor(source.app);

        // I use opacity to hide the default dot because the show/hide function
        // are used by the parent class.
        source._dot.opacity = 0;

        this._area = new IndicatorDrawingArea({
            x_expand: true,
            y_expand: true,
        });

        // We draw for the bottom case and rotate the canvas for other placements
        // set center of rotations to the center
        this._area.set_pivot_point(0.5, 0.5);

        switch (this._side) {
        case St.Side.TOP:
            this._area.rotation_angle_z = 180;
            break;

        case St.Side.LEFT:
            this._area.rotation_angle_z = 90;
            break;

        case St.Side.RIGHT:
            this._area.rotation_angle_z = -90;
            break;
        }

        this._area.connectObject('repaint', this._updateIndicator.bind(this), this);
        source._iconContainer.add_child(this._area);

        this._signalsHandler.add([
            source,
            'notify::running',
            () => this.update(),
        ], [
            source,
            'notify::focused',
            () => this.update(),
        ], [
            source,
            'notify::windows-count',
            () => this._updateCounterClass(),
        ], [
            Docking.DockManager.settings,
            'changed::running-indicator-dominant-color',
            () => this.update(),
        ]);
        this.update();
    }

    get _number() {
        return Math.min(this._source.windowsCount, MAX_WINDOWS_CLASSES);
    }

    update() {
        this._updateCounterClass();

        if (this._source.running)
            this._source._dot.show();
        else
            this._source._dot.hide();

        this._area.queue_repaint();
    }

    _updateCounterClass() {
        for (let i = 1; i <= MAX_WINDOWS_CLASSES; i++) {
            const className = `running${i}`;
            if (i !== this._number)
                this._source.remove_style_class_name(className);
            else
                this._source.add_style_class_name(className);
        }
    }

    _computeStyle() {
        const [width, height] = this._area.get_surface_size();
        this._width = height;
        this._height = width;

        // By default re-use the style - background color, and border width and color -
        // of the default dot
        const themeNode = this._source._dot.get_theme_node();
        this._borderColor = themeNode.get_border_color(this._side);
        this._borderWidth = themeNode.get_border_width(this._side);
        this._bodyColor = themeNode.get_background_color();

        // Apply dominant color if requested, keeping the dot's color when the icon has none
        if (Docking.DockManager.settings.runningIndicatorDominantColor) {
            const colorPalette = this._dominantColorExtractor._getColorPalette();
            if (colorPalette) {
                const Color = Clutter.Color ?? Cogl.Color;
                [, this._bodyColor] = Color.from_string(colorPalette.original);
            }
        }

        // Define the radius as an arbitrary size, but keep large enough to account
        // for the drawing of the border.
        this._radius = Math.max(this._width / 22, this._borderWidth / 2);
        this._padding = 0; // distance from the margin
        this._spacing = this._radius + this._borderWidth; // separation between the dots
    }

    _updateIndicator() {
        const cr = this._area.get_context();

        this._computeStyle();
        this._drawIndicator(cr);
        cr.$dispose();
    }

    _drawIndicator(cr) {
        // Draw the required numbers of dots
        const n = this._number;

        cr.setLineWidth(this._borderWidth);
        Utils.cairoSetSourceColor(cr, this._borderColor);

        // draw for the bottom case:
        cr.translate(
            (this._width - (2 * n) * this._radius - (n - 1) * this._spacing) / 2,
            this._height - this._padding);

        for (let i = 0; i < n; i++) {
            cr.newSubPath();
            cr.arc((2 * i + 1) * this._radius + i * this._spacing,
                -this._radius - this._borderWidth / 2,
                this._radius, 0, 2 * Math.PI);
        }

        cr.strokePreserve();
        Utils.cairoSetSourceColor(cr, this._bodyColor);
        cr.fill();
    }

    destroy() {
        this._area.destroy();
        delete this._area;
        this._source._dot.opacity = 255;
        this._source = null;
        this._signalsHandler.destroy();
        this._signalsHandler = null;
    }
}

// Global icon cache of the dominant colors.
const iconCacheMap = new Map();
// Max number of items to store
// We don't expect to ever reach this number, but let's put an hard limit to avoid
// even the remote possibility of the cached items to grow indefinitely.
const MAX_CACHED_ITEMS = 1000;
// When the size exceed it, the oldest 'n' ones are deleted
const  BATCH_SIZE_TO_DELETE = 50;
// The icon size used to extract the dominant color
const DOMINANT_COLOR_ICON_SIZE = 64;

// Compute dominant color from the app icon.
// The color is cached for efficiency.
class DominantColorExtractor {
    constructor(app) {
        this._app = app;
    }

    /**
     * Try to get the pixel buffer for the current icon, if not fail gracefully
     */
    _getIconPixBuf() {
        let iconTexture = this._app.create_icon_texture(16);
        const themeLoader = Docking.DockManager.iconTheme;

        // Unable to load the icon texture, use fallback
        if (iconTexture instanceof St.Icon === false)
            return null;

        iconTexture = iconTexture.get_gicon();

        // Unable to load the icon texture, use fallback
        if (!iconTexture)
            return null;

        if (iconTexture instanceof Gio.FileIcon) {
            // Use GdkPixBuf to load the pixel buffer from the provided file path
            return GdkPixbuf.Pixbuf.new_from_file(iconTexture.get_file().get_path());
        } else if (iconTexture instanceof Gio.ThemedIcon) {
            // Get the first pixel buffer available in the icon theme
            const iconNames = iconTexture.get_names();
            const iconInfo = themeLoader.choose_icon(iconNames, DOMINANT_COLOR_ICON_SIZE, 0);

            if (iconInfo)
                return iconInfo.load_icon();
            else
                return null;
        }

        // Use GdkPixBuf to load the pixel buffer from memory
        // iconTexture.load is available unless iconTexture is not an instance of Gio.LoadableIcon
        // this means that iconTexture is an instance of Gio.EmblemedIcon,
        // which may be converted to a normal icon via iconTexture.get_icon?
        const [iconBuffer] = iconTexture.load(DOMINANT_COLOR_ICON_SIZE, null);
        return GdkPixbuf.Pixbuf.new_from_stream(iconBuffer, null);
    }

    /**
     * The backlight color choosing algorithm was mostly ported to javascript from the
     * Unity7 C++ source of Canonicals:
     * https://bazaar.launchpad.net/~unity-team/unity/trunk/view/head:/launcher/LauncherIcon.cpp
     * so it more or less works the same way.
     */
    _getColorPalette() {
        if (iconCacheMap.get(this._app.get_id())) {
            // We already know the answer
            return iconCacheMap.get(this._app.get_id());
        }

        const pixBuf = this._getIconPixBuf();
        if (!pixBuf)
            return null;

        let pixels = pixBuf.get_pixels();

        let total  = 0,
            rTotal = 0,
            gTotal = 0,
            bTotal = 0;

        let resampleX = 1;
        let resampleY = 1;

        // Resampling of large icons
        // We resample icons larger than twice the desired size, as the resampling
        // to a size s
        // DOMINANT_COLOR_ICON_SIZE < s < 2*DOMINANT_COLOR_ICON_SIZE,
        // most of the case exactly DOMINANT_COLOR_ICON_SIZE as the icon size is
        // typically a multiple of it.
        const width = pixBuf.get_width();
        const height = pixBuf.get_height();

        // Resample
        if (height >= 2 * DOMINANT_COLOR_ICON_SIZE)
            resampleY = Math.floor(height / DOMINANT_COLOR_ICON_SIZE);

        if (width >= 2 * DOMINANT_COLOR_ICON_SIZE)
            resampleX = Math.floor(width / DOMINANT_COLOR_ICON_SIZE);

        if (resampleX !== 1 || resampleY !== 1)
            pixels = this._resamplePixels(pixels, resampleX, resampleY);

        // computing the limit outside the for (where it would be repeated at each iteration)
        // for performance reasons
        const limit = pixels.length;
        for (let offset = 0; offset < limit; offset += 4) {
            const r = pixels[offset],
                g = pixels[offset + 1],
                b = pixels[offset + 2],
                a = pixels[offset + 3];

            const saturation = Math.max(r, g, b) - Math.min(r, g, b);
            const relevance  = 0.1 * 255 * 255 + 0.9 * a * saturation;

            rTotal += r * relevance;
            gTotal += g * relevance;
            bTotal += b * relevance;

            total += relevance;
        }

        total *= 255;

        const r = rTotal / total,
            g = gTotal / total,
            b = bTotal / total;

        const hsv = Utils.ColorUtils.RGBtoHSV(r * 255, g * 255, b * 255);

        if (hsv.s > 0.15)
            hsv.s = 0.65;
        hsv.v = 0.90;

        const rgb = Utils.ColorUtils.HSVtoRGB(hsv.h, hsv.s, hsv.v);

        // Cache the result.
        const backgroundColor = {
            lighter:  Utils.ColorUtils.ColorLuminance(rgb.r, rgb.g, rgb.b, 0.2),
            original: Utils.ColorUtils.ColorLuminance(rgb.r, rgb.g, rgb.b, 0),
            darker:   Utils.ColorUtils.ColorLuminance(rgb.r, rgb.g, rgb.b, -0.5),
        };

        if (iconCacheMap.size >= MAX_CACHED_ITEMS) {
            // delete oldest cached values (which are in order of insertions)
            let ctr = 0;
            for (const key of iconCacheMap.keys()) {
                if (++ctr > BATCH_SIZE_TO_DELETE)
                    break;
                iconCacheMap.delete(key);
            }
        }

        iconCacheMap.set(this._app.get_id(), backgroundColor);

        return backgroundColor;
    }

    /**
     * Downscale large icons before scanning for the backlight color to
     * improve performance.
     *
     * @param pixBuf
     * @param pixels
     * @param resampleX
     * @param resampleY
     *
     * @returns [];
     */
    _resamplePixels(pixels, resampleX, resampleY) {
        const resampledPixels = [];
        // computing the limit outside the for (where it would be repeated at each iteration)
        // for performance reasons
        const limit = pixels.length / (resampleX * resampleY) / 4;
        for (let i = 0; i < limit; i++) {
            const pixel = i * resampleX * resampleY;

            resampledPixels.push(pixels[pixel * 4]);
            resampledPixels.push(pixels[pixel * 4 + 1]);
            resampledPixels.push(pixels[pixel * 4 + 2]);
            resampledPixels.push(pixels[pixel * 4 + 3]);
        }

        return resampledPixels;
    }
}
