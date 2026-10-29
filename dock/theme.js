// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {GlobalSignalsHandler, SignalsHandlerFlags} from '../handlers.js';
import {DockManager} from './manager.js';

const {signals: Signals} = imports;

const Labels = Object.freeze({
    THEME_CHANGED: Symbol('theme-changed'),
});

export const PositionStyleClass = Object.freeze([
    'top',
    'right',
    'bottom',
    'left',
]);

/**
 * Keeps the dock's style classes up to date. The dock has no colors or borders of its own:
 * it shows GNOME's style, and whatever other extensions add to it.
 */
export class ThemeManager {
    constructor(dock) {
        this._signalsHandler = new GlobalSignalsHandler(this);
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
            SignalsHandlerFlags.CONNECT_AFTER);

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
            SignalsHandlerFlags.CONNECT_AFTER);

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

        this._updateLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._updateLater = 0;
            this.updateCustomTheme();
        });
    }

    _dequeueUpdateCustomTheme() {
        if (!this._updateLater)
            return;

        global.compositor.get_laters().remove(this._updateLater);
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

        // An extended dock reaches the screen corners, so its own corners are straight.
        if (settings.dockExtended)
            this._actor.add_style_class_name('straight-corner');
        else
            this._actor.remove_style_class_name('straight-corner');
    }

    updateCustomTheme() {
        if (!this._actor.mapped)
            return;

        this._updateCustomStyleClasses();
        this._adjustTheme();
        this.emit('updated');
    }

    // Puts the dock at its distance from the screen edge.
    _adjustTheme() {
        const {settings} = DockManager;
        const position = settings.dockPosition;

        // The gap to the screen edge goes on the whole dash, so its background and icons
        // move together: on the background alone, the icons would stay behind.
        // The extended dock has a distance of its own.
        const distance = settings.dockExtended
            ? settings.extendedScreenEdgeDistance : settings.screenEdgeDistance;
        this._dash.set_style(`margin-${PositionStyleClass[position]}: ${distance}px;`);
    }

    _bindSettingsChanges() {
        const keys = [
            'extend-height',
            'screen-edge-distance',
            'extended-screen-edge-distance',
        ];

        this._signalsHandler.addWithLabel(Labels.THEME_CHANGED, ...keys.map(key => [
            DockManager.settings,
            `changed::${key}`,
            () => this.updateCustomTheme(),
        ]));
    }
}
Signals.addSignalMethods(ThemeManager.prototype);
