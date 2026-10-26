// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DockManager} from './dock/manager.js';

// The extension: it only creates the dock manager, which does the rest.
export default class DockManagerExtension extends Extension {
    enable() {
        // TODO: Remove this when upstream will disable extensions on shutdown
        // See: https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/4214
        this._shutdownID = global.connect('shutdown', () => this.disable());
        this._dockManager = new DockManager(this);
    }

    disable() {
        global.disconnect(this._shutdownID);
        delete this._shutdownID;
        this._dockManager?.destroy();
        this._dockManager = null;
    }
}
