// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {GlobalSignalsHandler} from '../handlers.js';
import {DockManager} from './manager.js';

/**
 * Redisplays the docks when windows change monitor, while monitors are isolated.
 */
export const MonitorIsolation = class MonitorIsolation {
    constructor() {
        const {settings} = DockManager;

        this._signalsHandler = new GlobalSignalsHandler();

        const updateAllDocks = () => {
            DockManager.allDocks.forEach(dock =>
                dock.dash.resetAppIcons());
            if (settings.isolateMonitors)
                this._enable();
            else
                this._disable();
        };
        this._signalsHandler.add(settings, 'changed::isolate-monitors', updateAllDocks);

        if (settings.isolateMonitors)
            this._enable();
    }

    _enable() {
        // ensure I never double-register/inject
        // although it should never happen
        this._disable();

        // Windows might migrate from one monitor to another without triggering 'restacked'
        DockManager.allDocks.forEach(dock => {
            global.display.connectObject(
                'restacked', () => dock.dash._queueRedisplay(),
                'window-entered-monitor', () => dock.dash._queueRedisplay(),
                dock.dash);
        });
    }

    _disable() {
        DockManager.allDocks.forEach(dock => global.display.disconnectObject(dock.dash));
    }

    destroy() {
        this._disable();
        this._signalsHandler.destroy();
    }
};
