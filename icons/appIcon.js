// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DockManager} from '../dock/manager.js';
import {GlobalSignalsHandler} from '../handlers.js';
import {DockAppIconMenu} from './appIconMenu.js';
import {RunningIndicatorDots} from './runningDots.js';

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
        this._signalsHandler = new GlobalSignalsHandler(this);
        this._indicator = new RunningIndicatorDots(this);
        this._urgentWindows = new Set();

        // Monitor windows-changes instead of app state.
        // Keep using the same Id and function callback (that is extended)
        if (this._stateChangedId > 0) {
            this.app.disconnect(this._stateChangedId);
            this._stateChangedId = 0;
        }

        this._signalsHandler.add(this.app, 'windows-changed', () => this._updateWindows());
        // An app gets the focus while still starting: once it runs, its focus is checked again.
        this._signalsHandler.add(this.app, 'notify::state', () => {
            this._updateRunningState();
            this._updateFocusState();
        });
        this._signalsHandler.add(global.display, 'window-demands-attention', (_dpy, window) =>
            this._onWindowDemandsAttention(window));
        this._signalsHandler.add(global.display, 'window-marked-urgent', (_dpy, window) =>
            this._onWindowDemandsAttention(window));

        // In Wayland sessions, this signal is needed to track the state of windows dragged
        // from one monitor to another. As this is triggered quite often (whenever a new
        // window of any application opened or moved to a different desktop),
        // we restrict this signal to  the case when Labels.ISOLATE_MONITORS is true,
        // and if there are at least 2 monitors.
        if (DockManager.settings.isolateMonitors &&
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

        // The focused app stands out from the others: its tile takes the shade the theme gives
        // to a checked tile (GNOME's own, or the one of an extension that recolors the shell).
        this.connect('notify::focused', () => {
            if (this.focused) {
                this.add_style_class_name('focused');
                this.add_style_pseudo_class('checked');
            } else {
                this.remove_style_class_name('focused');
                this.remove_style_pseudo_class('checked');
            }
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
        return this.app === DockManager.windowTracker.get_window_app(window);
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
            DockManager.windowTracker.focus_app === this.app;
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
        if (DockManager.settings.multiMonitor) {
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
            '%s is updating, try again later'.format(this.name), null);
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
                    const position = DockManager.settings.dockPosition;
                    const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
                    const isHorizontal = position === St.Side.TOP || position === St.Side.BOTTOM;
                    // If horizontal also remove the height of the dash
                    const {dockFixed: fixedDock} = DockManager.settings;
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
        if (!DockManager.settings.isolateMonitors) {
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

export const DockAppIcon = GObject.registerClass({
}, class DockAppIcon extends DockAbstractAppIcon {
    _init(app, monitorIndex) {
        super._init(app, monitorIndex);

        const {windowTracker} = DockManager;
        this._signalsHandler.add(windowTracker, 'notify::focus-app',
            () => this._updateFocusState());
    }
});

/**
 * @param app
 * @param monitorIndex
 */
export function makeAppIcon(app, monitorIndex) {
    return new DockAppIcon(app, monitorIndex);
}

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
    const {settings} = DockManager;

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

    const position = DockManager.settings.dockPosition;
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
