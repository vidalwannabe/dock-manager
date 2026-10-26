// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

// Seamless overview zoom, based on Overview Seamless Zoom by jguece (GPL-2.0-or-later,
// https://gitlab.com/jguece/overview-seamless-zoom), as Kiwi is not Apple also does.
//
// GNOME zooms only the monitor's work area in and out of the overview: the strips the top bar
// and a fixed dock reserve are left out and pop in and out abruptly. With the option on, the
// whole primary monitor zooms instead:
//   - at ControlsState.HIDDEN the workspace card covers the whole monitor (see coverMonitor(),
//     used by the overview integration);
//   - each workspace lays its windows out against the monitor, not the work area;
//   - each workspace shows the whole wallpaper, not its work-area crop.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';

import {GlobalSignalsHandler, InjectionsHandler} from '../handlers.js';
import {DockManager} from './manager.js';

const Labels = Object.freeze({
    WAIT_FOR_CLOSE: Symbol('wait-for-close'),
});

// Keep in sync with the shell's src/shell-workspace-background.c
const BACKGROUND_MARGIN = 12;

// The stock background is allocated in C, offset and oversized so only the work-area crop
// shows. This one maps the whole monitor's wallpaper onto the card, with the same margin.
const SeamlessWorkspaceBackground = GObject.registerClass(
class SeamlessWorkspaceBackground extends Workspace.WorkspaceBackground {
    vfunc_allocate(box) {
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const [width, height] = box.get_size();

        const scaledHeight = Math.max(height - BACKGROUND_MARGIN * 2 * scaleFactor, 0);
        const scaledWidth = height > 0 ? (scaledHeight / height) * width : 0;

        const scaledBox = new Clutter.ActorBox();
        scaledBox.set_origin(
            box.x1 + (width - scaledWidth) / 2,
            box.y1 + (height - scaledHeight) / 2);
        scaledBox.set_size(scaledWidth, scaledHeight);

        const myBox = box.interpolate(scaledBox, this._stateAdjustment.value);
        this.set_allocation(myBox);
        this._bin.allocate(this.get_theme_node().get_content_box(myBox));
    }

    // Left unset so Mutter's rounded clip covers the whole monitor.
    _updateRoundedClipBounds() {}
});

// The workspace card at ControlsState.HIDDEN, grown from the work area to the whole primary
// monitor.
export function coverMonitor(box) {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor)
        return box;

    const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
    box.set_origin(box.x1 - (workArea.x - monitor.x), box.y1 - (workArea.y - monitor.y));
    box.set_size(monitor.width, monitor.height);
    return box;
}

function patchWorkspace(workspace) {
    const layout = workspace._container.layout_manager;

    // WorkspaceLayout takes the card's aspect ratio and the windows' start positions from
    // _workarea: it gets the monitor instead. Cached, since this is read on every frame; the
    // monitors are new objects after any monitor change, which renews the cache.
    Object.defineProperty(layout, '_workarea', {
        configurable: true,
        get() {
            const monitor = Main.layoutManager.monitors[this._monitorIndex];
            if (!monitor)
                return Main.layoutManager.getWorkAreaForMonitor(this._monitorIndex);
            if (this._zoomMonitor !== monitor) {
                this._zoomMonitor = monitor;
                this._zoomRect = new Mtk.Rectangle({
                    x: monitor.x,
                    y: monitor.y,
                    width: monitor.width,
                    height: monitor.height,
                });
            }
            return this._zoomRect;
        },
        set() {},
    });

    const stock = workspace._background;
    workspace._background = new SeamlessWorkspaceBackground(
        workspace.monitorIndex, layout.stateAdjustment);
    workspace.replace_child(stock, workspace._background);
    stock.destroy();
}

function restoreWorkspace(workspace) {
    const layout = workspace._container.layout_manager;

    if (Object.getOwnPropertyDescriptor(layout, '_workarea')?.get) {
        delete layout._workarea;
        delete layout._zoomMonitor;
        delete layout._zoomRect;
        layout._workarea = Main.layoutManager.getWorkAreaForMonitor(layout._monitorIndex);
        layout._needsLayout = true;
        layout.layout_changed();
    }

    if (workspace._background instanceof SeamlessWorkspaceBackground) {
        const seamless = workspace._background;
        workspace._background = new Workspace.WorkspaceBackground(
            workspace.monitorIndex, layout.stateAdjustment);
        workspace.replace_child(seamless, workspace._background);
        seamless.destroy();
    }
}

// The workspaces only exist while the overview is open: it creates them each time it opens.
function forEachLiveWorkspace(callback) {
    // While GNOME shuts down, the overview may be gone already.
    const display = Main.overview._overview?.controls?._workspacesDisplay;
    for (const view of display?._workspacesViews ?? []) {
        const inner = view._workspacesView ?? view;
        const workspaces = inner._workspaces ?? (inner._workspace ? [inner._workspace] : []);
        workspaces.forEach(callback);
    }
}

// Turns the zoom on and off with the overview-zoom setting. Changes wait for the overview to
// be closed, so one zoom never mixes the two geometries.
export class OverviewZoom {
    constructor() {
        this._signalsHandler = new GlobalSignalsHandler();
        this._injections = new InjectionsHandler();
        this._signalsHandler.add(DockManager.settings, 'changed::overview-zoom', () => this._sync());
        this._sync();
    }

    destroy() {
        this._signalsHandler.destroy();
        this._disable();
    }

    _sync() {
        this._signalsHandler.removeWithLabel(Labels.WAIT_FOR_CLOSE);
        if (Main.overview.visible) {
            // An interrupted closing also emits 'hidden', with the overview still shown.
            this._signalsHandler.addWithLabel(Labels.WAIT_FOR_CLOSE, Main.overview, 'hidden', () => {
                if (Main.overview._shown)
                    return;
                this._signalsHandler.removeWithLabel(Labels.WAIT_FOR_CLOSE);
                this._sync();
            });
            return;
        }

        if (DockManager.settings.overviewZoom)
            this._enable();
        else
            this._disable();
    }

    get active() {
        return this._active ?? false;
    }

    _enable() {
        if (this._active)
            return;
        this._active = true;

        this._injections.add(Workspace.Workspace.prototype, '_init',
            function (originalFunction, metaWorkspace, monitorIndex, ...args) {
                /* eslint-disable no-invalid-this */
                originalFunction.call(this, metaWorkspace, monitorIndex, ...args);
                if (monitorIndex === Main.layoutManager.primaryIndex)
                    patchWorkspace(this);
                /* eslint-enable no-invalid-this */
            });
    }

    _disable() {
        if (!this._active)
            return;
        this._active = false;

        this._injections.clear();
        forEachLiveWorkspace(restoreWorkspace);
    }
}
