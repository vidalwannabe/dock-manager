// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Panel from 'resource:///org/gnome/shell/ui/panel.js';

import {GlobalSignalsHandler, PropertyInjectionsHandler, VFuncInjectionsHandler} from '../handlers.js';
import {DockedDash, STARTUP_ANIMATION_TIME} from './dockedDash.js';
import {MonitorIsolation} from './monitorIsolation.js';
import {OverviewIntegration} from './overview.js';
import {OverviewZoom} from './overviewZoom.js';

const {signals: Signals} = imports;

const Labels = Object.freeze({
    SETTINGS: Symbol('settings'),
});

export class DockManager {
    constructor(extension) {
        if (DockManager._singleton)
            throw new Error('DockManager has been already initialized');
        DockManager._singleton = this;
        this._extension = extension;
        this._signalsHandler = new GlobalSignalsHandler(this);
        this._settings = this._extension.getSettings(
            'org.gnome.shell.extensions.dock-manager');
        this._mapSettingsValues();

        this._iconTheme = new St.IconTheme();

        this._overview = new OverviewIntegration(this);
        this._overviewZoom = new OverviewZoom();
        this._windowTracker = Shell.WindowTracker.get_default();
        this._vfuncInjections = new VFuncInjectionsHandler();
        this._centerPanelOnMonitor();

        // Connect relevant signals to the toggling function
        this._bindSettingsChanges();

        /* Array of all the docks created */
        this._allDocks = [];
        this._unredirectInhibited = false;
        this._signalsHandler.add(global.display, 'in-fullscreen-changed',
            () => this._updateUnredirect());
        this._createDocks();
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

    get overviewZoom() {
        return this._overviewZoom;
    }

    get mainDock() {
        return this._allDocks[0] ?? null;
    }

    getDockByMonitor(monitorIndex) {
        return this._allDocks.find(d => d.monitorIndex === monitorIndex);
    }

    _toggle() {
        if (this._toggleLater)
            return;

        this._toggleLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            delete this._toggleLater;
            this._overview.restore();
            this._deleteDocks();
            this._createDocks();
            this.emit('toggled');
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
            global.backend.get_monitor_manager(),
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
        ]);
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
            const monitorManager = global.backend.get_monitor_manager();
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
        this._overview.prepare();

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
        this._monitorIsolation = new MonitorIsolation();

        this.emit('docks-ready');
    }

    _createDock(params) {
        const dock = new DockedDash(params);
        this._allDocks.push(dock);

        // connect app icon into the view selector
        dock.dash.showAppsButton.connectObject('notify::checked',
            button => this._overview.onShowAppsButtonToggled(button), dock);

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

    // GNOME centers the top bar's clock on the work area, so a fixed dock, which takes a strip
    // of it on the left or right, pushes the clock off the monitor's center. While the top bar
    // lays itself out, the work area is the whole monitor.
    _centerPanelOnMonitor() {
        this._vfuncInjections.add(Panel.Panel.prototype, 'allocate', function (box) {
            /* eslint-disable no-invalid-this */
            const {layoutManager} = Main;
            const propertyInjections = new PropertyInjectionsHandler();
            propertyInjections.add(layoutManager, 'getWorkAreaForMonitor',
                {value: index => layoutManager.monitors[index]});
            try {
                this.vfunc_allocate(box);
            } finally {
                propertyInjections.destroy();
            }
            /* eslint-enable no-invalid-this */
        });
        Main.panel.queue_relayout();
    }

    _deleteDocks() {
        // Remove extra features
        this._monitorIsolation?.destroy();

        // Delete all docks
        [...this._allDocks].forEach(d => d.destroy());

        this._updateUnredirect();
    }

    destroy() {
        this.emit('destroy');
        if (this._toggleLater) {
            global.compositor.get_laters().remove(this._toggleLater);
            delete this._toggleLater;
        }
        this._overviewZoom.destroy();
        this._overviewZoom = null;
        this._overview.destroy();
        this._overview = null;
        this._vfuncInjections.destroy();
        this._vfuncInjections = null;
        Main.panel.queue_relayout();
        this._deleteDocks();
        this._iconTheme = null;
        this._settings = null;
        this._windowTracker = null;

        this._extension = null;
        DockManager._singleton = null;
    }

}
Signals.addSignalMethods(DockManager.prototype);
