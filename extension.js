// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Extension from 'resource:///org/gnome/shell/extensions/extension.js';
import * as AnimationUtils from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as AppMenu from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import * as SwitcherPopup from 'resource:///org/gnome/shell/ui/switcherPopup.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceSwitcherPopup from 'resource:///org/gnome/shell/ui/workspaceSwitcherPopup.js';
import * as WorkspacesView from 'resource:///org/gnome/shell/ui/workspacesView.js';

import * as AppIcons from './appIcons.js';
import * as DockDash from './dash.js';
import * as Locations from './locations.js';
import * as Utils from './utils.js';

// Use __() and N__() for the extension gettext domain, and the shell domain with _() and N_().
const {gettext: __} = Extension;
const {signals: Signals} = imports;

const Labels = Object.freeze({
    INITIALIZE: Symbol('initialize'),
    ISOLATION: Symbol('isolation'),
    MAIN_DASH: Symbol('main-dash'),
    OLD_DASH_CHANGES: Symbol('old-dash-changes'),
    SETTINGS: Symbol('settings'),
    STARTUP_ANIMATION: Symbol('startup-animation'),
    DOCKED_DASH_GLOBAL_SIGNALS: Symbol('docked-dash-global-signals'),
    THEME_CHANGED: Symbol('theme-changed'),
});

const DOCK_DWELL_CHECK_INTERVAL = 100;
const ICON_ANIMATOR_DURATION = 3000;
const STARTUP_ANIMATION_TIME = 500;

export const State = Object.freeze({
    HIDDEN:  0,
    SHOWING: 1,
    SHOWN:   2,
    HIDING:  3,
});

const WorkspaceLayout = Object.freeze({
    // Keep in sync with gnome-shell's WorkspacesView spacing constant.
    MIN_SPACING: 24,

    // Maximum share of the available width the current workspace may take in
    // the window picker. Stock GNOME ends up around this ratio by reserving the
    // bottom dash space, which dash-to-dock removes.
    MAX_WIDTH_RATIO: 0.80,

    // Minimum width share the current workspace keeps on narrow work areas.
    MIN_WIDTH_RATIO: 0.70,

    // Work area aspect ratio below which the max width ratio starts shrinking.
    WIDE_ASPECT_RATIO: 1.3,
});

/**
 * A simple St.Widget with one child whose allocation takes into account the
 * slide out of its child via the slide-x property ([0:1]).
 *
 * Required since I want to track the input region of this container which is
 * based on its allocation even if the child overflows the parent actor. By doing
 * this the region of the dash that is slide-out is not stealing anymore the input
 * regions making the extension usable when the primary monitor is the right one.
 *
 * The slide-x parameter can be used to directly animate the sliding. The parent
 * must have a WEST (SOUTH) anchor_point to achieve the sliding to the RIGHT (BOTTOM)
 * side.
 */
const DashSlideContainer = GObject.registerClass({
    Properties: {
        'monitor-index': GObject.ParamSpec.uint(
            'monitor-index', 'monitor-index', 'monitor-index',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            0, GLib.MAXUINT32, 0),
        'side': GObject.ParamSpec.enum(
            'side', 'side', 'side',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            St.Side, St.Side.LEFT),
        'slide-x': GObject.ParamSpec.double(
            'slide-x', 'slide-x', 'slide-x',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT,
            0, 1, 1),
    },
}, class DashSlideContainer extends St.Bin {
    _init(params = {}) {
        super._init(params);

        this._slideoutSize = 0; // minimum size when slided out
        this.connect('notify::slide-x', () => this.queue_relayout());

        if (this.side === St.Side.TOP && DockManager.settings.dockFixed) {
            this._signalsHandler = new Utils.GlobalSignalsHandler(this);
            this._signalsHandler.add(Main.panel, 'notify::height',
                () => this.queue_relayout());
        }
    }

    vfunc_allocate(box) {
        const contentBox = this.get_theme_node().get_content_box(box);

        this.set_allocation(box);

        if (!this.child)
            return;

        const availWidth = contentBox.x2 - contentBox.x1;
        let availHeight = contentBox.y2 - contentBox.y1;
        const [, , natChildWidth, natChildHeight] =
            this.child.get_preferred_size();

        const childWidth = natChildWidth;
        const childHeight = natChildHeight;

        const childBox = new Clutter.ActorBox();

        const slideoutSize = this._slideoutSize;

        if (this.side === St.Side.LEFT) {
            childBox.x1 = (this.slideX - 1) * (childWidth - slideoutSize);
            childBox.x2 = slideoutSize + this.slideX * (childWidth - slideoutSize);
            childBox.y1 = 0;
            childBox.y2 = childBox.y1 + childHeight;
        } else if ((this.side === St.Side.RIGHT) || (this.side === St.Side.BOTTOM)) {
            childBox.x1 = 0;
            childBox.x2 = childWidth;
            childBox.y1 = 0;
            childBox.y2 = childBox.y1 + childHeight;
        } else if (this.side === St.Side.TOP) {
            const monitor = Main.layoutManager.monitors[this.monitorIndex];
            let yOffset = 0;
            if (Main.panel.x === monitor.x && Main.panel.y === monitor.y &&
                DockManager.settings.dockFixed)
                yOffset = Main.panel.height;
            childBox.x1 = 0;
            childBox.x2 = childWidth;
            childBox.y1 = (this.slideX - 1) * (childHeight - slideoutSize) + yOffset;
            childBox.y2 = slideoutSize + this.slideX * (childHeight - slideoutSize) + yOffset;
            availHeight += yOffset;
        }

        this.child.allocate(childBox);

        this.child.set_clip(-childBox.x1, -childBox.y1,
            -childBox.x1 + availWidth, -childBox.y1 + availHeight);
    }

    /**
     * Just the child width but taking into account the slided out part
     *
     * @param forHeight
     */
    vfunc_get_preferred_width(forHeight) {
        let [minWidth, natWidth] = super.vfunc_get_preferred_width(forHeight || 0);
        if ((this.side ===  St.Side.LEFT) || (this.side === St.Side.RIGHT)) {
            minWidth = (minWidth - this._slideoutSize) * this.slideX + this._slideoutSize;
            natWidth = (natWidth - this._slideoutSize) * this.slideX + this._slideoutSize;
        }
        return [minWidth, natWidth];
    }

    /**
     * Just the child height but taking into account the slided out part
     *
     * @param forWidth
     */
    vfunc_get_preferred_height(forWidth) {
        let [minHeight, natHeight] = super.vfunc_get_preferred_height(forWidth || 0);
        if ((this.side ===  St.Side.TOP) || (this.side ===  St.Side.BOTTOM)) {
            minHeight = (minHeight - this._slideoutSize) * this.slideX + this._slideoutSize;
            natHeight = (natHeight - this._slideoutSize) * this.slideX + this._slideoutSize;

            if (this.side === St.Side.TOP && DockManager.settings.dockFixed) {
                const monitor = Main.layoutManager.monitors[this.monitorIndex];
                if (Main.panel.x === monitor.x && Main.panel.y === monitor.y) {
                    minHeight += Main.panel.height;
                    natHeight += Main.panel.height;
                }
            }
        }
        return [minHeight, natHeight];
    }
});

const DockedDash = GObject.registerClass({
    Properties: {
        'is-main': GObject.ParamSpec.boolean(
            'is-main', 'is-main', 'is-main',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            false),
        'monitor-index': GObject.ParamSpec.uint(
            'monitor-index', 'monitor-index', 'monitor-index',
            GObject.ParamFlags.READWRITE | GObject.ParamFlags.CONSTRUCT_ONLY,
            0, GLib.MAXUINT32, 0),
        'dock-state': GObject.ParamSpec.uint(
            'dock-state', 'dock-state', 'dock-state',
            GObject.ParamFlags.READWRITE,
            0, GLib.MAXUINT32, State.HIDDEN),
        'intellihide-enabled': GObject.ParamSpec.boolean(
            'intellihide-enabled', 'intellihide-enabled', 'intellihide-enabled',
            GObject.ParamFlags.READWRITE,
            false),
        'autohide-enabled': GObject.ParamSpec.boolean(
            'autohide-enabled', 'autohide-enabled', 'autohide-enabled',
            GObject.ParamFlags.READWRITE,
            false),
    },
    Signals: {
        'showing': {},
        'hiding': {},
    },
}, class DashToDock extends St.Bin {
    _init(params) {
        this._position = Utils.getPosition();

        // This is the centering actor
        super._init({
            ...params,
            name: 'dashtodockContainer',
            reactive: false,
            style_class: PositionStyleClass[this._position],
        });

        this._rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;

        // Load settings
        const {settings} = DockManager;
        this._isHorizontal = (this._position === St.Side.TOP) || (this._position === St.Side.BOTTOM);

        // Temporary ignore hover events linked to autohide for whatever reason
        this._ignoreHover = false;

        // Create intellihide object to monitor windows overlapping
        this._intellihide = new Intellihide(this.monitorIndex);

        // Put dock on the required monitor
        this._monitor = Main.layoutManager.monitors[this.monitorIndex];

        // this store size and the position where the dash is shown;
        // used by intellihide module to check window overlap.
        this._staticBox = new Clutter.ActorBox();
        this._staticBoxGeometry = null;

        // Initialize dwelling system variables
        this._dockDwelling = false;
        this._dockWatch = null;
        this._dockDwellUserTime = 0;
        this._dockDwellTimeoutId = 0;

        // Create a new dash object
        this.dash = new DockDash.DockDash(this.monitorIndex);

        if (Main.overview.isDummy)
            this.dash.hideShowAppsButton();

        // Create the containers for sliding in and out and
        // centering, turn on track hover
        // This is the sliding actor whose allocation is to be tracked for input regions
        this._slider = new DashSlideContainer({
            monitor_index: this._monitor.index,
            side: this._position,
            slide_x: Main.layoutManager._startingUp ? 0 : 1,
            ...this._isHorizontal ? {
                x_align: Clutter.ActorAlign.CENTER,
            } : {
                y_align: Clutter.ActorAlign.CENTER,
            },
        });

        // This is the actor whose hover status us tracked for autohide
        this._box = new St.BoxLayout({
            name: 'dashtodockBox',
            reactive: true,
            track_hover: true,
        });
        this._box.connect('notify::hover', this._hoverChanged.bind(this));

        // Connect global signals
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);
        this._signalsHandler.add([
            // Monitor windows overlapping
            this._intellihide,
            'status-changed',
            () => this.updateDashVisibility(),
        ], [
            this.dash,
            'menu-opened',
            () => {
                this._onMenuOpened();
            },
        ], [
            // sync hover after a popupmenu is closed
            this.dash,
            'menu-closed',
            () => {
                this._onMenuClosed();
            },
        ], [
            this.dash,
            'notify::requires-visibility',
            () => this.updateDashVisibility(),
        ]);

        if (!Main.overview.isDummy) {
            this._signalsHandler.add([
                Main.overview,
                'item-drag-begin',
                this._onDragStart.bind(this),
            ], [
                Main.overview,
                'item-drag-end',
                this._onDragEnd.bind(this),
            ], [
                Main.overview,
                'item-drag-cancelled',
                this._onDragEnd.bind(this),
            ], [
                Main.overview,
                'showing',
                this._onOverviewShowing.bind(this),
            ], [
                Main.overview,
                'hiding',
                this._onOverviewHiding.bind(this),
            ],
            [
                Main.overview,
                'hidden',
                this._onOverviewHidden.bind(this),
            ]);
        }

        this._themeManager = new ThemeManager(this);
        this._signalsHandler.add(this._themeManager, 'updated',
            () => this.dash.resetAppIcons());

        this._signalsHandler.add(DockManager.iconTheme, 'changed',
            () => this.dash.resetAppIcons());

        this.connect('notify::autohide-enabled', () => {
            if (this.autohideEnabled)
                this.add_style_class_name('autohide');
            else
                this.remove_style_class_name('autohide');
        });

        this.connect('notify::intellihide-enabled', () => {
            if (this.intellihideEnabled)
                this._intellihide.enable();
            else
                this._intellihide.disable();
        });

        // Since the actor is not a topLevel child and its parent is now not added to the Chrome,
        // the allocation change of the parent container (slide in and slideout) doesn't trigger
        // anymore an update of the input regions. Force the update manually.
        this.connect('notify::allocation',
            Main.layoutManager._queueUpdateRegions.bind(Main.layoutManager));

        // Since Clutter has no longer ClutterAllocationFlags,
        // "allocation-changed" signal has been removed. MR !1245
        this.dash._container.connect('notify::allocation', this._updateStaticBox.bind(this));
        this._slider.connect('notify::allocation', () => this._updateStaticBox());

        // Load optional features that need to be activated for one dock only
        if (this.isMain)
            this._enableExtraFeatures();
        this._enableScrollWorkspaceSwitch();

        // Add dash container actor and the container to the Chrome.
        this.set_child(this._slider);
        this._slider.set_child(this._box);
        this._box.add_child(this.dash);

        // Delay operations that require the shell to be fully loaded and with
        // user theme applied.
        if (Main.layoutManager._startingUp) {
            this._prepareStartupAnimation();

            this._signalsHandler.addWithLabel(Labels.STARTUP_ANIMATION,
                Main.layoutManager, 'startup-complete', () => {
                    this._signalsHandler.removeWithLabel(Labels.STARTUP_ANIMATION);
                    this._trackDock();
                    this._initialize();
                    this._runStartupAnimation();
                });
        } else {
            this._trackDock();
            // Show the dock only once fully initialized. This workarounds a
            // resize glitch we are seeing if the dock is initialized without
            // an animation.
            // $SOMETHING seems to resize it, but it's yet unclear what it is.
            this.opacity = 0;
            this._signalsHandler.addWithLabel(Labels.INITIALIZE, global.stage,
                'after-paint', () => {
                    this._signalsHandler.removeWithLabel(Labels.INITIALIZE);
                    this._initialize();
                    this.opacity = 255;
                });
        }

        this.connect('destroy', this._onDestroy.bind(this));
    }

    get position() {
        return this._position;
    }

    get isHorizontal() {
        return this._isHorizontal;
    }

    _untrackDock() {
        Main.layoutManager.untrackChrome(this);
    }

    _trackDock() {
        if (DockManager.settings.dockFixed) {
            if (this.get_parent())
                Main.layoutManager.removeChrome(this);
            Main.layoutManager.addChrome(this, {
                trackFullscreen: true,
                affectsStruts: true,
            });
        } else {
            if (this.get_parent())
                Main.layoutManager.removeChrome(this);
            Main.layoutManager.addChrome(this);
        }

    }

    _initialize() {
        // Create and apply height/width constraint to the dash.
        if (this._isHorizontal) {
            this.bind_property('width', this.dash, 'max-width',
                GObject.BindingFlags.SYNC_CREATE);
        } else {
            this.bind_property('height', this.dash, 'max-height',
                GObject.BindingFlags.SYNC_CREATE);
        }

        if (this._position === St.Side.RIGHT) {
            this.translation_x = -this.width;
            this.connect('notify::width', () =>
                (this.translation_x = -this.width));
        } else if (this._position === St.Side.BOTTOM) {
            this.translation_y = -this.height;
            this.connect('notify::height', () =>
                (this.translation_y = -this.height));
        }

        this._updateVisibilityMode();

        // In case we are already inside the overview when the extension is loaded,
        // for instance on unlocking the screen if it was locked with the overview open.
        if (Main.overview.visibleTarget)
            this._onOverviewShowing();

        this._updateEdgeDwell();
    }

    _onDestroy() {
        // The dash, intellihide and themeManager have global signals as well internally
        this.dash.destroy();
        this._intellihide.destroy();
        this._themeManager.destroy();
        this._workspaceSwitcherPopup?.destroy();
        delete this._staticBox;

        if (this._marginLater) {
            Utils.laterRemove(this._marginLater);
            delete this._marginLater;
        }

        if (this._triggerTimeoutId)
            GLib.source_remove(this._triggerTimeoutId);

        this._removeDockWatch();
        this._cancelDockDwell();

        if (this._scrollWorkspaceSwitchDeadTimeId) {
            GLib.source_remove(this._scrollWorkspaceSwitchDeadTimeId);
            delete this._scrollWorkspaceSwitchDeadTimeId;
        }
    }

    _prepareStartupAnimation() {
        this.opacity = 255;
        this.dash.set({
            opacity: 0,
            translation_x: 0,
            translation_y: 0,
        });
    }

    _runStartupAnimation() {
        const {dash} = this;

        switch (this.position) {
        case St.Side.LEFT:
            dash.translation_x = -dash.width;
            break;
        case St.Side.RIGHT:
            dash.translation_x = dash.width;
            break;
        case St.Side.BOTTOM:
            dash.translation_y = dash.height;
            break;
        case St.Side.TOP:
            dash.translation_y = -dash.height;
            break;
        }

        dash.ease({
            opacity: 255,
            translation_x: 0,
            translation_y: 0,
            duration: STARTUP_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _updateEdgeDwell() {
        this._removeDockWatch();
        this._setupDockDwellIfNeeded();
    }

    _bindSettingsChanges() {
        const {settings} = DockManager;
        this._signalsHandler.addWithLabel(Labels.DOCKED_DASH_GLOBAL_SIGNALS, [
            settings,
            'changed::icon-size-fixed',
            () => this.dash.updateIconSize(),
        ], [
            settings,
            'changed::dance-urgent-applications',
            () => this.dash.resetAppIcons(),
            Utils.SignalsHandlerFlags.CONNECT_AFTER,
        ], [
            settings,
            'changed::dock-fixed',
            () => {
                this._untrackDock();
                this._trackDock();

                this._updateEdgeDwell();
                this._updateVisibilityMode();
            },
        ], [
            settings,
            'changed::manualhide',
            () => {
                this._updateVisibilityMode();
            },
        ], [
            settings,
            'changed::autohide',
            () => {
                this._updateVisibilityMode();
                this._updateEdgeDwell();
            },
        ], [
            settings,
            'changed::show-dock-urgent-notify',
            () => {
                this.dash.resetAppIcons();
            },
        ],
        [
            settings,
            'changed::extend-height',
            () => this._resetPosition(),
        ], [
            settings,
            'changed::height-fraction',
            () => this._resetPosition(),
        ], [
            settings,
            'changed::always-center-icons',
            () => this.dash.resetAppIcons(),
        ]);
    }

    get inhibitsUnredirection() {
        // Composition is needed while the dock is animating or is shown on top
        // of a fullscreen window of its monitor.
        // Otherwise the compositor-wide inhibition would prevent fullscreen
        // windows in other monitors to run in direct rendering mode.
        if (!this.visible)
            return false;

        switch (this.dockState) {
        case State.SHOWING:
        case State.HIDING:
        case State.SHOWN:
            return !!this._monitor?.inFullscreen;
        default:
            return false;
        }
    }

    /**
     * This is call when visibility settings change
     */
    _updateVisibilityMode() {
        const {settings} = DockManager;
        if (DockManager.settings.dockFixed || DockManager.settings.manualhide) {
            this.autohideEnabled = false;
            this.intellihideEnabled = false;
        } else {
            this.autohideEnabled = settings.autohide;
            this.intellihideEnabled = true;
        }

        this.updateDashVisibility();
    }

    /**
     * Show/hide dash based on, in order of priority:
     * overview visibility
     * fixed mode
     * intellihide
     * autohide
     * overview visibility
     */
    updateDashVisibility() {
        if (DockManager.settings.manualhide) {
            this._ignoreHover = true;
            this._removeAnimations();
            this._animateOut(0, 0);
            return;
        }

        if (Main.overview.visibleTarget)
            return;

        if (this._menuOpened)
            return;

        const {settings} = DockManager;

        if (DockManager.settings.dockFixed) {
            this._removeAnimations();
            this._animateIn(settings.animationTime, 0);
        } else if (this.intellihideEnabled) {
            if (!this.dash.requiresVisibility && this._intellihide.getOverlapStatus()) {
                this._ignoreHover = false;
                // Do not hide if autohide is enabled and mouse is hover
                if (!this._box.hover || !this.autohideEnabled)
                    this._animateOut(settings.animationTime, 0);
            } else {
                this._ignoreHover = true;
                this._removeAnimations();
                this._animateIn(settings.animationTime, 0);
            }
        } else if (this.autohideEnabled) {
            this._ignoreHover = false;

            if (this._box.hover || this.dash.requiresVisibility)
                this._animateIn(settings.animationTime, 0);
            else
                this._animateOut(settings.animationTime, 0);
        } else {
            this._animateOut(settings.animationTime, 0);
        }
    }

    _onOverviewShowing() {
        this.add_style_class_name('overview');

        this._ignoreHover = true;
        this._intellihide.disable();
        this._removeAnimations();
        this._animateIn(DockManager.settings.animationTime, 0);
    }

    _onOverviewHiding() {
        this._intellihide.enable();
        this.updateDashVisibility();
    }

    _onOverviewHidden() {
        this.remove_style_class_name('overview');
        this.updateDashVisibility();
    }

    _onMenuOpened() {
        this._ignoreHover = true;
        this._menuOpened = true;
        this.updateDashVisibility();
    }

    _onMenuClosed() {
        delete this._menuOpened;
        this._box.sync_hover();
        this.updateDashVisibility();
    }

    _hoverChanged() {
        if (!this._ignoreHover) {
            // Skip if dock is not in autohide mode for instance because it is shown
            // by intellihide.
            if (this.autohideEnabled) {
                if (this._box.hover || Main.overview.visible)
                    this.showDock();
                else
                    this.hideDock();
            }
        }
    }

    showDock() {
        if (DockManager.settings.manualhide)
            return;

        this._delayedHide = false;
        if ((this.dockState === State.HIDDEN) || (this.dockState === State.HIDING)) {
            if (this.dockState === State.HIDING)
                // suppress all potential queued transitions - i.e. added but not started,
                // always give priority to show
                this._removeAnimations();

            this.emit('showing');
            this._animateIn(DockManager.settings.animationTime, 0);
        }
    }

    hideDock() {
        // If no hiding animation is running or queued
        if ((this.dockState === State.SHOWN) || (this.dockState === State.SHOWING)) {
            const {settings} = DockManager;
            const delay = settings.hideDelay;

            if (this.dockState === State.SHOWING) {
                // if a show already started, let it finish; queue hide without removing the show.
                // to obtain this, we wait for the animateIn animation to be completed
                this._delayedHide = true;
                return;
            }

            this.emit('hiding');
            this._animateOut(settings.animationTime, delay);
        }
    }

    _animateIn(time, delay) {
        if (this.dockState === State.SHOWN)
            return;

        this.dockState = State.SHOWING;
        this.dash.iconAnimator.start();
        this._delayedHide = false;

        this._slider.ease_property('slide-x', 1, {
            duration: time * 1000,
            delay: delay * 1000,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.dockState = State.SHOWN;
                if (this._delayedHide)
                    this.hideDock();
            },
        });
    }

    _animateOut(time, delay) {
        if (this.dockState === State.HIDDEN)
            return;

        this.dockState = State.HIDING;

        this._slider.ease_property('slide-x', 0, {
            duration: time * 1000,
            delay: delay * 1000,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.dockState = State.HIDDEN;
                this.dash.iconAnimator.pause();
            },
        });
    }

    /**
     * Dwelling system based on the GNOME Shell 3.14 messageTray code: the dock shows when the
     * pointer rests on the screen edge.
     */
    _setupDockDwellIfNeeded() {
        if (this.autohideEnabled) {
            this._dockWatch = Utils.getCursorTracker().connect(
                'position-invalidated',
                () => this._checkDockDwellLater(...global.get_pointer()));
            this._dockDwelling = false;
            this._dockDwellUserTime = 0;
        }
    }

    _checkDockDwellLater(x, y) {
        if (this._checkDockDwellId > 0)
            return;

        this._checkDockDwellId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            DOCK_DWELL_CHECK_INTERVAL, () => {
                this._checkDockDwellNow(x, y);
                this._checkDockDwellId = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    _checkDockDwellNow(x, y) {
        const workArea = Main.layoutManager.getWorkAreaForMonitor(this._monitor.index);
        let shouldDwell;
        // Check for the correct screen edge, extending the sensitive area to the whole workarea,
        // minus 1 px to avoid conflicting with other active corners.
        if (this._position === St.Side.LEFT) {
            shouldDwell = (x === this._monitor.x) && (y > workArea.y) &&
                (y < workArea.y + workArea.height);
        } else if (this._position === St.Side.RIGHT) {
            shouldDwell = (x === this._monitor.x + this._monitor.width - 1) &&
                (y > workArea.y) && (y < workArea.y + workArea.height);
        } else if (this._position === St.Side.TOP) {
            shouldDwell = (y === this._monitor.y) && (x > workArea.x) &&
                (x < workArea.x + workArea.width);
        } else if (this._position === St.Side.BOTTOM) {
            shouldDwell = (y === this._monitor.y + this._monitor.height - 1) &&
                (x > workArea.x) && (x < workArea.x + workArea.width);
        }

        if (shouldDwell) {
            // We only set up dwell timeout when the user is not hovering over the dock
            // already (!this._box.hover).
            // The _dockDwelling variable is used so that we only try to
            // fire off one dock dwell - if it fails (because, say, the user has the mouse down),
            // we don't try again until the user moves the mouse up and down again.
            if (!this._dockDwelling && !this._box.hover && (this._dockDwellTimeoutId === 0)) {
                // Save the interaction timestamp so we can detect user input
                const focusWindow = global.display.focus_window;
                this._dockDwellUserTime = focusWindow ? focusWindow.user_time : 0;

                this._dockDwellTimeoutId = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT,
                    DockManager.settings.showDelay * 1000,
                    this._dockDwellTimeout.bind(this));
                GLib.Source.set_name_by_id(this._dockDwellTimeoutId,
                    '[dash-to-dock] this._dockDwellTimeout');
            }
            this._dockDwelling = true;
        } else {
            this._cancelDockDwell();
            this._dockDwelling = false;
        }
    }

    _cancelDockDwell() {
        if (this._dockDwellTimeoutId !== 0) {
            GLib.source_remove(this._dockDwellTimeoutId);
            this._dockDwellTimeoutId = 0;
        }
    }

    _dockDwellTimeout() {
        this._dockDwellTimeoutId = 0;

        if (!DockManager.settings.autohideInFullscreen &&
            this._monitor.inFullscreen)
            return GLib.SOURCE_REMOVE;

        // We don't want to open the tray when a modal dialog
        // is up, so we check the modal count for that. When we are in the
        // overview we have to take the overview's modal push into account
        if (Main.modalCount > (Main.overview.visible ? 1 : 0))
            return GLib.SOURCE_REMOVE;

        // If the user interacted with the focus window since we started the tray
        // dwell (by clicking or typing), don't activate the message tray
        const focusWindow = global.display.focus_window;
        const currentUserTime = focusWindow ? focusWindow.user_time : 0;
        if (currentUserTime !== this._dockDwellUserTime)
            return GLib.SOURCE_REMOVE;

        this._onEdgeDwelled();
        return GLib.SOURCE_REMOVE;
    }

    _removeDockWatch() {
        if (this._checkDockDwellId > 0) {
            GLib.source_remove(this._checkDockDwellId);
            this._checkDockDwellId = 0;
        }

        if (this._dockWatch) {
            Utils.getCursorTracker().disconnect(this._dockWatch);
            this._dockWatch = null;
        }
    }

    /**
     * handler for the pointer resting on the screen edge
     */
    _onEdgeDwelled() {
        if (Main.overview.visibleTarget)
            return;

        if (this._triggerTimeoutId)
            GLib.source_remove(this._triggerTimeoutId);

        // In case the mouse move away from the dock area before hovering it,
        // in such case the leave event would never be triggered and the dock
        // would stay visible forever.
        this._triggerTimeoutId =  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            const [x, y, mods_] = global.get_pointer();
            let shouldHide = true;
            switch (this._position) {
            case St.Side.LEFT:
                if (x <= this._staticBox.x2 &&
                    x >= this._monitor.x &&
                    y >= this._monitor.y &&
                    y <= this._monitor.y + this._monitor.height)
                    shouldHide = false;

                break;
            case St.Side.RIGHT:
                if (x >= this._staticBox.x1 &&
                    x <= this._monitor.x + this._monitor.width &&
                    y >= this._monitor.y &&
                    y <= this._monitor.y + this._monitor.height)
                    shouldHide = false;

                break;
            case St.Side.TOP:
                if (x >= this._monitor.x &&
                    x <= this._monitor.x + this._monitor.width &&
                    y <= this._staticBox.y2 &&
                    y >= this._monitor.y)
                    shouldHide = false;

                break;
            case St.Side.BOTTOM:
                if (x >= this._monitor.x &&
                    x <= this._monitor.x + this._monitor.width &&
                    y >= this._staticBox.y1 &&
                    y <= this._monitor.y + this._monitor.height)
                    shouldHide = false;
            }
            if (shouldHide) {
                this._triggerTimeoutId = 0;
                this._hoverChanged();
                return GLib.SOURCE_REMOVE;
            } else {
                return GLib.SOURCE_CONTINUE;
            }
        });

        this.showDock();
    }

    _isPrimaryMonitor() {
        return this.monitorIndex === Main.layoutManager.primaryIndex;
    }

    vfunc_map() {
        super.vfunc_map();

        this._bindSettingsChanges();
        this.dash.updateIconSize();

        this._signalsHandler.addWithLabel(Labels.DOCKED_DASH_GLOBAL_SIGNALS, [
            // update when workarea changes, for instance if  other extensions modify the struts
            // (like moving th panel at the bottom)
            global.display,
            'workareas-changed',
            () => this._resetPosition(),
        ]);

        this._resetPosition();
    }

    vfunc_unmap() {
        this._signalsHandler.removeWithLabel(Labels.DOCKED_DASH_GLOBAL_SIGNALS);

        super.vfunc_unmap();
    }

    _resetPosition() {
        const {dockFixed: fixedIsEnabled, dockExtended: extendHeight} = DockManager.settings;

        if (fixedIsEnabled)
            this.add_style_class_name('fixed');
        else
            this.remove_style_class_name('fixed');

        // Note: do not use the workarea coordinates in the direction on which the dock is placed,
        // to avoid a loop [position change -> workArea change -> position change] with
        // fixed dock.
        const workArea = Main.layoutManager.getWorkAreaForMonitor(this.monitorIndex);

        let fraction = DockManager.settings.heightFraction;
        if (extendHeight)
            fraction = 1;
        else if ((fraction < 0) || (fraction > 1))
            fraction = 0.95;

        if (this._isHorizontal) {
            this.width = Math.round(fraction * workArea.width);

            let posY = this._monitor.y;
            if (this._position === St.Side.BOTTOM)
                posY += this._monitor.height;

            this.x = workArea.x + Math.round((1 - fraction) / 2 * workArea.width);
            this.y = posY;

            if (extendHeight) {
                this.dash._container.set_width(this.width);
                this.add_style_class_name('extended');
            } else {
                this.dash._container.set_width(-1);
                this.remove_style_class_name('extended');
            }
        } else {
            this.height = Math.round(fraction * workArea.height);

            let posX = this._monitor.x;
            if (this._position === St.Side.RIGHT)
                posX += this._monitor.width;

            this.x = posX;
            this.y = workArea.y + Math.round((1 - fraction) / 2 * workArea.height);

            if (extendHeight) {
                this.dash._container.set_height(this.height);
                this.add_style_class_name('extended');
            } else {
                this.dash._container.set_height(-1);
                this.remove_style_class_name('extended');
            }
        }
    }

    _updateStaticBox() {
        const x = this.x + this._slider.x -
            (this._position === St.Side.RIGHT ? this._box.width : 0);
        const y = this.y + this._slider.y -
            (this._position === St.Side.BOTTOM ? this._box.height : 0);
        const {width, height} = this._box;
        const geometry = this._staticBoxGeometry;

        if (geometry && geometry.x === x && geometry.y === y &&
            geometry.width === width && geometry.height === height)
            return;

        this._staticBoxGeometry = {x, y, width, height};
        this._staticBox.init_rect(x, y, width, height);

        this._intellihide.updateTargetBox(this._staticBox);
    }

    _removeAnimations() {
        this._slider.remove_all_transitions();
    }

    _onDragStart() {
        this._oldIgnoreHover = this._ignoreHover;
        this._ignoreHover = true;
        this._animateIn(DockManager.settings.animationTime, 0);
    }

    _onDragEnd() {
        if (this._oldIgnoreHover !== undefined) {
            this._ignoreHover = this._oldIgnoreHover;
            delete this._oldIgnoreHover;
        }

        this._box.sync_hover();
        this.updateDashVisibility();
    }

    /**
     * Show dock and give key focus to it
     */
    _onAccessibilityFocus(timestamp) {
        if (!Main.overview.visible)
            global.display.unset_input_focus(timestamp);
        this._box.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        this._animateIn(DockManager.settings.animationTime, 0);
    }

    // Optional features to be enabled only for the main Dock
    _enableExtraFeatures() {
        // Restore dash accessibility
        Main.ctrlAltTabManager.addGroup(
            this.dash, _('Dash'), 'user-bookmarks-symbolic',
            {focusCallback: timestamp => this._onAccessibilityFocus(timestamp)});
    }

    /**
     * Switch workspace by scrolling over the dock
     */
    _enableScrollWorkspaceSwitch() {
        this._signalsHandler.add(this._box, 'scroll-event', (_, e) => onScrollEvent(e));

        // This was inspired to desktop-scroller@obsidien.github.com
        const onScrollEvent = event => {
            // When in overview change workspace only in windows view
            if (Main.overview.visible)
                return false;

            const activeWs = global.workspace_manager.get_active_workspace();
            let direction = null;

            let prevDirection, nextDirection;
            if (global.workspace_manager.layout_columns > global.workspace_manager.layout_rows) {
                prevDirection = Meta.MotionDirection.UP;
                nextDirection = Meta.MotionDirection.DOWN;
            } else {
                prevDirection = Meta.MotionDirection.LEFT;
                nextDirection = Meta.MotionDirection.RIGHT;
            }

            switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
                direction = prevDirection;
                break;
            case Clutter.ScrollDirection.DOWN:
                direction = nextDirection;
                break;
            case Clutter.ScrollDirection.SMOOTH: {
                const [dx_, dy] = event.get_scroll_delta();
                if (dy < 0)
                    direction = prevDirection;
                else if (dy > 0)
                    direction = nextDirection;
            }
                break;
            }

            if (direction) {
                // Prevent scroll events from triggering too many workspace switches
                // by adding a 250ms dead time between each scroll event.
                // Useful on laptops when using a touch pad.

                // During the deadtime do nothing
                if (this._scrollWorkspaceSwitchDeadTimeId) {
                    return false;
                } else {
                    this._scrollWorkspaceSwitchDeadTimeId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT, 250, () => {
                            this._scrollWorkspaceSwitchDeadTimeId = 0;
                        });
                }

                let ws;

                ws = activeWs.get_neighbor(direction);

                if (!Main.wm._workspaceSwitcherPopup) {
                    // Support Workspace Grid extension showing their custom
                    // Grid Workspace Switcher
                    if (global.workspace_manager.workspace_grid !== undefined) {
                        Main.wm._workspaceSwitcherPopup =
                            global.workspace_manager.workspace_grid.getWorkspaceSwitcherPopup();
                    } else {
                        Main.wm._workspaceSwitcherPopup = new WorkspaceSwitcherPopup.WorkspaceSwitcherPopup();
                        this._workspaceSwitcherPopup = Main.wm._workspaceSwitcherPopup;

                        this._signalsHandler.add(Main.wm._workspaceSwitcherPopup, 'destroy', actor => {
                            delete this._workspaceSwitcherPopup;
                            if (Main.wm._workspaceSwitcherPopup === actor)
                                delete Main.wm._workspaceSwitcherPopup;
                        });
                    }
                }
                // Set the actor non reactive, so that it doesn't prevent the
                // clicks events from reaching the dash actor. I can't see a reason
                // why it should be reactive.
                Main.wm._workspaceSwitcherPopup.reactive = false;

                // If Workspace Grid is installed, let them handle the scroll behavior.
                if (global.workspace_manager.workspace_grid !== undefined)
                    ws = global.workspace_manager.workspace_grid.actionMoveWorkspace(direction);
                else
                    Main.wm.actionMoveWorkspace(ws);

                // Do not show workspaceSwitcher in overview
                if (!Main.overview.visible)
                    Main.wm._workspaceSwitcherPopup.display(ws.index());

                return true;
            } else {
                return false;
            }
        };
    }
});

/**
 * Isolate overview to open new windows for inactive apps
 * Note: the future implementation is not fully contained here.
 * Some bits are around in other methods of other classes.
 * This class just take care of enabling/disabling the option.
 */
const WorkspaceIsolation = class DashToDockWorkspaceIsolation {
    constructor() {
        const {settings} = DockManager;

        this._signalsHandler = new Utils.GlobalSignalsHandler();
        this._injectionsHandler = new Utils.InjectionsHandler();

        const updateAllDocks = () => {
            DockManager.allDocks.forEach(dock =>
                dock.dash.resetAppIcons());
            if (settings.isolateWorkspaces ||
                settings.isolateMonitors)
                this._enable.bind(this)();
            else
                this._disable.bind(this)();
        };
        this._signalsHandler.add(
            [settings, 'changed::isolate-workspaces', updateAllDocks],
            [settings, 'changed::workspace-agnostic-urgent-windows', updateAllDocks],
            [settings, 'changed::isolate-monitors', updateAllDocks]
        );

        if (settings.isolateWorkspaces ||
            settings.isolateMonitors)
            this._enable();
    }

    _enable() {
        // ensure I never double-register/inject
        // although it should never happen
        this._disable();

        DockManager.allDocks.forEach(dock => {
            global.display.connectObject('restacked',
                () => dock.dash._queueRedisplay(), dock.dash);
            global.display.connectObject('window-marked-urgent',
                () => dock.dash._queueRedisplay(), dock.dash);
            global.display.connectObject('window-demands-attention',
                () => dock.dash._queueRedisplay(), dock.dash);
            global.window_manager.connectObject('switch-workspace',
                () => dock.dash._queueRedisplay(), dock.dash);

            // This last signal is only needed for monitor isolation, as windows
            // might migrate from one monitor to another without triggering 'restacked'
            if (DockManager.settings.isolateMonitors) {
                global.display.connectObject('window-entered-monitor',
                    () => dock.dash._queueRedisplay(), dock.dash);
            }
        });

        /**
         * here this is the Shell.App
         */
        function IsolatedOverview() {
            // These lines take care of Nautilus for icons on Desktop
            const activeWorkspaceIndex =
                global.workspaceManager.get_active_workspace_index();
            const windows = this.get_windows().filter(w =>
                !w.skipTaskbar && w.get_workspace().index() === activeWorkspaceIndex);

            if (windows.length)
                return Main.activateWindow(windows[0]);
            return this.open_new_window(-1);
        }

        this._injectionsHandler.addWithLabel(Labels.ISOLATION,
            Shell.App.prototype,
            'activate',
            IsolatedOverview);
    }

    _disable() {
        DockManager.allDocks.forEach(dock => {
            global.display.disconnectObject(dock.dash);
            global.window_manager.disconnectObject(dock.dash);
        });
        this._injectionsHandler.removeWithLabel(Labels.ISOLATION);
    }

    destroy() {
        this._disable();
        this._signalsHandler.destroy();
        this._injectionsHandler.destroy();
    }
};

export class DockManager {
    constructor(extension) {
        if (DockManager._singleton)
            throw new Error('DashToDock has been already initialized');
        DockManager._singleton = this;
        this._extension = extension;
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);
        this._methodInjections = new Utils.InjectionsHandler(this);
        this._vfuncInjections = new Utils.VFuncInjectionsHandler(this);
        this._propertyInjections = new Utils.PropertyInjectionsHandler(this);
        this._settings = this._extension.getSettings(
            'org.gnome.shell.extensions.dash-to-dock');
        this._appSwitcherSettings = new Gio.Settings({schema_id: 'org.gnome.shell.app-switcher'});
        this._mapSettingsValues();

        this._iconTheme = new St.IconTheme();

        this._oldDash = Main.overview.isDummy ? null : Main.overview.dash;
        this._signalsHandler.add(this._oldDash, 'destroy', () => (this._oldDash = null));
        this._discreteGpuAvailable = AppDisplay.discreteGpuAvailable;
        this._notificationsMonitor = new AppIcons.NotificationsMonitor();
        this._windowTracker = Shell.WindowTracker.get_default();

        const needsRemoteModel = () =>
            !this._notificationsMonitor.dndMode && this._settings.showIconsEmblems;

        const ensureRemoteModel = () => {
            const shouldHaveRemoteModel = needsRemoteModel();
            if (shouldHaveRemoteModel && !this._remoteModel) {
                this._remoteModel = new AppIcons.LauncherEntryRemoteModel();
                this._appIconsDecorator = new AppIcons.AppIconsDecorator();
            } else if (!shouldHaveRemoteModel) {
                this._remoteModel?.destroy();
                delete this._remoteModel;
                this._appIconsDecorator?.destroy();
                delete this._appIconsDecorator;
            }
        };
        ensureRemoteModel();

        this._signalsHandler.add(this._notificationsMonitor, 'state-changed',
            () => ensureRemoteModel());
        this._signalsHandler.add(this._settings, 'changed::show-icons-emblems',
            () => ensureRemoteModel());

        if (this._discreteGpuAvailable === undefined) {
            const updateDiscreteGpuAvailable = () => {
                const switcherooProxy = global.get_switcheroo_control();
                if (switcherooProxy) {
                    const prop = switcherooProxy.get_cached_property('HasDualGpu');
                    this._discreteGpuAvailable = prop?.unpack() ?? false;
                } else {
                    this._discreteGpuAvailable = false;
                }
            };
            this._signalsHandler.add(global, 'notify::switcheroo-control',
                () => updateDiscreteGpuAvailable());
            updateDiscreteGpuAvailable();
        }

        // Connect relevant signals to the toggling function
        this._bindSettingsChanges();

        this._createLocations();

        /* Array of all the docks created */
        this._allDocks = [];
        this._unredirectInhibited = false;
        this._signalsHandler.add(global.display, 'in-fullscreen-changed',
            () => this._updateUnredirect());
        this._createDocks();

        this._overrideAppMenus();

        // status variable: true when the overview is shown through the dash
        // applications button.
        this._forcedOverview = false;
    }

    static getDefault() {
        return DockManager._singleton;
    }

    static get allDocks() {
        return DockManager.getDefault()._allDocks;
    }

    static get extension() {
        return DockManager.getDefault().extension;
    }

    static get settings() {
        return DockManager.getDefault().settings;
    }

    static get windowTracker() {
        return DockManager.getDefault().windowTracker;
    }

    get extension() {
        return this._extension;
    }

    get settings() {
        return this._settings;
    }

    static get iconTheme() {
        return DockManager.getDefault().iconTheme;
    }

    get iconTheme() {
        return this._iconTheme;
    }

    get windowTracker() {
        return this._windowTracker;
    }

    get fm1Client() {
        return this._fm1Client;
    }

    get remoteModel() {
        return this._remoteModel;
    }

    get mainDock() {
        return this._allDocks[0] ?? null;
    }

    get removables() {
        return this._removables;
    }

    get discreteGpuAvailable() {
        return AppDisplay.discreteGpuAvailable || this._discreteGpuAvailable;
    }

    get notificationsMonitor() {
        return this._notificationsMonitor;
    }

    getDockByMonitor(monitorIndex) {
        return this._allDocks.find(d => d.monitorIndex === monitorIndex);
    }

    // Mounted volumes and devices, and network volumes, are always in the dock.
    _createLocations() {
        this._fm1Client = new Locations.FileManager1Client();
        this._removables = new Locations.Removables();
    }

    _toggle() {
        if (this._toggleLater)
            return;

        this._toggleLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
            delete this._toggleLater;
            this._restoreDash();
            this._deleteDocks();
            this._createDocks();
            this.emit('toggled');
        });
    }

    _mapExternalSetting(settings, key, mappedKey, mapValueFunction, mapUserValueFunction) {
        const camelMappedKey = mappedKey.replace(/-([a-z\d])/g, k => k[1].toUpperCase());

        const dockPropertyDesc = Object.getOwnPropertyDescriptor(this.settings, camelMappedKey);

        if (!dockPropertyDesc)
            throw new Error('Setting %s not found in dock'.format(mappedKey));

        mapUserValueFunction ??= value => value;
        const mappedValue = () => mapValueFunction(settings.get_value(key).recursiveUnpack());
        const dockUserValue = () =>
            mapUserValueFunction(this.settings.get_user_value(mappedKey)?.recursiveUnpack());
        Object.defineProperty(this.settings, camelMappedKey, {
            get: () => dockUserValue() ?? mappedValue() ?? dockPropertyDesc.value,
            set: value => {
                if (mappedValue() === undefined)
                    dockPropertyDesc.value = value;
            },
        });

        this._signalsHandler.addWithLabel(Labels.SETTINGS, settings,
            'changed::%s'.format(key), () => {
                this._signalsHandler.blockWithLabel(Labels.SETTINGS);
                this.settings.emit('changed::%s'.format(mappedKey), mappedKey);
                this._signalsHandler.unblockWithLabel(Labels.SETTINGS);
            });
    }

    _mapSettingsValues() {
        this.settings.settingsSchema.list_keys().forEach(key => {
            const camelKey = key.replace(/-([a-z\d])/g, k => k[1].toUpperCase());
            const updateSetting = () => {
                const schemaKey = this.settings.settingsSchema.get_key(key);
                if (schemaKey.get_range().deepUnpack()[0] === 'enum')
                    this.settings[camelKey] = this.settings.get_enum(key);
                else
                    this.settings[camelKey] = this.settings.get_value(key).recursiveUnpack();
            };
            updateSetting();
            this._signalsHandler.addWithLabel(Labels.SETTINGS, this.settings,
                `changed::${key}`, updateSetting);
            if (key !== camelKey) {
                Object.defineProperty(this.settings, key,
                    {get: () => this.settings[camelKey]});
            }
        });
        Object.defineProperties(this.settings, {
            dockExtended: {get: () => this.settings.extendHeight},
        });
    }

    _bindSettingsChanges() {
        // Connect relevant signals to the toggling function
        this._signalsHandler.addWithLabel(Labels.SETTINGS, [
            Utils.getMonitorManager(),
            'monitors-changed',
            this._toggle.bind(this),
        ], [
            Main.sessionMode,
            'updated',
            this._toggle.bind(this),
        ], [
            this._settings,
            'changed::multi-monitor',
            this._toggle.bind(this),
        ], [
            this._settings,
            'changed::preferred-monitor',
            this._toggle.bind(this),
        ], [
            this._settings,
            'changed::preferred-monitor-by-connector',
            this._toggle.bind(this),
        ], [
            this._settings,
            'changed::dock-position',
            this._toggle.bind(this),
        ], [
            this._settings,
            'changed::extend-height',
            () => this._adjustPanelCorners(),
        ], [
            this._settings,
            'changed::dock-fixed',
            () => this._adjustPanelCorners(),
        ]);

        this._mapExternalSetting(this._appSwitcherSettings, 'current-workspace-only',
            'isolate-workspaces', value => value || undefined);
    }

    _createDocks() {
        // If there are no monitors (headless configurations, but it can also
        // happen temporary while disconnecting and reconnecting monitors), just
        // do nothing. When a monitor will be connected we we'll be notified and
        // and thus create the docks. This prevents pointing trying to access
        // monitors throughout the code, were we are assuming that at least the
        // primary monitor is present.
        if (Main.layoutManager.monitors.length <= 0)
            return;

        this._preferredMonitorIndex = this.settings.preferredMonitor;
        if (this._preferredMonitorIndex === -2) {
            const monitorManager = Utils.getMonitorManager();
            this._preferredMonitorIndex = monitorManager.get_monitor_for_connector(
                this.settings.preferredMonitorByConnector);
        } else if (this._preferredMonitorIndex >= 0) {
            // Primary monitor used to be always 0 in Gdk, but the shell has a different
            // concept (where the order depends on mutter order).
            // So even if now the extension settings may use the same logic of the shell
            // we prefer not to break the previously configured systems, and so we still
            // assume that the gsettings monitor numbering follows the old strategy.
            // This ensure the indexing in the settings and in the shell are matched,
            // i.e. that we start counting from the primaryMonitorIndex
            this._preferredMonitorIndex =
                (Main.layoutManager.primaryIndex + this._preferredMonitorIndex) %
                Main.layoutManager.monitors.length;
        }

        // In case of multi-monitor, we consider the dock on the primary monitor
        // to be the preferred (main) one regardless of the settings the dock
        // goes on the primary monitor also if the settings are inconsistent
        // (e.g. desired monitor not connected).
        if (this.settings.multiMonitor ||
            this._preferredMonitorIndex < 0 ||
            this._preferredMonitorIndex > Main.layoutManager.monitors.length - 1)
            this._preferredMonitorIndex = Main.layoutManager.primaryIndex;

        // First we create the main Dock, to get the extra features to bind to this one
        this._createDock({
            monitorIndex: this._preferredMonitorIndex,
            isMain: true,
        });

        // Make the necessary changes to Main.overview.dash
        this._prepareMainDash();

        // Adjust corners if necessary
        this._adjustPanelCorners();

        if (this.settings.multiMonitor) {
            const nMon = Main.layoutManager.monitors.length;
            for (let iMon = 0; iMon < nMon; iMon++) {
                if (iMon === this._preferredMonitorIndex)
                    continue;

                this._createDock({monitorIndex: iMon});
            }
        }

        // Load optional features. We load *after* the docks are created, since
        // we need to connect the signals to all dock instances.
        this._workspaceIsolation = new WorkspaceIsolation();

        this.emit('docks-ready');
    }

    _createDock(params) {
        const dock = new DockedDash(params);
        this._allDocks.push(dock);

        // connect app icon into the view selector
        dock.dash.showAppsButton.connectObject('notify::checked',
            button => this._onShowAppsButtonToggled(button), dock);

        this._signalsHandler.add([
            dock,
            'notify::dock-state',
            () => this._updateUnredirect(),
        ], [
            dock,
            'notify::visible',
            () => this._updateUnredirect(),
        ]);

        const id = dock.connect('destroy', () => {
            dock.disconnect(id);
            const index = this._allDocks.indexOf(dock);
            if (index !== -1)
                this._allDocks.splice(index, 1);
        });

        return dock;
    }

    _updateUnredirect() {
        const inhibit = this._allDocks.some(d => d.inhibitsUnredirection);
        if (inhibit === this._unredirectInhibited)
            return;

        // Unredirection is refcounted by the compositor, so hold a single
        // reference for all the docks: this way it can't be left unbalanced
        // when docks are destroyed and re-created.
        if (inhibit) {
            Meta.disable_unredirect_for_display?.(global.display);
            global.compositor.disable_unredirect?.();
        } else {
            Meta.enable_unredirect_for_display?.(global.display);
            global.compositor.enable_unredirect?.();
        }

        this._unredirectInhibited = inhibit;
    }

    _runStartupAnimation() {
        DockManager.allDocks.forEach(dock => {
            const {dash} = dock;

            switch (dock.position) {
            case St.Side.LEFT:
                dash.translation_x = -dash.width;
                break;
            case St.Side.RIGHT:
                dash.translation_x = dash.width;
                break;
            case St.Side.BOTTOM:
                dash.translation_y = dash.height;
                break;
            case St.Side.TOP:
                dash.translation_y = -dash.height;
                break;
            }

            dash.ease({
                opacity: 255,
                translation_x: 0,
                translation_y: 0,
                duration: STARTUP_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
    }

    _prepareMainDash() {
        this._propertyInjections.removeWithLabel(Labels.MAIN_DASH);

        // Ensure Main.overview.dash is set to our dash in dummy mode
        // while just use the default getter otherwise.
        if (Main.overview.isDummy) {
            this._propertyInjections.addWithLabel(Labels.MAIN_DASH, Main.overview, 'dash', {
                get: () => this.mainDock.dash,
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
            this.overviewControls.dash = this.mainDock.dash;
            this.searchController._showAppsButton = this.mainDock.dash.showAppsButton;

            // And to return the preferred height depending on the state
            this._methodInjections.addWithLabel(Labels.MAIN_DASH, this._oldDash,
                'get_preferred_height', (_originalMethod, ...args) => {
                    if (this.mainDock.isHorizontal && !this.settings.dockFixed)
                        return this.mainDock.get_preferred_height(...args);
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

        const ControlsManagerLayout = this.overviewControls.layout_manager.constructor;

        const maybeAdjustBoxSize = (state, box, spacing) => {
            // ensure that an undefined value will be converted into a valid one
            spacing = spacing ?? 0;

            if (state === OverviewControls.ControlsState.WINDOW_PICKER) {
                const searchBox = this.overviewControls._searchEntry.get_allocation_box();
                const {shouldShow: wsThumbnails} = this.overviewControls._thumbnailsBox;

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

            if (this.mainDock.isHorizontal || this.settings.dockFixed)
                return box;

            const [, preferredWidth] = this.mainDock.get_preferred_width(
                box.get_height());

            if (this.mainDock.position === St.Side.LEFT)
                box.x1 += preferredWidth;
            else if (this.mainDock.position === St.Side.RIGHT)
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

                const propertyInjections = new Utils.PropertyInjectionsHandler();
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
                if (state === OverviewControls.ControlsState.HIDDEN)
                    return originalFunction.call(this, state, ...args);

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
            this.overviewControls.dash = dummyDash;
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

    _deleteDocks() {
        // Remove extra features
        this._workspaceIsolation?.destroy();

        // Delete all docks
        [...this._allDocks].forEach(d => d.destroy());

        this._updateUnredirect();
    }

    _restoreDash() {
        if (!this._oldDash || this.overviewControls.dash === this._oldDash)
            return;

        this._signalsHandler.removeWithLabel(Labels.OLD_DASH_CHANGES);
        [this._methodInjections, this._vfuncInjections, this._propertyInjections].forEach(
            injections => injections.removeWithLabel(Labels.MAIN_DASH));

        this.overviewControls.layout_manager._dash = this._oldDash;
        this.overviewControls.dash = this._oldDash;
        this.searchController._showAppsButton = this._oldDash.showAppsButton;
        Main.overview.dash.show();
        Main.overview.dash.set_height(-1); // reset default dash size
        // This force the recalculation of the icon size
        Main.overview.dash._maxHeight = -1;
    }

    get overviewControls() {
        return Main.overview._overview.controls;
    }

    get searchController() {
        return this.overviewControls._searchController;
    }

    _onShowAppsButtonToggled(button) {
        const {checked} = button;
        const {overviewControls} = this;

        if (!Main.overview.visible) {
            this.mainDock.dash.showAppsButton._fromDesktop = true;
            Main.overview.show(OverviewControls.ControlsState.APP_GRID);
        } else if (!checked && this.mainDock.dash.showAppsButton._fromDesktop &&
            !this._inCtrlAltTabSwitcher) {
            Main.overview.hide();
            this.mainDock.dash.showAppsButton._fromDesktop = false;
        } else {
            // TODO: I'm not sure how reliable this is, we might need to move the
            // _onShowAppsButtonToggled logic into the extension.
            if (!checked)
                this.mainDock.dash.showAppsButton._fromDesktop = false;

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
                    ? _('Unpin') : __('Pin to Dock');
                /* eslint-enable no-invalid-this */
            });
    }

    destroy() {
        this.emit('destroy');
        if (this._toggleLater) {
            Utils.laterRemove(this._toggleLater);
            delete this._toggleLater;
        }
        this._restoreDash();
        this._deleteDocks();
        this._revertPanelCorners();
        if (this._oldSelectorMargin)
            this.searchController.margin_bottom = this._oldSelectorMargin;
        if (this._fm1Client) {
            this._fm1Client.destroy();
            this._fm1Client = null;
        }
        this._notificationsMonitor.destroy();
        this._removables?.destroy();
        this._removables = null;
        this._iconTheme = null;
        this._remoteModel?.destroy();
        this._appIconsDecorator?.destroy();
        this._settings = null;
        this._appSwitcherSettings = null;
        this._windowTracker = null;
        this._oldDash = null;

        this._extension = null;
        DockManager._singleton = null;
    }

    /**
     * Adjust Panel corners, remove this when 41 won't be supported anymore
     */
    _adjustPanelCorners() {
        if (!this._hasPanelCorners())
            return;

        const position = Utils.getPosition();
        const isHorizontal = (position === St.Side.TOP) || (position === St.Side.BOTTOM);
        const dockOnPrimary  = this._settings.multiMonitor ||
                             this._preferredMonitorIndex === Main.layoutManager.primaryIndex;

        if (!isHorizontal && dockOnPrimary && this.settings.dockExtended && this.settings.dockFixed) {
            Main.panel._rightCorner.hide();
            Main.panel._leftCorner.hide();
        } else {
            this._revertPanelCorners();
        }
    }

    _revertPanelCorners() {
        if (!this._hasPanelCorners())
            return;

        Main.panel._leftCorner.show();
        Main.panel._rightCorner.show();
    }

    _hasPanelCorners() {
        return !!Main.panel?._rightCorner && !!Main.panel?._leftCorner;
    }
}
Signals.addSignalMethods(DockManager.prototype);

// This class drives long-running icon animations, to keep them running in sync
// with each other, and to save CPU by pausing them when the dock is hidden.
export class IconAnimator {
    constructor(actor) {
        this._count = 0;
        this._started = false;
        this._animations = {
            wiggle: [],
        };
        this._timeline = new Clutter.Timeline({
            duration: AnimationUtils.adjustAnimationTime(ICON_ANIMATOR_DURATION) || 1,
            repeat_count: -1,
            actor,
        });

        this._updateSettings();
        this._settingsChangedId = St.Settings.get().connect('notify',
            () => this._updateSettings());

        this._newFrameID = this._timeline.connect('new-frame', () => {
            const progress = this._timeline.get_progress();
            const wiggleRotation = progress < 1 / 6 ? 15 * Math.sin(progress * 24 * Math.PI) : 0;
            const wigglers = this._animations.wiggle;
            for (let i = 0, iMax = wigglers.length; i < iMax; i++)
                wigglers[i].target.rotation_angle_z = wiggleRotation;
        });
    }

    _updateSettings() {
        this._timeline.set_duration(
            AnimationUtils.adjustAnimationTime(ICON_ANIMATOR_DURATION) || 1);
    }

    destroy() {
        St.Settings.get().disconnect(this._settingsChangedId);
        this._timeline.disconnect(this._newFrameID);
        this._timeline.stop();
        delete this._timeline;
        for (const pairs of Object.values(this._animations)) {
            for (let i = 0, iMax = pairs.length; i < iMax; i++) {
                const pair = pairs[i];
                pair.target.disconnect(pair.targetDestroyId);
            }
        }
        this._animations = null;
    }

    pause() {
        if (this._started && this._count > 0)
            this._timeline.stop();

        this._started = false;
    }

    start() {
        if (!this._started && this._count > 0)
            this._timeline.start();

        this._started = true;
    }

    addAnimation(target, name) {
        const targetDestroyId = target.connect('destroy',
            () => this.removeAnimation(target, name));
        this._animations[name].push({target, targetDestroyId});
        if (this._started && this._count === 0)
            this._timeline.start();

        this._count++;
    }

    removeAnimation(target, name) {
        const pairs = this._animations[name];
        for (let i = 0, iMax = pairs.length; i < iMax; i++) {
            const pair = pairs[i];
            if (pair.target === target) {
                target.disconnect(pair.targetDestroyId);
                pairs.splice(i, 1);
                this._count--;
                if (this._started && this._count === 0)
                    this._timeline.stop();

                return;
            }
        }
    }
}

// ---------- Intellihide ----------

// A good compromise between reactivity and efficiency; to be tuned.
const INTELLIHIDE_CHECK_INTERVAL = 100;

const OverlapStatus = Object.freeze({
    UNDEFINED: -1,
    FALSE: 0,
    TRUE: 1,
});

// List of windows type taken into account. Order is important (keep the original
// enum order).
const handledWindowTypes = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DOCK,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.TOOLBAR,
    Meta.WindowType.MENU,
    Meta.WindowType.UTILITY,
    Meta.WindowType.SPLASHSCREEN,
    Meta.WindowType.DROPDOWN_MENU,
];

// List of applications, ignore windows of these applications in considering intellihide
const ignoreApps = ['com.rastersoft.ding', 'com.desktop.ding'];

/**
 * A rough and ugly implementation of the intellihide behaviour.
 * Intallihide object: emit 'status-changed' signal when the overlap of windows
 * with the provided targetBoxClutter.ActorBox changes;
 */
export class Intellihide {
    constructor(monitorIndex) {
        // Load settings
        this._monitorIndex = monitorIndex;

        this._signalsHandler = new Utils.GlobalSignalsHandler();
        this._focusApp = null; // The application whose window is focused.
        this._topApp = null; // The application whose window is on top on the monitor with the dock.

        this._isEnabled = false;
        this._status = OverlapStatus.UNDEFINED;
        this._targetBox = null;

        this._checkOverlapTimeoutContinue = false;
        this._checkOverlapTimeoutId = 0;

        this._trackedWindows = new Map();

        // Connect global signals
        this._signalsHandler.add([
            // Add signals on windows created from now on
            global.display,
            'window-created',
            this._windowCreated.bind(this),
        ], [
            // triggered for instance when the window list order changes,
            // included when the workspace is switched
            global.display,
            'restacked',
            this._checkOverlap.bind(this),
        ], [
            // when windows are alwasy on top, the focus window can change
            // without the windows being restacked. Thus monitor window focus change.
            DockManager.windowTracker,
            'notify::focus-app',
            this._checkOverlap.bind(this),
        ], [
            // update wne monitor changes, for instance in multimonitor when monitor are attached
            Utils.getMonitorManager(),
            'monitors-changed',
            this._checkOverlap.bind(this),
        ]);
    }

    destroy() {
        // Disconnect global signals
        this._signalsHandler.destroy();

        // Remove  residual windows signals
        this.disable();
    }

    enable() {
        this._isEnabled = true;
        this._status = OverlapStatus.UNDEFINED;
        global.get_window_actors().forEach(function (wa) {
            this._addWindowSignals(wa);
        }, this);
        this._doCheckOverlap();
    }

    disable() {
        this._isEnabled = false;

        for (const wa of this._trackedWindows.keys())
            this._removeWindowSignals(wa);

        this._trackedWindows.clear();

        if (this._checkOverlapTimeoutId > 0) {
            GLib.source_remove(this._checkOverlapTimeoutId);
            this._checkOverlapTimeoutId = 0;
        }
    }

    _windowCreated(display, metaWindow) {
        this._addWindowSignals(metaWindow.get_compositor_private());
        this._doCheckOverlap();
    }

    _addWindowSignals(wa) {
        if (!this._handledWindow(wa))
            return;

        this._trackedWindows.set(wa, [
            wa.connect('notify::allocation', () => this._checkOverlap()),
            wa.connect('destroy', () => this._removeWindowSignals(wa)),
        ]);
    }

    _removeWindowSignals(wa) {
        const signalIds = this._trackedWindows.get(wa);
        if (signalIds) {
            signalIds.forEach(id => wa.disconnect(id));
            this._trackedWindows.delete(wa);
        }
    }

    updateTargetBox(box) {
        this._targetBox = box;
        this._checkOverlap();
    }

    forceUpdate() {
        this._status = OverlapStatus.UNDEFINED;
        this._doCheckOverlap();
    }

    getOverlapStatus() {
        return this._status === OverlapStatus.TRUE;
    }

    _checkOverlap() {
        if (!this._isEnabled || !this._targetBox)
            return;

        /* Limit the number of calls to the doCheckOverlap function */
        if (this._checkOverlapTimeoutId) {
            this._checkOverlapTimeoutContinue = true;
            return;
        }

        this._doCheckOverlap();

        this._checkOverlapTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, INTELLIHIDE_CHECK_INTERVAL, () => {
                this._doCheckOverlap();
                if (this._checkOverlapTimeoutContinue) {
                    this._checkOverlapTimeoutContinue = false;
                    return GLib.SOURCE_CONTINUE;
                } else {
                    this._checkOverlapTimeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                }
            });
    }

    _doCheckOverlap() {
        if (!this._isEnabled || !this._targetBox)
            return;

        let overlaps = OverlapStatus.FALSE;
        let windows = global.get_window_actors().filter(wa => this._handledWindow(wa));

        if (windows.length > 0) {
            /*
             * Get the top window on the monitor where the dock is placed.
             * The idea is that we dont want to overlap with the windows of the topmost application,
             * event is it's not the focused app -- for instance because in multimonitor the user
             * select a window in the secondary monitor.
             */

            let topWindow = null;
            for (let i = windows.length - 1; i >= 0; i--) {
                const metaWin = windows[i].get_meta_window();
                if (metaWin.get_monitor() === this._monitorIndex) {
                    topWindow = metaWin;
                    break;
                }
            }

            if (topWindow) {
                const {windowTracker} = DockManager;
                this._topApp = windowTracker.get_window_app(topWindow);
                // If there isn't a focused app, use that of the window on top
                this._focusApp = windowTracker.focus_app || this._topApp;

                windows = windows.filter(this._intellihideFilterInteresting, this);

                for (let i = 0;  i < windows.length; i++) {
                    const win = windows[i].get_meta_window();

                    if (win) {
                        const rect = win.get_frame_rect();

                        const test = (rect.x < this._targetBox.x2) &&
                                   (rect.x + rect.width > this._targetBox.x1) &&
                                   (rect.y < this._targetBox.y2) &&
                                   (rect.y + rect.height > this._targetBox.y1);

                        if (test) {
                            overlaps = OverlapStatus.TRUE;
                            break;
                        }
                    }
                }
            }
        }

        if (this._status !== overlaps) {
            this._status = overlaps;
            this.emit('status-changed', this._status);
        }
    }

    // Filter interesting windows to be considered for intellihide.
    // Consider all windows visible on the current workspace.
    // Optionally skip windows of other applications
    _intellihideFilterInteresting(wa) {
        const metaWin = wa.get_meta_window();
        const currentWorkspace = global.workspace_manager.get_active_workspace_index();
        const workspace = metaWin.get_workspace();
        const workspaceIndex = workspace.index();

        // Skip windows of other apps
        if (this._focusApp) {
            // The DropDownTerminal extension is not an application per se
            // so we match its window by wm class instead
            if (metaWin.get_wm_class() === 'DropDownTerminalWindow')
                return true;

            const {windowTracker} = DockManager;
            const currentApp = windowTracker.get_window_app(metaWin);
            const focusWindow = global.display.get_focus_window();

            // Consider half maximized windows side by side
            // and windows which are alwayson top
            if (currentApp !== this._focusApp && currentApp !== this._topApp &&
                !((focusWindow && focusWindow.maximized_vertically &&
                   !focusWindow.maximized_horizontally) &&
                 (metaWin.maximized_vertically && !metaWin.maximized_horizontally) &&
                 metaWin.get_monitor() === focusWindow.get_monitor()) &&
                    !metaWin.is_above())
                return false;
        }

        if (workspaceIndex === currentWorkspace && metaWin.showing_on_its_workspace())
            return true;
        else
            return false;
    }

    // Filter windows by type
    // inspired by Opacify@gnome-shell.localdomain.pl
    _handledWindow(wa) {
        const metaWindow = wa.get_meta_window();

        if (!metaWindow)
            return false;

        // The DING extension desktop window needs to be excluded
        // so we match its window by application id and window property.
        const wmApp = metaWindow.get_gtk_application_id();
        if (ignoreApps.includes(wmApp) && metaWindow.is_skip_taskbar())
            return false;

        // The DropDownTerminal extension uses the POPUP_MENU window type hint
        // so we match its window by wm class instead
        if (metaWindow.get_wm_class() === 'DropDownTerminalWindow')
            return true;

        const wtype = metaWindow.get_window_type();
        for (let i = 0; i < handledWindowTypes.length; i++) {
            const hwtype = handledWindowTypes[i];
            if (hwtype === wtype)
                return true;
            else if (hwtype > wtype)
                return false;
        }
        return false;
    }
}

Signals.addSignalMethods(Intellihide.prototype);

// ---------- Theming ----------

export const PositionStyleClass = Object.freeze([
    'top',
    'right',
    'bottom',
    'left',
]);

/**
 * Keeps the dock's style classes up to date. The dock has no colors of its own: it shows
 * GNOME's style, with the dash's border copied to the side it is missing.
 */
export class ThemeManager {
    constructor(dock) {
        this._signalsHandler = new Utils.GlobalSignalsHandler(this);
        this._bindSettingsChanges();
        this._actor = dock;
        this._dash = dock.dash;

        this._signalsHandler.add([
            // update :overview pseudoclass
            Main.overview,
            'showing',
            this._onOverviewShowing.bind(this),
        ], [
            Main.overview,
            'hiding',
            this._onOverviewHiding.bind(this),
        ]);

        this._signalsHandler.addWithLabel(Labels.THEME_CHANGED,
            St.ThemeContext.get_for_stage(global.stage), 'changed',
            () => this._queueUpdateCustomTheme(),
            Utils.SignalsHandlerFlags.CONNECT_AFTER);

        const maybeUpdateCustomTheme = () => {
            if (this._actor.mapped) {
                this._signalsHandler.unblockWithLabel(Labels.THEME_CHANGED);
                this._queueUpdateCustomTheme();
            } else {
                this._dequeueUpdateCustomTheme();
                this._signalsHandler.blockWithLabel(Labels.THEME_CHANGED);
            }
        };

        this._signalsHandler.add(this._actor, 'notify::mapped',
            () => maybeUpdateCustomTheme(),
            Utils.SignalsHandlerFlags.CONNECT_AFTER);

        maybeUpdateCustomTheme();

        // Set the initial overview pseudo-class state.
        if (Main.overview.visible)
            this._onOverviewShowing();
        else
            this._onOverviewHiding();

        // destroy themeManager when the managed actor is destroyed (e.g. extension unload)
        // in order to disconnect signals
        this._signalsHandler.add(this._actor, 'destroy', () => this.destroy());
    }

    destroy() {
        this.emit('destroy');
        this._dequeueUpdateCustomTheme();
    }

    _queueUpdateCustomTheme() {
        if (this._updateLater)
            return;

        this._updateLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
            this._updateLater = 0;
            this.updateCustomTheme();
        });
    }

    _dequeueUpdateCustomTheme() {
        if (!this._updateLater)
            return;

        Utils.laterRemove(this._updateLater);
        delete this._updateLater;
    }

    _onOverviewShowing() {
        this._actor.add_style_pseudo_class('overview');
    }

    _onOverviewHiding() {
        this._actor.remove_style_pseudo_class('overview');
    }

    _updateCustomStyleClasses() {
        const {settings} = DockManager;

        if (settings.runningIndicatorStyle !== 0)
            this._actor.add_style_class_name('running-dots');
        else
            this._actor.remove_style_class_name('running-dots');

        if (settings.forceStraightCorner)
            this._actor.add_style_class_name('straight-corner');
        else
            this._actor.remove_style_class_name('straight-corner');

        if (settings.transparentBackground)
            this._actor.add_style_class_name('transparent-background');
        else
            this._actor.remove_style_class_name('transparent-background');
    }

    updateCustomTheme() {
        if (!this._actor.mapped)
            return;

        this._updateCustomStyleClasses();
        this._adjustTheme();
        this.emit('updated');
    }

    /**
     * Reimported back and adapted from atomdock
     */
    _adjustTheme() {
        const {settings} = DockManager;

        // Remove prior style edits
        this._dash._background.set_style(null);

        const position = Utils.getPosition(settings);

        // obtain theme border settings
        const themeNode = this._dash._background.get_theme_node();
        const borderColor = themeNode.get_border_color(St.Side.TOP);
        const borderWidth = themeNode.get_border_width(St.Side.TOP);

        // We're copying border and corner styles to left border and top-left
        // corner, also removing bottom border and bottom-right corner styles
        let borderMissingStyle = '';

        if (this._rtl && (position !== St.Side.RIGHT)) {
            borderMissingStyle = `border-right: ${borderWidth}px solid ${
                borderColor.to_string()};`;
        } else if (!this._rtl && (position !== St.Side.LEFT)) {
            borderMissingStyle = `border-left: ${borderWidth}px solid ${
                borderColor.to_string()};`;
        }

        if (borderMissingStyle)
            this._dash._background.set_style(borderMissingStyle);
    }

    _bindSettingsChanges() {
        const keys = [
            'running-indicator-style',
            'extend-height',
            'force-straight-corner',
            'transparent-background',
        ];

        this._signalsHandler.addWithLabel(Labels.THEME_CHANGED, ...keys.map(key => [
            DockManager.settings,
            `changed::${key}`,
            () => this.updateCustomTheme(),
        ]));
    }
}
Signals.addSignalMethods(ThemeManager.prototype);

// ---------- Extension ----------

// We export this so it can be accessed by other extensions
export let dockManager;

export default class DashToDockExtension extends Extension.Extension {
    enable() {
        // TODO: Remove this when upstream will disable extensions on shutdown
        // See: https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/4214
        this._shutdownID = global.connect('shutdown', () => this.disable());
        dockManager = new DockManager(this);
    }

    disable() {
        global.disconnect(this._shutdownID);
        delete this._shutdownID;
        dockManager?.destroy();
        dockManager = null;
    }
}
