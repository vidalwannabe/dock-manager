// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {GlobalSignalsHandler} from '../handlers.js';
import {DockDash} from './dash.js';
import {Intellihide} from './intellihide.js';
import {DockManager} from './manager.js';
import {PositionStyleClass, ThemeManager} from './theme.js';

const {signals: Signals} = imports;

const Labels = Object.freeze({
    INITIALIZE: Symbol('initialize'),
    STARTUP_ANIMATION: Symbol('startup-animation'),
    DOCKED_DASH_GLOBAL_SIGNALS: Symbol('docked-dash-global-signals'),
});

const DOCK_DWELL_CHECK_INTERVAL = 100;
export const STARTUP_ANIMATION_TIME = 500;

// Share of the screen edge the dock may take, when it is not extended.
const DOCK_SIZE_FRACTION = 0.9;

export const State = Object.freeze({
    HIDDEN:  0,
    SHOWING: 1,
    SHOWN:   2,
    HIDING:  3,
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
            this._signalsHandler = new GlobalSignalsHandler(this);
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

export const DockedDash = GObject.registerClass({
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
}, class DockedDash extends St.Bin {
    _init(params) {
        this._position = DockManager.settings.dockPosition;

        // This is the centering actor. Its style classes name its side and its axis
        // (horizontal or vertical): the stylesheet sets what both sides of an axis share once.
        const isHorizontal = (this._position === St.Side.TOP) || (this._position === St.Side.BOTTOM);
        super._init({
            ...params,
            name: 'dockManagerContainer',
            reactive: false,
            style_class: `${PositionStyleClass[this._position]} ${isHorizontal ? 'horizontal' : 'vertical'}`,
        });

        // Load settings
        const {settings} = DockManager;
        this._isHorizontal = isHorizontal;

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
        this.dash = new DockDash(this.monitorIndex);

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
            name: 'dockManagerBox',
            reactive: true,
            track_hover: true,
        });
        this._box.connect('notify::hover', this._hoverChanged.bind(this));

        // Connect global signals
        this._signalsHandler = new GlobalSignalsHandler(this);
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
        delete this._staticBox;

        if (this._marginLater) {
            global.compositor.get_laters().remove(this._marginLater);
            delete this._marginLater;
        }

        if (this._triggerTimeoutId)
            GLib.source_remove(this._triggerTimeoutId);

        this._removeDockWatch();
        this._cancelDockDwell();

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
            'changed::dock-fixed',
            () => {
                this._untrackDock();
                this._trackDock();

                this._updateEdgeDwell();
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
        if (DockManager.settings.dockFixed) {
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
            },
        });
    }

    /**
     * Dwelling system based on the GNOME Shell 3.14 messageTray code: the dock shows when the
     * pointer rests on the screen edge.
     */
    _setupDockDwellIfNeeded() {
        if (this.autohideEnabled) {
            this._dockWatch = global.backend.get_cursor_tracker().connect(
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
                    '[dock-manager] this._dockDwellTimeout');
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
            global.backend.get_cursor_tracker().disconnect(this._dockWatch);
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

        const fraction = extendHeight ? 1 : DOCK_SIZE_FRACTION;

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

});
