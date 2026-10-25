// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Extension from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as AppMenu from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';

import * as Docking from './extension.js';
import * as Locations from './locations.js';
import * as Utils from './utils.js';

// Use __() and N__() for the extension gettext domain, and the shell domain with _() and N_().
const {gettext: __, ngettext: N__} = Extension;
const {signals: Signals} = imports;
const {cairo: Cairo} = imports;

const DBusMenu = await haveDBusMenu();

const Labels = Object.freeze({
    ISOLATE_MONITORS: Symbol('isolate-monitors'),
    ISOLATE_WORKSPACES: Symbol('isolate-workspaces'),
    URGENT_WINDOWS: Symbol('urgent-windows'),
    RESULTS: Symbol('results'),
    ICONS: Symbol('icons'),
    SOURCES: Symbol('sources'),
    NOTIFICATIONS: Symbol('notifications'),
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
    _init(app, monitorIndex, iconAnimator) {
        super._init(app);

        // a prefix is required to avoid conflicting with the parent class variable
        this.monitorIndex = monitorIndex;
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);
        this.iconAnimator = iconAnimator;
        this._indicator = new AppIconIndicator(this);
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

        const {notificationsMonitor} = Docking.DockManager.getDefault();

        this.connect('notify::urgent', () => {
            const icon = this.icon._iconBin;
            this._signalsHandler.removeWithLabel(Labels.URGENT_WINDOWS);
            if (this.urgent) {
                if (Docking.DockManager.settings.danceUrgentApplications &&
                    notificationsMonitor.enabled) {
                    icon.set_pivot_point(0.5, 0.5);
                    this.iconAnimator.addAnimation(icon, 'wiggle');
                }
                if (this.running && !this._urgentWindows.size) {
                    const urgentWindows = this.getInterestingWindows();
                    urgentWindows.forEach(w => (w._manualUrgency = true));
                    this._updateUrgentWindows(urgentWindows);
                }
            } else {
                this.iconAnimator.removeAnimation(icon, 'wiggle');
                icon.rotation_angle_z = 0;
                this._urgentWindows.forEach(w => delete w._manualUrgency);
                this._updateUrgentWindows();
            }
        });
        this.notify('urgent');

        this._progressOverlayArea = null;
        this._progress = 0;

        [
            'running-indicator-style',
            'show-icons-emblems',
            'show-icons-notifications-counter',
            'application-counter-overrides-notifications',
        ].forEach(key => {
            this._signalsHandler.add(
                Docking.DockManager.settings,
                `changed::${key}`, () => {
                    this._indicator.destroy();
                    this._indicator = new AppIconIndicator(this);
                }
            );
        });

        this._signalsHandler.add(notificationsMonitor, 'state-changed', () => {
            this._indicator.destroy();
            this._indicator = new AppIconIndicator(this);
        });

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

        if (Docking.DockManager.settings.isolateWorkspaces) {
            this._signalsHandler.removeWithLabel(Labels.ISOLATE_WORKSPACES);
            interestingWindows.forEach(window =>
                this._signalsHandler.addWithLabel(Labels.ISOLATE_WORKSPACES,
                    window, 'workspace-changed', () => this._updateWindows()));
        }
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
        // AppIconIndicatorBase._updateDefaultDot(). However it cannot be removed as
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
        if (!Docking.DockManager.settings.isolateWorkspaces &&
            !Docking.DockManager.settings.isolateMonitors) {
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
    _init(app, monitorIndex, iconAnimator) {
        super._init(app, monitorIndex, iconAnimator);

        const {windowTracker} = Docking.DockManager;
        this._signalsHandler.add(windowTracker, 'notify::focus-app',
            () => this._updateFocusState());
    }
});

const DockLocationAppIcon = GObject.registerClass({
}, class DockLocationAppIcon extends DockAbstractAppIcon {
    _init(app, monitorIndex, iconAnimator) {
        if (!(app.appInfo instanceof Locations.LocationAppInfo))
            throw new Error('Provided application %s is not a Location'.format(app));

        super._init(app, monitorIndex, iconAnimator);

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
 * @param iconAnimator
 */
export function makeAppIcon(app, monitorIndex, iconAnimator) {
    if (app.appInfo instanceof Locations.LocationAppInfo)
        return new DockLocationAppIcon(app, monitorIndex, iconAnimator);

    return new DockAppIcon(app, monitorIndex, iconAnimator);
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

        const {remoteModel} = Docking.DockManager.getDefault();
        const remoteModelApp = remoteModel?.lookupById(this.sourceActor?.app?.id);
        if (remoteModelApp && DBusMenu) {
            const [onQuickList, onDynamicSection] = Utils.splitHandler((sender,
                {quicklist}, dynamicSection) => {
                dynamicSection.removeAll();
                if (quicklist) {
                    quicklist.get_children().forEach(remoteItem =>
                        dynamicSection.addMenuItem(
                            makePopupMenuItem(remoteItem, false)));
                }
            });

            this._signalsHandler.add([
                remoteModelApp,
                'quicklist-changed',
                onQuickList,
            ], [
                this,
                'dynamic-section-changed',
                onDynamicSection,
            ]);
        }
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

        delete this._allWindowsMenuItem;
        delete this._quitMenuItem;
    }

    _rebuildMenu() {
        this.removeAll();

        const appItemLabel = this.sourceActor.updating
            ? __('%s is being updated…').format(this.sourceActor.name)
            : this.sourceActor.name;
        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(appItemLabel));

        const {app} = this.sourceActor;

        if (Docking.DockManager.settings.showWindowsPreview) {
            // Display the app windows menu items and the separator between windows
            // of the current desktop and other windows.
            const windows = this.sourceActor.getInterestingWindows();

            this._allWindowsMenuItem = new PopupMenu.PopupSubMenuMenuItem(__('All Windows'), false);
            if (this._allWindowsMenuItem.menu?.actor)
                this._allWindowsMenuItem.menu.actor.overlayScrollbars = true;
            this._allWindowsMenuItem.hide();
            if (windows.length > 0)
                this.addMenuItem(this._allWindowsMenuItem);
        } else {
            const windows = this.sourceActor.getInterestingWindows();

            if (windows.length > 0) {
                this.addMenuItem(
                    /* TRANSLATORS: This is the heading of a list of open windows */
                    new PopupMenu.PopupSeparatorMenuItem(_('Open Windows')));
            }

            windows.forEach(window => {
                const title = window.title ? window.title : app.get_name();
                const item = this._appendMenuItem(title);
                item.connect('activate', () => {
                    this.emit('activate-window', window);
                });
            });
        }

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

        // dynamic menu
        const items = this._getMenuItems();
        let i = items.length;
        if (Shell.AppSystem.get_default().lookup_app('org.gnome.Software.desktop'))
            i -= 2;

        if (global.settings.is_writable('favorite-apps'))
            i -= 2;

        if (i < 0)
            i = 0;

        const dynamicSection = new PopupMenu.PopupMenuSection();
        this.addMenuItem(dynamicSection, i);
        this.emit('dynamic-section-changed', dynamicSection);

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

        if (Docking.DockManager.settings.showWindowsPreview) {
            const windows = this.sourceActor.getInterestingWindows();

            // update, show, or hide the allWindows menu
            // Check if there are new windows not already displayed. In such case,
            // repopulate the allWindows menu. Windows removal is already handled
            // by each preview being connected to the destroy signal
            const oldWindows = this._allWindowsMenuItem.menu._getMenuItems().map(item => {
                return item._window;
            });

            const newWindows = windows.filter(w =>
                oldWindows.indexOf(w) < 0);
            if (newWindows.length > 0) {
                this._populateAllWindowMenu(windows);

                // Try to set the width to that of the submenu.
                // TODO: can't get the actual size, getting a bit less.
                // Temporary workaround: add 15px to compensate
                this._allWindowsMenuItem.width =  this._allWindowsMenuItem.menu.actor.width + 15;
            }

            // The menu is created hidden and never hidden after being shown.
            // Instead, a signal connected to its items destroy will set is
            // insensitive if no more windows preview are shown.
            if (windows.length > 0) {
                this._allWindowsMenuItem.show();
                this._allWindowsMenuItem.setSensitive(true);

                if (Docking.DockManager.settings.defaultWindowsPreviewToOpen)
                    this._allWindowsMenuItem.menu.open();
            }
        }

        // Update separators
        this._getMenuItems().forEach(item => {
            if ('label' in item)
                this._updateSeparatorVisibility(item);
        });
    }

    _populateAllWindowMenu(windows) {
        this._allWindowsMenuItem.menu.removeAll();

        if (windows.length > 0) {
            const activeWorkspace = global.workspace_manager.get_active_workspace();
            let separatorShown =  windows[0].get_workspace() !== activeWorkspace;

            for (let i = 0; i < windows.length; i++) {
                const window = windows[i];
                if (!separatorShown && window.get_workspace() !== activeWorkspace) {
                    this._allWindowsMenuItem.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                    separatorShown = true;
                }

                const item = new WindowPreviewMenuItem(window,
                    St.Side.LEFT);
                this._allWindowsMenuItem.menu.addMenuItem(item);
                item.connect('activate', () => {
                    this.emit('activate-window', window);
                });

                // This is to achieve a more graceful transition when the last
                // window is closed.
                item.connect('destroy', () => {
                    // It's still counting the item just going to be destroyed
                    if (this._allWindowsMenuItem.menu._getMenuItems().length === 1)
                        this._allWindowsMenuItem.setSensitive(false);
                });
            }
        }
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

    // When using workspace isolation, we filter out windows
    // that are neither in the current workspace nor marked urgent
    if (settings.isolateWorkspaces) {
        const showUrgent = settings.workspaceAgnosticUrgentWindows;
        const activeWorkspace = global.workspace_manager.get_active_workspace();
        windows = windows.filter(w => {
            const inWorkspace = w.get_workspace() === activeWorkspace;
            return inWorkspace || (showUrgent && isWindowUrgent(w));
        });
    }

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

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(__('Dash to Dock')));

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

const RunningIndicatorStyle = Object.freeze({
    DEFAULT: 0,
    DOTS: 1,
    SQUARES: 2,
    DASHES: 3,
    SEGMENTED: 4,
    SOLID: 5,
    CILIORA: 6,
    METRO: 7,
    BINARY: 8,
    DOT: 9,
});

const MAX_WINDOWS_CLASSES = 4;

/*
 * This is the main indicator class to be used. The desired behavior is
 * obtained by composing the desired classes below based on the settings.
 *
 */
export class AppIconIndicator {
    constructor(source) {
        this._indicators = [];

        // Choose the style for the running indicators
        let runningIndicator = null;

        const {settings} = Docking.DockManager;
        const {runningIndicatorStyle} = settings;

        if (settings.showIconsEmblems &&
            !Docking.DockManager.getDefault().notificationsMonitor.dndMode) {
            const unityIndicator = new UnityIndicator(source);
            this._indicators.push(unityIndicator);
        }

        switch (runningIndicatorStyle) {
        case RunningIndicatorStyle.DEFAULT:
            runningIndicator = new RunningIndicatorDefault(source);
            break;

        case RunningIndicatorStyle.DOTS:
            runningIndicator = new RunningIndicatorDots(source);
            break;

        case RunningIndicatorStyle.SQUARES:
            runningIndicator = new RunningIndicatorSquares(source);
            break;

        case RunningIndicatorStyle.DASHES:
            runningIndicator = new RunningIndicatorDashes(source);
            break;

        case RunningIndicatorStyle.SEGMENTED:
            runningIndicator = new RunningIndicatorSegmented(source);
            break;

        case RunningIndicatorStyle.SOLID:
            runningIndicator = new RunningIndicatorSolid(source);
            break;

        case RunningIndicatorStyle.CILIORA:
            runningIndicator = new RunningIndicatorCiliora(source);
            break;

        case RunningIndicatorStyle.METRO:
            runningIndicator = new RunningIndicatorMetro(source);
            break;

        case RunningIndicatorStyle.BINARY:
            runningIndicator = new RunningIndicatorBinary(source);
            break;

        case RunningIndicatorStyle.DOT:
            runningIndicator = new RunningIndicatorDot(source);
            break;

        default:
            runningIndicator = new RunningIndicatorBase(source);
        }

        this._indicators.push(runningIndicator);
    }

    update() {
        for (let i = 0; i < this._indicators.length; i++) {
            const indicator = this._indicators[i];
            indicator.update();
        }
    }

    destroy() {
        for (let i = 0; i < this._indicators.length; i++) {
            const indicator = this._indicators[i];
            indicator.destroy();
        }
    }
}

/*
 * Base class to be inherited by all indicators of any kind
*/
class IndicatorBase {
    constructor(source) {
        this._source = source;
        this._signalsHandler = new Utils.GlobalSignalsHandler(this._source);
    }

    update() {
    }

    destroy() {
        this._source = null;
        this._signalsHandler.destroy();
        this._signalsHandler = null;
    }
}

/*
 * A base indicator class for running style, from which all other RunningIndicators should derive,
 * providing some basic methods, variables definitions and their update,  css style classes handling.
 *
 */
class RunningIndicatorBase extends IndicatorBase {
    constructor(source) {
        super(source);

        this._side = Utils.getPosition();
        this._dominantColorExtractor = new DominantColorExtractor(this._source.app);
        this._signalsHandler.add(this._source, 'notify::running', () => this.update());
        this._signalsHandler.add(this._source, 'notify::focused', () => this.update());
        this._signalsHandler.add(this._source, 'notify::windows-count', () => this._updateCounterClass());
        this.update();
    }

    get _number() {
        return Math.min(this._source.windowsCount, MAX_WINDOWS_CLASSES);
    }

    update() {
        this._updateCounterClass();
        this._updateDefaultDot();
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

    _updateDefaultDot() {
        if (this._source.running)
            this._source._dot.show();
        else
            this._source._dot.hide();
    }

    _hideDefaultDot() {
        // I use opacity to hide the default dot because the show/hide function
        // are used by the parent class.
        this._source._dot.opacity = 0;
    }

    _restoreDefaultDot() {
        this._source._dot.opacity = 255;
    }

    _enableBacklight() {
        const colorPalette = this._dominantColorExtractor._getColorPalette();

        // Fallback
        if (!colorPalette) {
            this._source._iconContainer.set_style(
                'border-radius: 5px;' +
                'background-gradient-direction: vertical;' +
                'background-gradient-start: #e0e0e0;' +
                'background-gradient-end: darkgray;'
            );

            return;
        }

        this._source._iconContainer.set_style(
            `${'border-radius: 5px;' +
            'background-gradient-direction: vertical;' +
            'background-gradient-start: '}${colorPalette.original};` +
            `background-gradient-end: ${colorPalette.darker};`
        );
    }

    _disableBacklight() {
        this._source._iconContainer.set_style(null);
    }

    destroy() {
        this._disableBacklight();
        this._restoreDefaultDot();

        super.destroy();
    }
}

// We add a css class so third parties themes can limit their indicator customization
// to the case we do nothing
class RunningIndicatorDefault extends RunningIndicatorBase {
    constructor(source) {
        super(source);
        this._source.add_style_class_name('default');
    }

    destroy() {
        this._source.remove_style_class_name('default');
        super.destroy();
    }
}

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

class RunningIndicatorDots extends RunningIndicatorBase {
    constructor(source) {
        super(source);

        this._hideDefaultDot();

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

        case St.Side.BOTTOM:
            // nothing
            break;

        case St.Side.LEFT:
            this._area.rotation_angle_z = 90;
            break;

        case St.Side.RIGHT:
            this._area.rotation_angle_z = -90;
            break;
        }

        this._area.connectObject('repaint', this._updateIndicator.bind(this), this);
        this._source._iconContainer.add_child(this._area);

        const keys = ['custom-theme-running-dots-color',
            'custom-theme-running-dots-border-color',
            'custom-theme-running-dots-border-width',
            'custom-theme-customize-running-dots',
            'unity-backlit-items',
            'running-indicator-dominant-color'];

        keys.forEach(function (key) {
            this._signalsHandler.add(
                Docking.DockManager.settings,
                `changed::${key}`,
                this.update.bind(this)
            );
        }, this);
    }

    update() {
        super.update();

        // Enable / Disable the backlight of running apps
        if (Docking.DockManager.settings.unityBacklitItems) {
            if (this._source.running)
                this._enableBacklight();
            else
                this._disableBacklight();
        } else {
            this._disableBacklight();
        }

        if (this._area)
            this._area.queue_repaint();
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

        const {settings} = Docking.DockManager;
        // Adjust for the backlit case
        const Color = Clutter.Color ?? Cogl.Color;

        if (settings.unityBacklitItems) {
            // Use dominant color for dots too if the backlit is enables
            const colorPalette = this._dominantColorExtractor._getColorPalette();

            // Slightly adjust the styling
            this._borderWidth = 2;

            if (colorPalette) {
                [, this._borderColor] = Color.from_string(colorPalette.lighter);
                [, this._bodyColor] = Color.from_string(colorPalette.darker);
            } else {
                // Fallback
                [, this._borderColor] = Color.from_string('white');
                [, this._bodyColor] = Color.from_string('gray');
            }
        }

        // Apply dominant color if requested
        if (settings.runningIndicatorDominantColor) {
            const colorPalette = this._dominantColorExtractor._getColorPalette();
            if (colorPalette)
                [, this._bodyColor] = Color.from_string(colorPalette.original);
            else
                // Fallback
                [, this._bodyColor] = Color.from_string(settings.customThemeRunningDotsColor);
        }

        // Finally, use customize style if requested
        if (settings.customThemeCustomizeRunningDots) {
            [, this._borderColor] = Color.from_string(settings.customThemeRunningDotsBorderColor);
            this._borderWidth = settings.customThemeRunningDotsBorderWidth;
            [, this._bodyColor] =  Color.from_string(settings.customThemeRunningDotsColor);
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
        super.destroy();
    }
}

// Adapted from dash-to-panel by Jason DeRose
// https://github.com/jderose9/dash-to-panel
class RunningIndicatorCiliora extends RunningIndicatorDots {
    _drawIndicator(cr) {
        if (this._source.running) {
            const size =  Math.max(this._width / 20, this._borderWidth);
            const spacing = size; // separation between the dots
            const lineLength = this._width - (size * (this._number - 1)) - (spacing * (this._number - 1));
            let padding = this._borderWidth;
            // For the backlit case here we don't want the outer border visible
            if (Docking.DockManager.settings.unityBacklitItems &&
                !Docking.DockManager.settings.customThemeCustomizeRunningDots)
                padding = 0;
            const yOffset = this._height - padding - size;

            cr.setLineWidth(this._borderWidth);
            Utils.cairoSetSourceColor(cr, this._borderColor);

            cr.translate(0, yOffset);
            cr.newSubPath();
            cr.rectangle(0, 0, lineLength, size);
            for (let i = 1; i < this._number; i++) {
                cr.newSubPath();
                cr.rectangle(lineLength + (i * spacing) + ((i - 1) * size), 0, size, size);
            }

            cr.strokePreserve();
            Utils.cairoSetSourceColor(cr, this._bodyColor);
            cr.fill();
        }
    }
}

// Adapted from dash-to-panel by Jason DeRose
// https://github.com/jderose9/dash-to-panel
class RunningIndicatorSegmented extends RunningIndicatorDots {
    _drawIndicator(cr) {
        if (this._source.running) {
            const size =  Math.max(this._width / 20, this._borderWidth);
            const spacing = Math.ceil(this._width / 18); // separation between the dots
            const dashLength = Math.ceil((this._width - ((this._number - 1) * spacing)) / this._number);
            let padding = this._borderWidth;
            // For the backlit case here we don't want the outer border visible
            if (Docking.DockManager.settings.unityBacklitItems &&
                !Docking.DockManager.settings.customThemeCustomizeRunningDots)
                padding = 0;
            const yOffset = this._height - padding - size;

            cr.setLineWidth(this._borderWidth);
            Utils.cairoSetSourceColor(cr, this._borderColor);

            cr.translate(0, yOffset);
            for (let i = 0; i < this._number; i++) {
                cr.newSubPath();
                cr.rectangle(i * dashLength + i * spacing, 0, dashLength, size);
            }

            cr.strokePreserve();
            Utils.cairoSetSourceColor(cr, this._bodyColor);
            cr.fill();
        }
    }
}

// Adapted from dash-to-panel by Jason DeRose
// https://github.com/jderose9/dash-to-panel
class RunningIndicatorSolid extends RunningIndicatorDots {
    _drawIndicator(cr) {
        if (this._source.running) {
            const size =  Math.max(this._width / 20, this._borderWidth);
            let padding = this._borderWidth;
            // For the backlit case here we don't want the outer border visible
            if (Docking.DockManager.settings.unityBacklitItems &&
                !Docking.DockManager.settings.customThemeCustomizeRunningDots)
                padding = 0;
            const yOffset = this._height - padding - size;

            cr.setLineWidth(this._borderWidth);
            Utils.cairoSetSourceColor(cr, this._borderColor);

            cr.translate(0, yOffset);
            cr.newSubPath();
            cr.rectangle(0, 0, this._width, size);

            cr.strokePreserve();
            Utils.cairoSetSourceColor(cr, this._bodyColor);
            cr.fill();
        }
    }
}

// Adapted from dash-to-panel by Jason DeRose
// https://github.com/jderose9/dash-to-panel
class RunningIndicatorSquares extends RunningIndicatorDots {
    _drawIndicator(cr) {
        if (this._source.running) {
            const size =  Math.max(this._width / 11, this._borderWidth);
            const padding = this._borderWidth;
            const spacing = Math.ceil(this._width / 18); // separation between the dots
            const yOffset = this._height - padding - size;

            cr.setLineWidth(this._borderWidth);
            Utils.cairoSetSourceColor(cr, this._borderColor);

            cr.translate(
                Math.floor((this._width - this._number * size - (this._number - 1) * spacing) / 2),
                yOffset);

            for (let i = 0; i < this._number; i++) {
                cr.newSubPath();
                cr.rectangle(i * size + i * spacing, 0, size, size);
            }
            cr.strokePreserve();
            Utils.cairoSetSourceColor(cr, this._bodyColor);
            cr.fill();
        }
    }
}

// Adapted from dash-to-panel by Jason DeRose
// https://github.com/jderose9/dash-to-panel
class RunningIndicatorDashes extends RunningIndicatorDots {
    _drawIndicator(cr) {
        if (this._source.running) {
            const size =  Math.max(this._width / 20, this._borderWidth);
            const padding = this._borderWidth;
            const spacing = Math.ceil(this._width / 18); // separation between the dots
            const dashLength = Math.floor(this._width / 4) - spacing;
            const yOffset = this._height - padding - size;

            cr.setLineWidth(this._borderWidth);
            Utils.cairoSetSourceColor(cr, this._borderColor);

            cr.translate(
                Math.floor((this._width - this._number * dashLength - (this._number - 1) * spacing) / 2),
                yOffset);

            for (let i = 0; i < this._number; i++) {
                cr.newSubPath();
                cr.rectangle(i * dashLength + i * spacing, 0, dashLength, size);
            }

            cr.strokePreserve();
            Utils.cairoSetSourceColor(cr, this._bodyColor);
            cr.fill();
        }
    }
}

// Adapted from dash-to-panel by Jason DeRose
// https://github.com/jderose9/dash-to-panel
class RunningIndicatorMetro extends RunningIndicatorDots {
    constructor(source) {
        super(source);
        this._source.add_style_class_name('metro');
    }

    destroy() {
        this._source.remove_style_class_name('metro');
        super.destroy();
    }

    _drawIndicator(cr) {
        if (this._source.running) {
            const size =  Math.max(this._width / 20, this._borderWidth);
            let padding = 0;
            // For the backlit case here we don't want the outer border visible
            if (Docking.DockManager.settings.unityBacklitItems &&
                !Docking.DockManager.settings.customThemeCustomizeRunningDots)
                padding = 0;
            const yOffset = this._height - padding - size;

            const n = this._number;
            if (n <= 1) {
                cr.translate(0, yOffset);
                Utils.cairoSetSourceColor(cr, this._bodyColor);
                cr.newSubPath();
                cr.rectangle(0, 0, this._width, size);
                cr.fill();
            } else {
                // need to scale with the SVG for the stacked highlight
                const blackenedLength = (1 / 48) * this._width;
                const darkenedLength = this._source.focused
                    ? (2 / 48) * this._width : (10 / 48) * this._width;
                const blackenedColor = this._bodyColor.shade(.3);
                const darkenedColor = this._bodyColor.shade(.7);

                cr.translate(0, yOffset);

                Utils.cairoSetSourceColor(cr, this._bodyColor);
                cr.newSubPath();
                cr.rectangle(0, 0, this._width - darkenedLength - blackenedLength, size);
                cr.fill();
                Utils.cairoSetSourceColor(cr, blackenedColor);
                cr.newSubPath();
                cr.rectangle(this._width - darkenedLength - blackenedLength, 0, 1, size);
                cr.fill();
                Utils.cairoSetSourceColor(cr, darkenedColor);
                cr.newSubPath();
                cr.rectangle(this._width - darkenedLength, 0, darkenedLength, size);
                cr.fill();
            }
        }
    }
}

class RunningIndicatorBinary extends RunningIndicatorDots {
    _drawIndicator(cr) {
        // Draw the required numbers of dots
        const n = Math.min(15, this._source.windowsCount);

        if (this._source.running) {
            const size =  Math.max(this._width / 11, this._borderWidth);
            const spacing = Math.ceil(this._width / 18);
            const yOffset = this._height - size;
            const binaryValue = String(`0000${(n >>> 0).toString(2)}`).slice(-4);

            cr.setLineWidth(this._borderWidth);
            Utils.cairoSetSourceColor(cr, this._borderColor);

            cr.translate(Math.floor((this._width - 4 * size - (4 - 1) * spacing) / 2), yOffset);
            for (let i = 0; i < binaryValue.length; i++) {
                if (binaryValue[i] === '1') {
                    cr.newSubPath();
                    cr.arc((2 * i + 1) * this._radius + i * spacing,
                        -this._radius - this._borderWidth / 2,
                        this._radius, 0, 2 * Math.PI);
                } else {
                    cr.newSubPath();
                    cr.rectangle(i * size + i * spacing,
                        -this._radius - this._borderWidth / 2 - size / 5,
                        size, size / 3);
                }
            }
            cr.strokePreserve();
            Utils.cairoSetSourceColor(cr, this._bodyColor);
            cr.fill();
        }
    }
}

class RunningIndicatorDot extends RunningIndicatorDots {
    _computeStyle() {
        super._computeStyle();

        this._radius = Math.max(this._width / 26, this._borderWidth / 2);
    }

    _drawIndicator(cr) {
        if (!this._source.running)
            return;

        cr.setLineWidth(this._borderWidth);
        Utils.cairoSetSourceColor(cr, this._borderColor);

        // draw from the bottom case:
        cr.translate(
            (this._width - 2 * this._radius) / 2,
            this._height - this._padding);
        cr.newSubPath();
        cr.arc(this._radius,
            -this._radius - this._borderWidth / 2,
            this._radius, 0, 2 * Math.PI);

        cr.strokePreserve();
        Utils.cairoSetSourceColor(cr, this._bodyColor);
        cr.fill();
    }
}

/*
 * Unity like notification and progress indicators
 */
export class UnityIndicator extends IndicatorBase {
    static defaultProgressBar = {
        // default values for the progress bar itself
        background: {
            colorStart: {red: 204, green: 204, blue: 204, alpha: 255},
            colorEnd: null,
        },
        border: {
            colorStart: {red: 230, green: 230, blue: 230, alpha: 255},
            colorEnd: null,
        },
    };

    static defaultProgressBarTrack = {
        // default values for the progress bar track
        background: {
            colorStart: {red: 64, green: 64, blue: 64, alpha: 255},
            colorEnd: {red: 89, green: 89, blue: 89, alpha: 255},
            offsetStart: 0.4,
            offsetEnd: 0.9,
        },
        border: {
            colorStart: {red: 128, green: 128, blue: 128, alpha: 26},
            colorEnd: {red: 204, green: 204, blue: 204, alpha: 102},
            offsetStart: 0.5,
            offsetEnd: 0.9,
        },
    };

    static notificationBadgeSignals = Symbol('notification-badge-signals');

    constructor(source) {
        super(source);

        const {remoteModel, notificationsMonitor} = Docking.DockManager.getDefault();
        const remoteEntry = remoteModel.lookupById(this._source.app.id);
        this._remoteEntry = remoteEntry;

        this._signalsHandler.add([
            remoteEntry,
            ['count-changed', 'count-visible-changed'],
            () => this._updateNotificationsCount(),
        ], [
            remoteEntry,
            ['progress-changed', 'progress-visible-changed'],
            (sender, {progress, progress_visible: progressVisible}) =>
                this.setProgress(progressVisible ? progress : -1),
        ], [
            remoteEntry,
            'urgent-changed',
            (sender, {urgent}) => this.setUrgent(urgent),
        ], [
            remoteEntry,
            'updating-changed',
            (sender, {updating}) => this.setUpdating(updating),
        ], [
            notificationsMonitor,
            'changed',
            () => this._updateNotificationsCount(),
        ], [
            this._source,
            'style-changed',
            () => this._updateIconStyle(),
        ]);

        this._updateNotificationsCount();
        this.setProgress(this._remoteEntry.progress_visible
            ? this._remoteEntry.progress : -1);
        this.setUrgent(this._remoteEntry.urgent);
        this.setUpdating(this._remoteEntry.updating);
    }

    destroy() {
        this._notificationBadgeBin?.destroy();
        this._notificationBadgeBin = null;
        this._updateNotificationAccessibility(0);
        this._hideProgressOverlay();
        this.setUrgent(false);
        this.setUpdating(false);
        this._remoteEntry = null;

        super.destroy();
    }

    _updateNotificationBadgeStyle() {
        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        const fontDesc = themeContext.get_font();
        const defaultFontSize = fontDesc.get_size() / 1024;
        let fontSize = defaultFontSize * 0.9;
        const {iconSize} = Main.overview.dash;
        const defaultIconSize = Docking.DockManager.settings.get_default_value(
            'dash-max-icon-size').unpack();

        if (!fontDesc.get_size_is_absolute()) {
            // fontSize was expressed in points, so convert to pixel
            fontSize /= 0.75;
        }

        let sizeMultiplier;
        if (iconSize < defaultIconSize) {
            sizeMultiplier = Math.max(24, Math.min(iconSize +
                iconSize * 0.3, defaultIconSize)) / defaultIconSize;
        } else {
            sizeMultiplier = iconSize / defaultIconSize;
        }

        fontSize = Math.round(sizeMultiplier * fontSize);
        const leftMargin = Math.round(sizeMultiplier * 3);

        this._notificationBadgeBin.child.set_style(
            `font-size: ${fontSize}px;` +
            `margin-left: ${leftMargin}px`
        );
    }

    _notificationBadgeCountToText(count) {
        if (count <= 9999) {
            return count.toString();
        } else if (count < 1e5) {
            const thousands = count / 1e3;
            return `${thousands.toFixed(1).toString()}k`;
        } else if (count < 1e6) {
            const thousands = count / 1e3;
            return `${thousands.toFixed(0).toString()}k`;
        } else if (count < 1e8) {
            const millions = count / 1e6;
            return `${millions.toFixed(1).toString()}M`;
        } else if (count < 1e9) {
            const millions = count / 1e6;
            return `${millions.toFixed(0).toString()}M`;
        } else {
            const billions = count / 1e9;
            return `${billions.toFixed(1).toString()}B`;
        }
    }

    _updateNotificationsCount() {
        const remoteCount = this._remoteEntry['count-visible']
            ? this._remoteEntry.count ?? 0 : 0;

        if (remoteCount > 0 &&
            Docking.DockManager.settings.applicationCounterOverridesNotifications) {
            this.setNotificationCount(remoteCount);
            return;
        }

        const {notificationsMonitor} = Docking.DockManager.getDefault();
        const notificationsCount = notificationsMonitor.getAppNotificationsCount(
            this._source.app.id);

        this.setNotificationCount(remoteCount + notificationsCount);
    }

    _updateNotificationsBadge(text) {
        if (this._notificationBadgeBin) {
            this._notificationBadgeBin.child.text = text;
            return;
        }

        this._notificationBadgeBin = new St.Bin({
            child: new St.Label({
                styleClass: 'notification-badge',
                text,
            }),
            xAlign: Clutter.ActorAlign.END,
            yAlign: Clutter.ActorAlign.START,
            xExpand: true,
            yExpand: true,
        });
        this._notificationBadgeBin.child.clutterText.ellipsize =
            Pango.EllipsizeMode.MIDDLE;

        this._source._iconContainer.add_child(this._notificationBadgeBin);
        this._updateNotificationBadgeStyle();

        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        this._signalsHandler.addWithLabel(UnityIndicator.notificationBadgeSignals, [
            themeContext,
            'changed',
            () => this._updateNotificationBadgeStyle(),
        ], [
            themeContext,
            'notify::scale-factor',
            () => this._updateNotificationBadgeStyle(),
        ], [
            this._source._iconContainer,
            'notify::size',
            () => this._updateNotificationBadgeStyle(),
        ]);
    }

    _updateNotificationAccessibility(count) {
        const appName = this._source.app?.get_name();
        if (!appName)
            return;

        const accessibleName = count > 0
            // TRANSLATORS: This is the accessible name for an app icon with unread
            // notifications.
            // %s is the name of the app and %d the number of unread notifications.
            ? N__('%s, %d unread notification', '%s, %d unread notifications', count)
                .format(appName, count)
            : appName;

        if (this._source.labelActor === null) {
            // Dock: name owned by parent DashItemContainer, see dash.js
            const itemContainer = this._source.get_parent?.();
            itemContainer?.set({accessibleName});
            this._source.set({accessibleName});
        } else {
            // Overview: no per-icon parent, update icon and label directly
            this._source.set({accessibleName});
            this._source.labelActor?.set({accessibleName});
        }
    }

    setNotificationCount(count) {
        if (count > 0) {
            const text = this._notificationBadgeCountToText(count);
            this._updateNotificationsBadge(text);
        } else if (this._notificationBadgeBin) {
            this._signalsHandler.removeWithLabel(UnityIndicator.notificationBadgeSignals);
            this._notificationBadgeBin.destroy();
            this._notificationBadgeBin = null;
        }

        this._updateNotificationAccessibility(count);
    }

    _showProgressOverlay() {
        if (this._progressOverlayArea) {
            this._updateProgressOverlay();
            return;
        }

        this._progressOverlayArea = new St.DrawingArea({x_expand: true, y_expand: true});
        this._progressOverlayArea.add_style_class_name('progress-bar');
        this._progressOverlayArea.connect('repaint', () => {
            this._drawProgressOverlay(this._progressOverlayArea);
        });

        this._source._iconContainer.add_child(this._progressOverlayArea);
        this._updateProgressOverlay();
    }

    _hideProgressOverlay() {
        this._progressOverlayArea?.destroy();
        this._progressOverlayArea = null;
    }

    _updateProgressOverlay() {
        this._progressOverlayArea?.queue_repaint();
    }

    _readGradientData(node, elementName, defaultValues) {
        const output = {
            colorStart: defaultValues.colorStart,
            colorEnd: defaultValues.colorEnd,
            offsetStart: defaultValues.offsetStart ?? 0.0,
            offsetEnd: defaultValues.offsetEnd ?? 1.0,
        };

        const [hasElementName, elementNameValue] = node.lookup_color(elementName, false);
        if (hasElementName) {
            output.colorStart = elementNameValue;
            output.colorEnd = null;
        } else {
            const [hasColorStart, colorStartValue] = node.lookup_color(`${elementName}-color-start`, false);
            const [hasColorEnd, colorEndValue] = node.lookup_color(`${elementName}-color-end`, false);
            if (hasColorStart && hasColorEnd) {
                output.colorStart = colorStartValue;
                output.colorEnd = colorEndValue;
            }
        }

        const [hasOffsetStart, offsetStartValue] = node.lookup_color(`${elementName}-offset-start`, false);
        if (hasOffsetStart)
            output.offsetStart = offsetStartValue;

        const [hasOffsetEnd, offsetEndValue] = node.lookup_color(`${elementName}-offset-end`, false);
        if (hasOffsetEnd)
            output.offsetEnd = offsetEndValue;

        return output;
    }

    _readThemeDoubleValue(node, elementName, defaultValue) {
        const [hasValue, value] = node.lookup_double(elementName, false);
        return hasValue ? value : defaultValue;
    }

    _readElementData(node, elementName, defaultValues) {
        return {
            background: this._readGradientData(node, `${elementName}-background`, defaultValues.background),
            border: this._readGradientData(node, `${elementName}-border`, defaultValues.border),
            lineWidth: this._readThemeDoubleValue(node, `${elementName}-line-width`,
                defaultValues.lineWidth ?? 1.0),
        };
    }

    _createGradient(values, x0, y0, x1, y1) {
        if (values.colorEnd) {
            const gradient = new Cairo.LinearGradient(x0, y0, x1, y1);
            gradient.addColorStopRGBA(values.offsetStart,
                values.colorStart.red / 255,
                values.colorStart.green / 255,
                values.colorStart.blue / 255,
                values.colorStart.alpha / 255);
            gradient.addColorStopRGBA(values.offsetEnd,
                values.colorEnd.red / 255,
                values.colorEnd.green / 255,
                values.colorEnd.blue / 255,
                values.colorEnd.alpha / 255);
            return gradient;
        } else {
            const gradient = Cairo.SolidPattern.createRGBA(values.colorStart.red / 255,
                values.colorStart.green / 255,
                values.colorStart.blue / 255,
                values.colorStart.alpha / 255);
            return gradient;
        }
    }

    _drawProgressOverlay(area) {
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const [surfaceWidth, surfaceHeight] = area.get_surface_size();
        const cr = area.get_context();
        const node = this._progressOverlayArea.get_theme_node();
        const iconSize = this._source.icon.iconSize * scaleFactor;

        let x = Math.floor((surfaceWidth - iconSize) / 2);
        let y = Math.floor((surfaceHeight - iconSize) / 2);

        const readThemeValue = element =>
            this._readThemeDoubleValue(node, `-progress-bar-${element}`);

        y = readThemeValue('top-offset') ?? y;

        const baseLineWidth = Math.floor(Number(scaleFactor));
        const horizontalPadding = iconSize *
            Utils.clampDouble(readThemeValue('horizontal-padding') ?? 0.05);
        const verticalPadding = iconSize *
            Utils.clampDouble(readThemeValue('vertical-padding') ?? 0.05);
        const heightFactor =
            Utils.clampDouble(readThemeValue('height-factor') ?? 0.20);

        let width = iconSize - 2.0 * horizontalPadding;
        let height = Math.floor(Math.min(18.0 * scaleFactor, heightFactor * iconSize));
        x += horizontalPadding;

        const valign = Utils.clampDouble(readThemeValue('valign') ?? 1);
        y += (iconSize - height - verticalPadding) * valign;

        const progressBarTrack = this._readElementData(node,
            '-progress-bar-track',
            UnityIndicator.defaultProgressBarTrack);

        const progressBar = this._readElementData(node,
            '-progress-bar',
            UnityIndicator.defaultProgressBar);

        // Draw the track
        let lineWidth = baseLineWidth * progressBarTrack.lineWidth;
        cr.setLineWidth(lineWidth);

        x += lineWidth;
        y += lineWidth;
        width -= 2.0 * lineWidth;
        height -= 2.0 * lineWidth;

        let fill = this._createGradient(progressBarTrack.background, 0, y, 0, y + height);
        let stroke = this._createGradient(progressBarTrack.border, 0, y, 0, y + height);
        Utils.drawRoundedLine(cr, x + lineWidth / 2.0,
            y + lineWidth / 2.0, width, height, true, true, stroke, fill);

        // Draw the finished bar
        lineWidth = baseLineWidth * progressBar.lineWidth;
        cr.setLineWidth(lineWidth);

        x += lineWidth;
        y += lineWidth;
        width -= 2.0 * lineWidth;
        height -= 2.0 * lineWidth;

        const finishedWidth = Math.ceil(this._progress * width);
        fill = this._createGradient(progressBar.background, 0, y, 0, y + height);
        stroke = this._createGradient(progressBar.border, 0, y, 0, y + height);

        if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL) {
            Utils.drawRoundedLine(cr,
                x + lineWidth / 2.0 + width - finishedWidth, y + lineWidth / 2.0,
                finishedWidth, height, true, true, stroke, fill);
        } else {
            Utils.drawRoundedLine(cr, x + lineWidth / 2.0, y + lineWidth / 2.0,
                finishedWidth, height, true, true, stroke, fill);
        }

        cr.$dispose();
    }

    setProgress(progress) {
        if (progress < 0) {
            this._hideProgressOverlay();
        } else {
            this._progress = Math.min(progress, 1.0);
            this._showProgressOverlay();
        }
    }

    setUrgent(urgent) {
        if (urgent || this._isUrgent !== undefined)
            this._source.urgent = urgent;

        if (urgent)
            this._isUrgent = urgent;
        else
            delete this._isUrgent;
    }

    setUpdating(updating) {
        this._source.updating = updating;
    }

    _updateIconStyle() {
        const opacity = this._readThemeDoubleValue(this._source.get_theme_node(),
            'opacity') ?? (this._source.updating ? 0.5 : 1);
        this._source.icon.set_opacity(255 * opacity);
    }
}

// Global icon cache. Used for Unity7 styling.
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

// ---------- App icons decorator ----------

export class AppIconsDecorator {
    constructor() {
        this._signals = new Utils.GlobalSignalsHandler();
        this._methodInjections = new Utils.InjectionsHandler();
        this._propertyInjections = new Utils.PropertyInjectionsHandler(
            null, {allowNewProperty: true});
        this._indicators = new Set();
        this._resultIndicators = new Set();
        this._updatingIcons = new WeakSet();

        this._patchAppIcons();
        this._decorateIcons();
    }

    destroy() {
        this._signals?.destroy();
        delete this._signals;
        this._methodInjections?.destroy();
        delete this._methodInjections;
        this._propertyInjections?.destroy();
        delete this._propertyInjections;
        this._clearIndicators(Labels.ICONS);
        this._clearIndicators(Labels.RESULTS);
        delete this._indicators;
        delete this._resultIndicators;
        delete this._updatingIcons;
    }

    _indicatorsSet(label) {
        return {
            [Labels.ICONS]: this._indicators,
            [Labels.RESULTS]: this._resultIndicators,
        }[label];
    }

    _clearIndicators(label) {
        const indicatorsSet = this._indicatorsSet(label);
        indicatorsSet.forEach(i => i.destroy());
        indicatorsSet.clear();
    }

    _decorateIcon(parentIcon, signalLabel) {
        const indicator = new UnityIndicator(parentIcon);
        const indicatorsSet = this._indicatorsSet(signalLabel);
        indicatorsSet.add(indicator);
        this._signals.addWithLabel(signalLabel, parentIcon, 'destroy', () => {
            indicatorsSet.delete(indicator);
            indicator.destroy();
        });
    }

    _decorateIcons() {
        const {appDisplay} = Docking.DockManager.getDefault().overviewControls;

        const decorateAppIcons = () => {
            this._signals.removeWithLabel(Labels.ICONS);
            this._clearIndicators(Labels.ICONS);

            const decorateViewIcons = view => {
                const items = view.getAllItems();
                items.forEach(i => {
                    if (i instanceof AppDisplay.AppIcon) {
                        this._decorateIcon(i, Labels.ICONS);
                    } else if (i instanceof AppDisplay.FolderIcon) {
                        decorateViewIcons(i.view);
                        this._signals.addWithLabel(Labels.ICONS, i.view,
                            'view-loaded', () => decorateAppIcons());
                    }
                });
            };
            decorateViewIcons(appDisplay);
        };

        this._signals.add(appDisplay, 'view-loaded', () => decorateAppIcons());
        decorateAppIcons();
    }

    _patchAppIcons() {
        const self = this;

        this._methodInjections.add(AppDisplay.AppSearchProvider.prototype,
            'createResultObject', function (originalFunction, ...args) {
                /* eslint-disable no-invalid-this */
                const result = originalFunction.call(this, ...args);
                if (result instanceof AppDisplay.AppIcon)
                    self._decorateIcon(result, Labels.RESULTS);
                return result;
                /* eslint-enable no-invalid-this */
            });

        this._methodInjections.add(AppDisplay.AppIcon.prototype,
            'activate', function (originalFunction, ...args) {
                /* eslint-disable no-invalid-this */
                if (this.updating) {
                    const {notifyAppIconUpdating} = DockAbstractAppIcon.prototype;
                    notifyAppIconUpdating.call(this,
                        Main.layoutManager.primaryMonitor.index);
                    return;
                }

                originalFunction.call(this, ...args);
                /* eslint-enable no-invalid-this */
            });

        const appIconsTypes = [
            AppDisplay.AppSearchProvider,
            AppDisplay.AppIcon,
        ];
        appIconsTypes.forEach(type =>
            this._propertyInjections.add(type.prototype, 'updating', {
                get() {
                    return self._updatingIcons.has(this);
                },
                set(updating) {
                    if (this.updating === updating)
                        return;

                    if (updating) {
                        self._updatingIcons.add(this);
                        this.add_style_class_name('updating');
                    } else {
                        self._updatingIcons.delete(this);
                        this.remove_style_class_name('updating');
                    }
                },
            }));

        this._methodInjections.add(AppMenu.AppMenu.prototype,
            'open', function (originalFunction, ...args) {
                /* eslint-disable no-invalid-this */
                if (!this.sourceActor.updating) {
                    originalFunction.call(this, ...args);
                    return;
                }

                if (this.isOpen)
                    return;

                if (this.isEmpty())
                    return;

                // Temporarily hide all the menu items a part the Pinning and
                // the details one while we're updating.
                const validItems = [
                    this._toggleFavoriteItem,
                    this._detailsItem,
                ];
                const items = this._getMenuItems().filter(
                    i => !validItems.includes(i)).map(i =>
                    i instanceof PopupMenu.PopupMenuBase ? i.actor : i);
                const itemsVisibility = items.map(i => i.visible);
                items.forEach(i => (i.visible = false));
                const menuClosedId = this.connect('menu-closed', () => {
                    this.disconnect(menuClosedId);
                    items.forEach((i, idx) => (i.visible = itemsVisibility[idx]));
                });
                originalFunction.call(this, ...args);
                /* eslint-enable no-invalid-this */
            });
    }
}

// ---------- Window previews ----------

/*
 * Credits:
 * This file is based on code from the Dash to Panel extension by Jason DeRose
 * and code from the Taskbar extension by Zorin OS
 * Some code was also adapted from the upstream Gnome Shell source code.
 */

const PREVIEW_MAX_WIDTH = 250;
const PREVIEW_MAX_HEIGHT = 150;

const PREVIEW_ANIMATION_DURATION = 250;
const MAX_PREVIEW_GENERATION_ATTEMPTS = 15;

export const WindowPreviewMenuItem = GObject.registerClass(
class WindowPreviewMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(window, position, params) {
        super._init(params);

        this._window = window;
        this._destroyId = 0;
        this._windowAddedId = 0;

        // We don't want this: it adds spacing on the left of the item.
        this.remove_child(this._ornamentIcon);
        this.add_style_class_name('dashtodock-app-well-preview-menu-item');
        this.add_style_class_name(Docking.PositionStyleClass[position]);

        // Now we don't have to set PREVIEW_MAX_WIDTH and PREVIEW_MAX_HEIGHT as
        // preview size - that made all kinds of windows either stretched or
        // squished (aspect ratio problem)
        this._cloneBin = new St.Bin();

        this._updateWindowPreviewSize();

        // TODO: improve the way the closebutton is layout. Just use some padding
        // for the moment.
        this._cloneBin.set_style('padding-bottom: 0.5em');

        const buttonLayout = Meta.prefs_get_button_layout();
        this.closeButton = new St.Button({
            style_class: 'window-close',
            opacity: 0,
            x_expand: true,
            y_expand: true,
            x_align: buttonLayout.left_buttons.includes(Meta.ButtonFunction.CLOSE)
                ? Clutter.ActorAlign.START : Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        Utils.addActor(this.closeButton, new St.Icon({icon_name: 'window-close-symbolic'}));
        this.closeButton.connect('clicked', () => this._closeWindow());

        const overlayGroup = new Clutter.Actor({
            layout_manager: new Clutter.BinLayout(),
            y_expand: true,
        });

        overlayGroup.add_child(this._cloneBin);
        overlayGroup.add_child(this.closeButton);

        const label = new St.Label({text: window.get_title()});
        label.set_style(`max-width: ${PREVIEW_MAX_WIDTH}px`);
        const labelBin = new St.Bin({
            child: label,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._windowTitleId = this._window.connect('notify::title', () => {
            label.set_text(this._window.get_title());
        });

        const box = new St.BoxLayout({
            reactive: true,
            x_expand: true,
        });

        if (box.orientation !== undefined)
            box.orientation = Clutter.Orientation.VERTICAL;
        else
            box.vertical = true;

        if (box.add) {
            box.add(overlayGroup);
            box.add(labelBin);
        } else {
            box.add_child(overlayGroup);
            box.add_child(labelBin);
        }
        this._box = box;
        this.add_child(box);

        this._cloneTexture(window);

        this.connect('destroy', this._onDestroy.bind(this));
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();

        // For some crazy clutter / St reason we can't just have this handled
        // automatically or here via vfunc_allocate + vfunc_get_preferred_*
        // because if we do so, the St paddings on first / last child are lost
        const themeNode = this.get_theme_node();
        let [minWidth, naturalWidth] = this._box.get_preferred_width(-1);
        let [minHeight, naturalHeight] = this._box.get_preferred_height(naturalWidth);
        [minWidth, naturalWidth] = themeNode.adjust_preferred_width(minWidth, naturalWidth);
        [minHeight, naturalHeight] = themeNode.adjust_preferred_height(minHeight, naturalHeight);
        this.set({minWidth, naturalWidth, minHeight, naturalHeight});
    }

    _getWindowPreviewSize() {
        const emptySize = [0, 0, 0];

        const mutterWindow = this._window.get_compositor_private();
        if (!mutterWindow?.get_texture())
            return emptySize;

        const [width, height] = mutterWindow.get_size();
        if (!width || !height)
            return emptySize;

        let {previewSizeScale: scale} = Docking.DockManager.settings;
        if (!scale) {
            // a simple example with 1680x1050:
            // * 250/1680 = 0,1488
            // * 150/1050 = 0,1429
            // => scale is 0,1429
            scale = Math.min(1.0, PREVIEW_MAX_WIDTH / width, PREVIEW_MAX_HEIGHT / height);
        }

        scale *= St.ThemeContext.get_for_stage(global.stage).scaleFactor;

        // width and height that we wanna multiply by scale
        return [width, height, scale];
    }

    _updateWindowPreviewSize() {
        // This gets the actual windows size for the preview
        [this._width, this._height, this._scale] = this._getWindowPreviewSize();
        this._cloneBin.set_size(this._width * this._scale, this._height * this._scale);
    }

    _cloneTexture(metaWin) {
        // Newly-created windows are added to a workspace before
        // the compositor finds out about them...
        if (!this._width || !this._height) {
            this._cloneTextureLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
                // Check if there's still a point in getting the texture,
                // otherwise this could go on indefinitely
                this._updateWindowPreviewSize();

                if (this._width && this._height) {
                    this._cloneTexture(metaWin);
                } else {
                    this._cloneAttempt = (this._cloneAttempt || 0) + 1;
                    if (this._cloneAttempt < MAX_PREVIEW_GENERATION_ATTEMPTS)
                        return GLib.SOURCE_CONTINUE;
                }
                delete this._cloneTextureLater;
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        const mutterWindow = metaWin.get_compositor_private();
        const clone = new Clutter.Clone({
            source: mutterWindow,
            reactive: true,
            width: this._width * this._scale,
            height: this._height * this._scale,
        });

        // when the source actor is destroyed, i.e. the window closed, first destroy the clone
        // and then destroy the menu item (do this animating out)
        this._destroyId = mutterWindow.connect('destroy', () => {
            clone.destroy();
            this._destroyId = 0; // avoid to try to disconnect this signal from mutterWindow in _onDestroy(),
            // as the object was just destroyed
            this._animateOutAndDestroy();
        });

        this._clone = clone;
        this._mutterWindow = mutterWindow;
        this._cloneBin.set_child(this._clone);

        this._clone.connect('destroy', () => {
            if (this._destroyId) {
                mutterWindow.disconnect(this._destroyId);
                this._destroyId = 0;
            }
            this._clone = null;
        });
    }

    _windowCanClose() {
        return this._window.can_close() &&
               !this._hasAttachedDialogs();
    }

    _closeWindow() {
        this._workspace = this._window.get_workspace();

        // This mechanism is copied from the workspace.js upstream code
        // It forces window activation if the windows don't get closed,
        // for instance because asking user confirmation, by monitoring the opening of
        // such additional confirmation window
        this._windowAddedId = this._workspace.connect('window-added',
            this._onWindowAdded.bind(this));

        this.deleteAllWindows();
    }

    deleteAllWindows() {
        // Delete all windows, starting from the bottom-most (most-modal) one
        // let windows = this._window.get_compositor_private().get_children();
        const windows = this._clone.get_children();
        for (let i = windows.length - 1; i >= 1; i--) {
            const realWindow = windows[i].source;
            const metaWindow = realWindow.meta_window;

            metaWindow.delete(global.get_current_time());
        }

        this._window.delete(global.get_current_time());
    }

    _onWindowAdded(workspace, win) {
        const metaWindow = this._window;

        if (win.get_transient_for() === metaWindow) {
            workspace.disconnect(this._windowAddedId);
            this._windowAddedId = 0;

            // use an idle handler to avoid mapping problems -
            // see comment in Workspace._windowAdded
            const activationEvent = Clutter.get_current_event();
            this._windowAddedLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
                delete this._windowAddedLater;
                this.emit('activate', activationEvent);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _hasAttachedDialogs() {
        // count transient windows
        let n = 0;
        this._window.foreach_transient(() => {
            n++;
        });
        return n > 0;
    }

    vfunc_key_focus_in() {
        super.vfunc_key_focus_in();
        this._showCloseButton();
    }

    vfunc_key_focus_out() {
        super.vfunc_key_focus_out();
        this._hideCloseButton();
    }

    vfunc_enter_event(crossingEvent) {
        this._showCloseButton();
        return super.vfunc_enter_event(crossingEvent);
    }

    vfunc_leave_event(crossingEvent) {
        this._hideCloseButton();
        return super.vfunc_leave_event(crossingEvent);
    }

    _idleToggleCloseButton() {
        this._idleToggleCloseId = 0;

        this._hideCloseButton();

        return GLib.SOURCE_REMOVE;
    }

    _showCloseButton() {
        if (this._windowCanClose()) {
            this.closeButton.show();
            this.closeButton.remove_all_transitions();
            this.closeButton.ease({
                opacity: 255,
                duration: Workspace.WINDOW_OVERLAY_FADE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _hideCloseButton() {
        if (this.closeButton.has_pointer ||
            this.get_children().some(a => a.has_pointer))
            return;

        this.closeButton.remove_all_transitions();
        this.closeButton.ease({
            opacity: 0,
            duration: Workspace.WINDOW_OVERLAY_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    show(animate) {
        const fullWidth = this.get_width();

        this.opacity = 0;
        this.set_width(0);

        const time = animate ? PREVIEW_ANIMATION_DURATION : 0;
        this.remove_all_transitions();
        this.ease({
            opacity: 255,
            width: fullWidth,
            duration: time,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
        });
    }

    _animateOutAndDestroy() {
        this.remove_all_transitions();
        this.ease({
            opacity: 0,
            duration: PREVIEW_ANIMATION_DURATION,
        });

        this.ease({
            width: 0,
            height: 0,
            duration: PREVIEW_ANIMATION_DURATION,
            delay: PREVIEW_ANIMATION_DURATION,
            onComplete: () => this.destroy(),
        });
    }

    activate() {
        Main.activateWindow(this._window);
        this._getTopMenu().close();
    }

    _onDestroy() {
        if (this._cloneTextureLater) {
            Utils.laterRemove(this._cloneTextureLater);
            delete this._cloneTextureLater;
        }

        if (this._windowAddedLater) {
            Utils.laterRemove(this._windowAddedLater);
            delete this._windowAddedLater;
        }

        if (this._windowAddedId > 0) {
            this._workspace.disconnect(this._windowAddedId);
            this._windowAddedId = 0;
        }

        if (this._destroyId > 0) {
            this._mutterWindow.disconnect(this._destroyId);
            this._destroyId = 0;
        }

        if (this._windowTitleId > 0) {
            this._window.disconnect(this._windowTitleId);
            this._windowTitleId = 0;
        }
    }
});

// ---------- Notifications monitor ----------

export class NotificationsMonitor {
    constructor() {
        this._settings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.notifications',
        });

        this._appNotifications = Object.create(null);
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);

        const getIsEnabled = () => !this.dndMode &&
            Docking.DockManager.settings.showIconsNotificationsCounter;

        this._isEnabled = getIsEnabled();
        const checkIsEnabled = () => {
            const isEnabled = getIsEnabled();
            if (isEnabled !== this._isEnabled) {
                this._isEnabled = isEnabled;
                this.emit('state-changed');

                this._updateState();
            }
        };

        this._dndMode = !this._settings.get_boolean('show-banners');
        this._signalsHandler.add(this._settings, 'changed::show-banners', () => {
            this._dndMode = !this._settings.get_boolean('show-banners');
            checkIsEnabled();
        });
        this._signalsHandler.add(Docking.DockManager.settings,
            'changed::show-icons-notifications-counter', checkIsEnabled);

        this._updateState();
    }

    destroy() {
        this.emit('destroy');
        this._signalsHandler?.destroy();
        this._signalsHandler = null;
        this._appNotifications = null;
        this._settings = null;
    }

    get enabled() {
        return this._isEnabled;
    }

    get dndMode() {
        return this._dndMode;
    }

    getAppNotificationsCount(appId) {
        return this._appNotifications[appId] ?? 0;
    }

    _updateState() {
        if (this.enabled) {
            this._signalsHandler.addWithLabel(Labels.SOURCES, Main.messageTray,
                'source-added', () => this._checkNotifications());
            this._signalsHandler.addWithLabel(Labels.SOURCES, Main.messageTray,
                'source-removed', () => this._checkNotifications());
        } else {
            this._signalsHandler.removeWithLabel(Labels.SOURCES);
        }

        this._checkNotifications();
    }

    _checkNotifications() {
        this._appNotifications = Object.create(null);
        this._signalsHandler.removeWithLabel(Labels.NOTIFICATIONS);

        if (this.enabled) {
            Main.messageTray.getSources().forEach(source => {
                this._signalsHandler.addWithLabel(Labels.NOTIFICATIONS, source,
                    'notification-added', () => this._checkNotifications());

                source.notifications.forEach(notification => {
                    const app = notification.source?.app ?? notification.source?._app;
                    const appId = app?.id ?? app?._appId;

                    if (appId) {
                        if (notification.resident) {
                            if (notification.acknowledged)
                                return;

                            this._signalsHandler.addWithLabel(Labels.NOTIFICATIONS,
                                notification, 'notify::acknowledged',
                                () => this._checkNotifications());
                        }

                        this._signalsHandler.addWithLabel(Labels.NOTIFICATIONS,
                            notification, 'destroy', () => this._checkNotifications());

                        this._appNotifications[appId] =
                            (this._appNotifications[appId] ?? 0) + 1;
                    }
                });
            });
        }

        this.emit('changed');
    }
}

Signals.addSignalMethods(NotificationsMonitor.prototype);

// ---------- Launcher API ----------

export class LauncherEntryRemoteModel {
    constructor() {
        this._entrySourceStacks = new Map();
        this._remoteMaps = new Map();

        this._launcher_entry_dbus_signal_id =
            Gio.DBus.session.signal_subscribe(null, // sender
                'com.canonical.Unity.LauncherEntry', // iface
                'Update', // member
                null, // path
                null, // arg0
                Gio.DBusSignalFlags.NONE,
                (_connection, senderName, _objectPath, _interfaceName, _signalName, parameters) =>
                    this._onUpdate(senderName, ...parameters.deep_unpack()));

        this._dbus_name_owner_changed_signal_id =
            Gio.DBus.session.signal_subscribe('org.freedesktop.DBus',  // sender
                'org.freedesktop.DBus',  // interface
                'NameOwnerChanged',      // member
                '/org/freedesktop/DBus', // path
                null,                    // arg0
                Gio.DBusSignalFlags.NONE,
                (connection, _senderName, _objectPath, _interfaceName, _signalName, parameters) =>
                    this._onDBusNameChange(...parameters.deep_unpack().slice(1)));

        this._acquireUnityDBus();
    }

    destroy() {
        if (this._launcher_entry_dbus_signal_id)
            Gio.DBus.session.signal_unsubscribe(this._launcher_entry_dbus_signal_id);

        if (this._dbus_name_owner_changed_signal_id)
            Gio.DBus.session.signal_unsubscribe(this._dbus_name_owner_changed_signal_id);

        this._releaseUnityDBus();
    }

    _lookupStackById(appId) {
        let sourceStack = this._entrySourceStacks.get(appId);
        if (!sourceStack) {
            sourceStack = new PropertySourceStack(new LauncherEntry(),
                launcherEntryDefaults);
            this._entrySourceStacks.set(appId, sourceStack);
        }

        return sourceStack;
    }

    lookupById(appId) {
        return this._lookupStackById(appId).target;
    }

    _acquireUnityDBus() {
        if (!this._unity_bus_id) {
            this._unity_bus_id = Gio.DBus.session.own_name('com.canonical.Unity',
                Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
                null, () => (this._unity_bus_id = 0));
        }
    }

    _releaseUnityDBus() {
        if (this._unity_bus_id) {
            Gio.DBus.session.unown_name(this._unity_bus_id);
            this._unity_bus_id = 0;
        }
    }

    _onDBusNameChange(before, after) {
        if (!before || !this._remoteMaps.size)
            return;

        const remoteMap = this._remoteMaps.get(before);
        if (!remoteMap)
            return;

        this._remoteMaps.delete(before);
        if (after && !this._remoteMaps.has(after)) {
            this._remoteMaps.set(after, remoteMap);
        } else {
            for (const [appId, remote] of remoteMap) {
                const sourceStack = this._entrySourceStacks.get(appId);
                const changed = sourceStack.remove(remote);
                if (changed)
                    sourceStack.target._emitChangedEvents(changed);
            }
        }
    }

    _onUpdate(senderName, appUri, properties) {
        if (!senderName)
            return;

        const appId = appUri.replace(/(^\w+:|^)\/\//, '');
        if (!appId)
            return;

        let remoteMap = this._remoteMaps.get(senderName);
        if (!remoteMap)
            this._remoteMaps.set(senderName, remoteMap = new Map());

        let remote = remoteMap.get(appId);
        if (!remote)
            remoteMap.set(appId, remote = Object.assign({}, launcherEntryDefaults));

        for (const name in properties) {
            if (name === 'quicklist' && DBusMenu) {
                const quicklistPath = properties[name].unpack();
                if (quicklistPath &&
                    (!remote._quicklistMenuClient ||
                     remote._quicklistMenuClient.dbus_object !== quicklistPath)) {
                    remote.quicklist = null;
                    let menuClient = remote._quicklistMenuClient;
                    if (menuClient) {
                        menuClient.disconnect(menuClient._rootChangedHandlerId);
                        menuClient.dbus_object = quicklistPath;
                    } else {
                        // This property should not be enumerable
                        Object.defineProperty(remote, '_quicklistMenuClient', {
                            writable: true,
                            value: menuClient = new DBusMenu.Client({
                                dbus_name: senderName,
                                dbus_object: quicklistPath,
                            }),
                        });
                    }
                    const handler = () => {
                        const root = menuClient.get_root();
                        if (remote.quicklist !== root) {
                            remote.quicklist = root;
                            if (sourceStack.isTop(remote)) {
                                sourceStack.target.quicklist = root;
                                sourceStack.target._emitChangedEvents(['quicklist']);
                            }
                        }
                    };
                    menuClient._rootChangedHandlerId =
                        menuClient.connect(DBusMenu.CLIENT_SIGNAL_ROOT_CHANGED, handler);
                }
            } else {
                remote[name] = properties[name].unpack();
            }
        }

        const sourceStack = this._lookupStackById(appId);
        sourceStack.target._emitChangedEvents(sourceStack.update(remote));
    }
}

const launcherEntryDefaults = Object.freeze({
    count: 0,
    progress: 0,
    urgent: false,
    updating: false,
    quicklist: null,
    'count-visible': false,
    'progress-visible': false,
});

const LauncherEntry = class DashToDockLauncherEntry {
    constructor() {
        this._connections = new Map();
        this._handlers = new Map();
        this._nextId = 0;
    }

    connect(eventNames, callback) {
        if (typeof eventNames === 'string')
            eventNames = [eventNames];

        callback(this, this);
        const id = this._nextId++;
        const handler = {id, callback};
        eventNames.forEach(name => {
            let handlerList = this._handlers.get(name);
            if (!handlerList)
                this._handlers.set(name, handlerList = []);

            handlerList.push(handler);
        });
        this._connections.set(id, eventNames);
        return id;
    }

    disconnect(id) {
        const eventNames = this._connections.get(id);
        if (!eventNames)
            return;

        this._connections.delete(id);
        eventNames.forEach(name => {
            const handlerList = this._handlers.get(name);
            if (handlerList) {
                for (let i = 0, iMax = handlerList.length; i < iMax; i++) {
                    if (handlerList[i].id === id) {
                        handlerList.splice(i, 1);
                        break;
                    }
                }
            }
        });
    }

    _emitChangedEvents(propertyNames) {
        const handlers = new Set();
        propertyNames.forEach(name => {
            const handlerList = this._handlers.get(`${name}-changed`);
            if (handlerList) {
                for (let i = 0, iMax = handlerList.length; i < iMax; i++)
                    handlers.add(handlerList[i]);
            }
        });
        Array.from(handlers).sort((x, y) => x.id - y.id).forEach(handler => handler.callback(this, this));
    }
};

for (const [name, defaultValue] of Object.entries(launcherEntryDefaults)) {
    const jsName = name.replaceAll('-', '_');
    LauncherEntry.prototype[jsName] = defaultValue;
    if (jsName !== name) {
        Object.defineProperty(LauncherEntry.prototype, name, {
            get() {
                return this[jsName];
            },
            set(value) {
                this[jsName] = value;
            },
        });
    }
}

const PropertySourceStack = class DashToDockPropertySourceStack {
    constructor(target, bottom) {
        this.target = target;
        this._bottom = bottom;
        this._stack = [];
    }

    isTop(source) {
        return this._stack.length > 0 && this._stack[this._stack.length - 1] === source;
    }

    update(source) {
        if (!this.isTop(source)) {
            this.remove(source);
            this._stack.push(source);
        }
        return this._assignFrom(source);
    }

    remove(source) {
        const stack = this._stack;
        const top = stack[stack.length - 1];
        if (top === source) {
            stack.length--;
            return this._assignFrom(stack.length > 0 ? stack[stack.length - 1] : this._bottom);
        }
        for (let i = 0, iMax = stack.length; i < iMax; i++) {
            if (stack[i] === source) {
                stack.splice(i, 1);
                break;
            }
        }

        return null;
    }

    _assignFrom(source) {
        const changedProperties = [];
        for (const name in source) {
            if (this.target[name] !== source[name]) {
                this.target[name] = source[name];
                changedProperties.push(name);
            }
        }
        return changedProperties;
    }
};

// ---------- DBusMenu ----------

// Dbusmenu features not (yet) supported:
//
//   * The CHILD_DISPLAY property
//
//     This seems to have only one possible value in the Dbusmenu API, so
//     there's little point in depending on it--the code in libdbusmenu sets it
//     if and only if an item has children, so for our purposes it's simpler
//     and more intuitive to just check children.length. (This does ignore the
//     possibility of a program not using libdbusmenu and setting CHILD_DISPLAY
//     independently, perhaps to indicate that an childless menu item should
//     nevertheless be displayed like a submenu.)
//
//   * Children more than two levels deep
//
//     PopupMenu doesn't seem to support submenus in submenus.
//
//   * Shortcut keys
//
//     If these keys are supposed to be installed as global shortcuts, we'd
//     have to query these aggressively and not wait for the DBus menu to be
//     mapped to a popup menu. A shortcut key that only works once the popup
//     menu is open and has key focus is possibly of marginal value.

/**
 *
 */
export async function haveDBusMenu() {
    try {
        const {default: DBusMenu} = await import('gi://Dbusmenu');
        return DBusMenu;
    } catch (e) {
        log(`Failed to import DBusMenu, quicklists are not available: ${e}`);
        return null;
    }
}

/**
 * @param dbusmenuItem
 * @param deep
 */
export function makePopupMenuItem(dbusmenuItem, deep) {
    // These are the only properties guaranteed to be available when the root
    // item is first announced. Other properties might be loaded already, but
    // be sure to connect to Dbusmenu.MENUITEM_SIGNAL_PROPERTY_CHANGED to get
    // the most up-to-date values in case they aren't.
    const itemType = dbusmenuItem.property_get(DBusMenu.MENUITEM_PROP_TYPE);
    const label = dbusmenuItem.property_get(DBusMenu.MENUITEM_PROP_LABEL);
    const visible = dbusmenuItem.property_get_bool(DBusMenu.MENUITEM_PROP_VISIBLE);
    const enabled = dbusmenuItem.property_get_bool(DBusMenu.MENUITEM_PROP_ENABLED);
    const accessibleDesc = dbusmenuItem.property_get(DBusMenu.MENUITEM_PROP_ACCESSIBLE_DESC);
    // const childDisplay = dbusmenuItem.property_get(Dbusmenu.MENUITEM_PROP_CHILD_DISPLAY);

    let item;
    const signalsHandler = new Utils.GlobalSignalsHandler();
    const wantIcon = itemType === DBusMenu.CLIENT_TYPES_IMAGE;

    // If the basic type of the menu item needs to change, call this.
    const recreateItem = () => {
        const newItem = makePopupMenuItem(dbusmenuItem, deep);
        const parentMenu = item._parent;
        parentMenu.addMenuItem(newItem);
        // Reminder: Clutter thinks of later entries in the child list as
        // "above" earlier ones, so "above" here means "below" in terms of the
        // menu's vertical order.
        parentMenu.actor.set_child_above_sibling(newItem.actor, item.actor);
        if (newItem.menu)
            parentMenu.actor.set_child_above_sibling(newItem.menu.actor, newItem.actor);

        parentMenu.actor.remove_child(item.actor);
        item.destroy();
        item = null;
    };

    const updateDisposition = () => {
        const disposition = dbusmenuItem.property_get(DBusMenu.MENUITEM_PROP_DISPOSITION);
        let iconName = null;
        switch (disposition) {
        case DBusMenu.MENUITEM_DISPOSITION_ALERT:
        case DBusMenu.MENUITEM_DISPOSITION_WARNING:
            iconName = 'dialog-warning-symbolic';
            break;
        case DBusMenu.MENUITEM_DISPOSITION_INFORMATIVE:
            iconName = 'dialog-information-symbolic';
            break;
        }
        if (iconName) {
            item._dispositionIcon = new St.Icon({
                icon_name: iconName,
                style_class: 'popup-menu-icon',
                y_align: Clutter.ActorAlign.CENTER,
                y_expand: true,
            });
            let expander;
            for (let child = item.label.get_next_sibling(); ; child = child.get_next_sibling()) {
                if (!child) {
                    expander = new St.Bin({
                        style_class: 'popup-menu-item-expander',
                        x_expand: true,
                    });
                    item.actor.add_child(expander);
                    break;
                } else if (child instanceof St.Widget &&
                           child.has_style_class_name('popup-menu-item-expander')) {
                    expander = child;
                    break;
                }
            }
            item.actor.insert_child_above(item._dispositionIcon, expander);
        } else if (item._dispositionIcon) {
            item.actor.remove_child(item._dispositionIcon);
            item._dispositionIcon = null;
        }
    };

    const updateIcon = () => {
        if (!wantIcon)
            return;

        const iconData = dbusmenuItem.property_get_byte_array(DBusMenu.MENUITEM_PROP_ICON_DATA);
        const iconName = dbusmenuItem.property_get(DBusMenu.MENUITEM_PROP_ICON_NAME);
        if (iconName)
            item.icon.icon_name = iconName;
        else if (iconData.length)
            item.icon.gicon = Gio.BytesIcon.new(iconData);
    };

    const updateOrnament = () => {
        const toggleType = dbusmenuItem.property_get(DBusMenu.MENUITEM_PROP_TOGGLE_TYPE);
        switch (toggleType) {
        case DBusMenu.MENUITEM_TOGGLE_CHECK:
            item.actor.accessible_role = Atk.Role.CHECK_MENU_ITEM;
            break;
        case DBusMenu.MENUITEM_TOGGLE_RADIO:
            item.actor.accessible_role = Atk.Role.RADIO_MENU_ITEM;
            break;
        default:
            item.actor.accessible_role = Atk.Role.MENU_ITEM;
        }
        let ornament = PopupMenu.Ornament.NONE;
        const state = dbusmenuItem.property_get_int(DBusMenu.MENUITEM_PROP_TOGGLE_STATE);
        if (state === DBusMenu.MENUITEM_TOGGLE_STATE_UNKNOWN) {
            // PopupMenu doesn't natively support an "unknown" ornament, but we
            // can hack one in:
            item.setOrnament(ornament);
            item.actor.add_accessible_state(Atk.StateType.INDETERMINATE);
            item._ornamentLabel.text = '\u2501';
            item.actor.remove_style_pseudo_class('checked');
        } else {
            item.actor.remove_accessible_state(Atk.StateType.INDETERMINATE);
            if (state === DBusMenu.MENUITEM_TOGGLE_STATE_CHECKED) {
                if (toggleType === DBusMenu.MENUITEM_TOGGLE_CHECK)
                    ornament = PopupMenu.Ornament.CHECK;
                else if (toggleType === DBusMenu.MENUITEM_TOGGLE_RADIO)
                    ornament = PopupMenu.Ornament.DOT;

                item.actor.add_style_pseudo_class('checked');
            } else {
                item.actor.remove_style_pseudo_class('checked');
            }
            item.setOrnament(ornament);
        }
    };

    const onPropertyChanged = (_, name, value) => {
        // `value` is null when a property is cleared, so handle those cases
        // with sensible defaults.
        switch (name) {
        case DBusMenu.MENUITEM_PROP_TYPE:
            recreateItem();
            break;
        case DBusMenu.MENUITEM_PROP_ENABLED:
            item.setSensitive(value ? value.unpack() : false);
            break;
        case DBusMenu.MENUITEM_PROP_LABEL:
            item.label.text = value ? value.unpack() : '';
            break;
        case DBusMenu.MENUITEM_PROP_VISIBLE:
            item.actor.visible = value ? value.unpack() : false;
            break;
        case DBusMenu.MENUITEM_PROP_DISPOSITION:
            updateDisposition();
            break;
        case DBusMenu.MENUITEM_PROP_ACCESSIBLE_DESC:
            item.actor.get_accessible().accessible_description = value && value.unpack() || '';
            break;
        case DBusMenu.MENUITEM_PROP_ICON_DATA:
        case DBusMenu.MENUITEM_PROP_ICON_NAME:
            updateIcon();
            break;
        case DBusMenu.MENUITEM_PROP_TOGGLE_TYPE:
        case DBusMenu.MENUITEM_PROP_TOGGLE_STATE:
            updateOrnament();
            break;
        }
    };

    // Start actually building the menu item.
    const children = dbusmenuItem.get_children();
    if (children.length && !deep) {
        // Make a submenu.
        item = new PopupMenu.PopupSubMenuMenuItem(label, wantIcon);
        const updateChildren = () => {
            const itemChildren = dbusmenuItem.get_children();
            if (!itemChildren.length) {
                recreateItem();
                return;
            }

            item.menu.removeAll();
            itemChildren.forEach(remoteChild =>
                item.menu.addMenuItem(makePopupMenuItem(remoteChild, true)));
        };
        updateChildren();
        signalsHandler.add(
            [dbusmenuItem, DBusMenu.MENUITEM_SIGNAL_CHILD_ADDED, updateChildren],
            [dbusmenuItem, DBusMenu.MENUITEM_SIGNAL_CHILD_MOVED, updateChildren],
            [dbusmenuItem, DBusMenu.MENUITEM_SIGNAL_CHILD_REMOVED, updateChildren]);
    } else {
        // Don't make a submenu.
        if (!deep) {
            // We only have the potential to get a submenu if we aren't deep.
            signalsHandler.add(
                [dbusmenuItem, DBusMenu.MENUITEM_SIGNAL_CHILD_ADDED, recreateItem],
                [dbusmenuItem, DBusMenu.MENUITEM_SIGNAL_CHILD_MOVED, recreateItem],
                [dbusmenuItem, DBusMenu.MENUITEM_SIGNAL_CHILD_REMOVED, recreateItem]);
        }

        if (itemType === DBusMenu.CLIENT_TYPES_SEPARATOR) {
            item = new PopupMenu.PopupSeparatorMenuItem();
        } else if (wantIcon) {
            item = new PopupMenu.PopupImageMenuItem(label, null);
            item.icon = item._icon;
        } else {
            item = new PopupMenu.PopupMenuItem(label);
        }
    }

    // Set common initial properties.
    item.actor.visible = visible;
    item.setSensitive(enabled);
    if (accessibleDesc)
        item.actor.get_accessible().accessible_description = accessibleDesc;

    updateDisposition();
    updateIcon();
    updateOrnament();

    // Prevent an initial resize flicker.
    if (wantIcon)
        item.icon.icon_size = 16;

    signalsHandler.add(dbusmenuItem, DBusMenu.MENUITEM_SIGNAL_PROPERTY_CHANGED, onPropertyChanged);

    // Connections on item will be lost when item is disposed; there's no need
    // to add them to signalsHandler.
    item.connect('activate', () =>
        dbusmenuItem.handle_event(DBusMenu.MENUITEM_EVENT_ACTIVATED,
            new GLib.Variant('i', 0), Math.floor(Date.now() / 1000)));
    item.connect('destroy', () => signalsHandler.destroy());

    return item;
}
