// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as AppMenu from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import * as SwitcherPopup from 'resource:///org/gnome/shell/ui/switcherPopup.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspacesView from 'resource:///org/gnome/shell/ui/workspacesView.js';

import {GlobalSignalsHandler, InjectionsHandler, PropertyInjectionsHandler, VFuncInjectionsHandler} from '../handlers.js';
import {DockManager} from './manager.js';
import {coverMonitor} from './overviewZoom.js';

const Labels = Object.freeze({
    MAIN_DASH: Symbol('main-dash'),
    OLD_DASH_CHANGES: Symbol('old-dash-changes'),
    STARTUP_ANIMATION: Symbol('startup-animation'),
});

const WorkspaceLayout = Object.freeze({
    // Keep in sync with gnome-shell's WorkspacesView spacing constant.
    MIN_SPACING: 24,

    // Maximum share of the available width the current workspace may take in
    // the window picker. Stock GNOME ends up around this ratio by reserving the
    // bottom dash space, which the dock removes.
    MAX_WIDTH_RATIO: 0.80,

    // Minimum width share the current workspace keeps on narrow work areas.
    MIN_WIDTH_RATIO: 0.70,

    // Work area aspect ratio below which the max width ratio starts shrinking.
    WIDE_ASPECT_RATIO: 1.3,
});

// Makes GNOME's overview work with the dock: hides GNOME's own dash and gives its place to the
// main dock, and fits the workspaces and the search around the dock.
export class OverviewIntegration {
    constructor(manager) {
        this._manager = manager;
        this._signalsHandler = new GlobalSignalsHandler();
        this._methodInjections = new InjectionsHandler();
        this._vfuncInjections = new VFuncInjectionsHandler();
        this._propertyInjections = new PropertyInjectionsHandler();

        this._oldDash = Main.overview.isDummy ? null : Main.overview.dash;
        this._signalsHandler.add(this._oldDash, 'destroy', () => (this._oldDash = null));
        this._overrideAppMenus();
    }

    destroy() {
        this.restore();
        this._signalsHandler.destroy();
        this._methodInjections.destroy();
        this._vfuncInjections.destroy();
        this._propertyInjections.destroy();
        this._oldDash = null;
        this._manager = null;
    }

    get controls() {
        return Main.overview._overview.controls;
    }

    get searchController() {
        return this.controls._searchController;
    }

    // Gives the main dock the place of GNOME's dash.
    prepare() {
        this._propertyInjections.removeWithLabel(Labels.MAIN_DASH);

        // Ensure Main.overview.dash is set to our dash in dummy mode
        // while just use the default getter otherwise.
        if (Main.overview.isDummy) {
            this._propertyInjections.addWithLabel(Labels.MAIN_DASH, Main.overview, 'dash', {
                get: () => this._manager.mainDock.dash,
            });

            return;
        }

        // Hide usual Dash
        this._oldDash.hide();

        // Also set dash width to 1, so it's almost not taken into account by code
        // calculating the reserved space in the overview. The reason to keep it at 1 is
        // to allow its visibility change to trigger an allocation of the appGrid which
        // in turn is triggering the appsIcon spring animation, required when no other
        // actors has this effect, i.e in horizontal mode and without the workspaceThumbnails
        // 1 static workspace only)
        this._oldDash.set_height(1);

        this._signalsHandler.addWithLabel(Labels.OLD_DASH_CHANGES, [
            this._oldDash,
            'notify::visible',
            () => this._oldDash.hide(),
        ], [
            this._oldDash,
            'notify::height',
            () => this._oldDash.set_height(1),
        ]);

        // Pretend I'm the dash: meant to make app grid swarm animation come from
        // the right position of the appShowButton.
        const replaceMainDash = () => {
            this.controls.dash = this._manager.mainDock.dash;
            this.searchController._showAppsButton = this._manager.mainDock.dash.showAppsButton;

            // And to return the preferred height depending on the state
            this._methodInjections.addWithLabel(Labels.MAIN_DASH, this._oldDash,
                'get_preferred_height', (_originalMethod, ...args) => {
                    if (this._manager.mainDock.isHorizontal && !DockManager.settings.dockFixed)
                        return this._manager.mainDock.get_preferred_height(...args);
                    return [0, 0];
                });
        };

        // We also need to ignore max-size changes
        this._methodInjections.addWithLabel(Labels.MAIN_DASH, this._oldDash,
            'setMaxSize', () => {});
        this._methodInjections.addWithLabel(Labels.MAIN_DASH, this._oldDash,
            'allocate', () => {});
        // And to return the preferred height depending on the state
        this._methodInjections.addWithLabel(Labels.MAIN_DASH, this._oldDash,
            'get_preferred_height', () => [0, 0]);

        const ControlsManagerLayout = this.controls.layout_manager.constructor;

        const maybeAdjustBoxSize = (state, box, spacing) => {
            // ensure that an undefined value will be converted into a valid one
            spacing = spacing ?? 0;

            if (state === OverviewControls.ControlsState.WINDOW_PICKER) {
                const searchBox = this.controls._searchEntry.get_allocation_box();
                const {shouldShow: wsThumbnails} = this.controls._thumbnailsBox;

                if (!wsThumbnails) {
                    box.y1 += spacing;
                    box.y2 -= spacing;
                }

                box.y2 -= searchBox.get_height() + 2 * spacing;
            }

            return box;
        };

        const maybeLimitWorkspaceBoxSize = (box, monitorIndex) => {
            if (!Meta.prefs_get_dynamic_workspaces() &&
                Meta.prefs_get_num_workspaces() <= 1)
                return box;

            if (global.workspaceManager.layout_rows === -1)
                return box;

            // Workspaces preserve the monitor work area aspect ratio, so when
            // the dock reduces the available width we must reduce the height
            // too, otherwise the current workspace fills the whole box and
            // pushes the adjacent ones outside of the visible area.
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
            if (workArea.width <= 0 || workArea.height <= 0)
                return box;

            const aspectRatio = workArea.width / workArea.height;
            const maxWidthRatio = Math.clamp(
                WorkspaceLayout.MAX_WIDTH_RATIO * aspectRatio /
                    WorkspaceLayout.WIDE_ASPECT_RATIO,
                WorkspaceLayout.MIN_WIDTH_RATIO, WorkspaceLayout.MAX_WIDTH_RATIO);
            const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
            const maxWorkspaceWidth = Math.min(
                box.get_width() - 2 * WorkspaceLayout.MIN_SPACING * scaleFactor,
                box.get_width() * maxWidthRatio);
            const maxHeight = maxWorkspaceWidth * workArea.height / workArea.width;

            if (maxHeight <= 0 || box.get_height() <= maxHeight)
                return box;

            const centerY = (box.y1 + box.y2) / 2;
            const height = Math.round(maxHeight);
            box.y1 = Math.round(centerY - height / 2);
            box.y2 = box.y1 + height;

            return box;
        };

        const maybeAdjustBoxToDock = (state, box, spacing) => {
            if (Main.layoutManager._startingUp)
                return box;

            maybeAdjustBoxSize(state, box, spacing);

            if (this._manager.mainDock.isHorizontal || DockManager.settings.dockFixed)
                return box;

            const [, preferredWidth] = this._manager.mainDock.get_preferred_width(
                box.get_height());

            if (this._manager.mainDock.position === St.Side.LEFT)
                box.x1 += preferredWidth;
            else if (this._manager.mainDock.position === St.Side.RIGHT)
                box.x2 -= preferredWidth;

            return box;
        };

        this._vfuncInjections.addWithLabel(Labels.MAIN_DASH, ControlsManagerLayout.prototype,
            'allocate', function (container) {
                /* eslint-disable no-invalid-this */
                const oldPostAllocation = this._runPostAllocation;
                this._runPostAllocation = () => {};

                const monitor = Main.layoutManager.findMonitorForActor(container);
                const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
                const startX = workArea.x - monitor.x;
                const startY = workArea.y - monitor.y;
                const workAreaBox = new Clutter.ActorBox();
                workAreaBox.set_origin(startX, startY);
                workAreaBox.set_size(workArea.width, workArea.height);

                // GNOME 46 changes "spacing" to "_spacing".
                const spacing = this.spacing ?? this._spacing;

                maybeAdjustBoxToDock(undefined, workAreaBox, spacing);
                const oldStartY = workAreaBox.y1;

                const propertyInjections = new PropertyInjectionsHandler();
                propertyInjections.add(Main.layoutManager.panelBox, 'height', {value: startY});

                if (Main.layoutManager.panelBox.y === Main.layoutManager.primaryMonitor.y)
                    workAreaBox.y1 -= oldStartY;

                this.vfunc_allocate(container, workAreaBox);

                propertyInjections.destroy();
                workAreaBox.y1 = oldStartY;

                const adjustActorHorizontalAllocation = actor => {
                    if (!actor.visible || !workAreaBox.x1)
                        return;

                    const contentBox = actor.get_allocation_box();
                    contentBox.set_size(workAreaBox.get_width(), contentBox.get_height());
                    contentBox.set_origin(workAreaBox.x1, contentBox.y1);
                    actor.allocate(contentBox);
                };

                [this._searchEntry, this._workspacesThumbnails, this._searchController].forEach(
                    actor => adjustActorHorizontalAllocation(actor));

                this._runPostAllocation = oldPostAllocation;
                this._runPostAllocation();
                /* eslint-enable no-invalid-this */
            });

        /**
         * This can be removed or bypassed when GNOME/gnome-shell!1892 will be merged
         *
         * @param originalFunction
         * @param state
         * @param workAreaBox
         * @param {...any} args
         */
        function workspaceBoxOriginFixer(originalFunction, state, workAreaBox, ...args) {
            /* eslint-disable no-invalid-this */
            const workspaceBox = originalFunction.call(this, state, workAreaBox, ...args);
            workspaceBox.set_origin(workAreaBox.x1, workspaceBox.y1);
            return workspaceBox;
            /* eslint-enable no-invalid-this */
        }

        this._methodInjections.addWithLabel(Labels.MAIN_DASH, [
            ControlsManagerLayout.prototype,
            '_computeWorkspacesBoxForState',
            function (originalFunction, state, ...args) {
                /* eslint-disable no-invalid-this */
                if (state === OverviewControls.ControlsState.HIDDEN) {
                    const box = originalFunction.call(this, state, ...args);
                    return DockManager.getDefault().overviewZoom.active ? coverMonitor(box) : box;
                }

                const box = workspaceBoxOriginFixer.call(this, originalFunction, state, ...args);
                const dock = DockManager.getDefault().getDockByMonitor(Main.layoutManager.primaryIndex);
                if (!dock)
                    return box;

                // GNOME 46 changes "spacing" to "_spacing".
                const spacing = this.spacing ?? this._spacing;
                const adjustedBox = maybeAdjustBoxSize(state, box, spacing);

                if (state === OverviewControls.ControlsState.WINDOW_PICKER) {
                    return maybeLimitWorkspaceBoxSize(
                        adjustedBox, Main.layoutManager.primaryIndex);
                }

                return adjustedBox;
                /* eslint-enable no-invalid-this */
            },
        ], [
            WorkspacesView.SecondaryMonitorDisplay.prototype,
            '_getWorkspacesBoxForState',
            function (originalFunction, state, ...args) {
                /* eslint-disable no-invalid-this */
                if (state === OverviewControls.ControlsState.HIDDEN)
                    return originalFunction.call(this, state, ...args);

                const box = workspaceBoxOriginFixer.call(this, originalFunction, state, ...args);
                const dock = DockManager.getDefault().getDockByMonitor(this._monitorIndex);
                if (!dock)
                    return box;

                if (state !== OverviewControls.ControlsState.WINDOW_PICKER)
                    return box;

                if (dock.position === St.Side.BOTTOM) {
                    const [, preferredHeight] = dock.get_preferred_height(box.get_width());
                    box.y2 -= preferredHeight;
                }

                if (this._workspacesView instanceof WorkspacesView.ExtraWorkspaceView)
                    return box;

                return maybeLimitWorkspaceBoxSize(box, this._monitorIndex);
                /* eslint-enable no-invalid-this */
            },
        ], [
            ControlsManagerLayout.prototype,
            '_getAppDisplayBoxForState',
            function (originalFunction, ...args) {
                /* eslint-disable no-invalid-this */
                return workspaceBoxOriginFixer.call(this, originalFunction, ...args);
                /* eslint-enable no-invalid-this */
            },
        ], [
            // Sadly CtrlAltTabPopup is not exported, so we cannot just patch it.
            SwitcherPopup.SwitcherPopup.prototype,
            '_finish',
            function (originalFunction, ...args) {
                /* eslint-disable no-invalid-this */
                if (this.constructor.name === 'CtrlAltTabPopup') {
                    const dockManager = DockManager.getDefault();
                    if (dockManager._inCtrlAltTabSwitcher)
                        return;

                    dockManager._inCtrlAltTabSwitcher = true;
                    this.constructor.prototype._finish.call(this, ...args);
                    delete dockManager._inCtrlAltTabSwitcher;
                }
                originalFunction.call(this, ...args);
                /* eslint-enable no-invalid-this */
            },
        ]);

        this._vfuncInjections.addWithLabel(Labels.MAIN_DASH, Workspace.WorkspaceBackground.prototype,
            'allocate', function (box) {
                /* eslint-disable no-invalid-this */
                this.vfunc_allocate(box);

                // This code has been submitted upstream via GNOME/gnome-shell!1892
                // so can be removed when that gets merged (or bypassed on newer shell
                // versions).
                const monitor = Main.layoutManager.monitors[this._monitorIndex];
                const [contentWidth, contentHeight] = this._bin.get_content_box().get_size();
                const [mX1, mX2] = [monitor.x, monitor.x + monitor.width];
                const [mY1, mY2] = [monitor.y, monitor.y + monitor.height];
                const [wX1, wX2] = [this._workarea.x, this._workarea.x + this._workarea.width];
                const [wY1, wY2] = [this._workarea.y, this._workarea.y + this._workarea.height];
                const xScale = contentWidth / this._workarea.width;
                const yScale = contentHeight / this._workarea.height;
                const leftOffset = wX1 - mX1;
                const topOffset = wY1 - mY1;
                const rightOffset = mX2 - wX2;
                const bottomOffset = mY2 - wY2;

                const contentBox = new Clutter.ActorBox();
                contentBox.set_origin(-leftOffset * xScale, -topOffset * yScale);
                contentBox.set_size(
                    contentWidth + (leftOffset + rightOffset) * xScale,
                    contentHeight + (topOffset + bottomOffset) * yScale);

                this._backgroundGroup.allocate(contentBox);
                /* eslint-enable no-invalid-this */
            });

        // Reduce the space that the workspaces can use in secondary monitors
        this._methodInjections.addWithLabel(Labels.MAIN_DASH, WorkspacesView.WorkspacesView.prototype,
            '_getFirstFitAllWorkspaceBox', function (originalFunction, ...args) {
                /* eslint-disable no-invalid-this */
                const box = originalFunction.call(this, ...args);
                if (DockManager.settings.dockFixed ||
                    this._monitorIndex === Main.layoutManager.primaryIndex)
                    return box;

                const dock = DockManager.getDefault().getDockByMonitor(this._monitorIndex);
                if (!dock)
                    return box;

                if (dock.isHorizontal) {
                    const [, preferredHeight] = dock.get_preferred_height(box.get_width());
                    box.y2 -= preferredHeight;
                    if (dock.position === St.Side.TOP)
                        box.set_origin(box.x1, box.y1 + preferredHeight);
                } else {
                    const [, preferredWidth] = dock.get_preferred_width(box.get_height());
                    box.x2 -= preferredWidth / 2;
                    if (dock.position === St.Side.LEFT)
                        box.set_origin(box.x1 + preferredWidth, box.y1);
                }
                return box;
                /* eslint-enable no-invalid-this */
            });

        if (Main.layoutManager._startingUp) {
            // Use a dummy actor as dash during the startup animation, until
            // we're done with it, so that nothing is really shown or modified
            // during the upstream startup animation, that still requires to
            // have a valid actor.
            const dummyDash = new Clutter.Actor({visible: false, opacity: 0});
            dummyDash.showAppsButton = {};
            Object.defineProperty(dummyDash.showAppsButton, 'checked', {
                get: () => false,
                set: () => {},
            });
            this.controls.dash = dummyDash;
            Main.uiGroup.add_child(dummyDash);

            this._signalsHandler.addWithLabel(Labels.STARTUP_ANIMATION,
                Main.layoutManager, 'startup-complete', () => {
                    this._signalsHandler.removeWithLabel(Labels.STARTUP_ANIMATION);
                    replaceMainDash();
                    dummyDash.destroy();
                });
        } else {
            replaceMainDash();
        }
    }

    restore() {
        if (!this._oldDash || this.controls.dash === this._oldDash)
            return;

        this._signalsHandler.removeWithLabel(Labels.OLD_DASH_CHANGES);
        [this._methodInjections, this._vfuncInjections, this._propertyInjections].forEach(
            injections => injections.removeWithLabel(Labels.MAIN_DASH));

        this.controls.layout_manager._dash = this._oldDash;
        this.controls.dash = this._oldDash;
        this.searchController._showAppsButton = this._oldDash.showAppsButton;
        Main.overview.dash.show();
        Main.overview.dash.set_height(-1); // reset default dash size
        // This force the recalculation of the icon size
        Main.overview.dash._maxHeight = -1;
    }

    onShowAppsButtonToggled(button) {
        const {checked} = button;
        const {overviewControls} = this;

        if (!Main.overview.visible) {
            this._manager.mainDock.dash.showAppsButton._fromDesktop = true;
            Main.overview.show(OverviewControls.ControlsState.APP_GRID);
        } else if (!checked && this._manager.mainDock.dash.showAppsButton._fromDesktop &&
            !this._manager._inCtrlAltTabSwitcher) {
            Main.overview.hide();
            this._manager.mainDock.dash.showAppsButton._fromDesktop = false;
        } else {
            // TODO: I'm not sure how reliable this is, we might need to move the
            // _onShowAppsButtonToggled logic into the extension.
            if (!checked)
                this._manager.mainDock.dash.showAppsButton._fromDesktop = false;

            // Instead of "syncing" the stock button, let's call its callback directly.
            overviewControls._onShowAppsButtonToggled();
        }

        // Because we "disconnected" from the search controller, we have to manage its state.
        this.searchController._setSearchActive(false);
    }

    _overrideAppMenus() {
        this._methodInjections.add(AppMenu.AppMenu.prototype,
            '_updateFavoriteItem', function (originalFunction, ...args) {
                /* eslint-disable no-invalid-this */
                originalFunction.call(this, ...args);
                if (!this._toggleFavoriteItem.visible)
                    return;

                const {id} = this._app;
                this._toggleFavoriteItem.label.text = this._appFavorites.isFavorite(id)
                    ? _('Unpin') : 'Pin to Dock';
                /* eslint-enable no-invalid-this */
            });
    }
}
