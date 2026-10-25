// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Meta,
    St,
} from './dependencies/gi.js';

import {Main} from './dependencies/shell/ui.js';

import {
    Docking,
    Utils,
} from './imports.js';

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
        const {settings} = Docking.DockManager;

        if (settings.runningIndicatorStyle !== 0)
            this._actor.add_style_class_name('running-dots');
        else
            this._actor.remove_style_class_name('running-dots');

        if (settings.forceStraightCorner)
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

    /**
     * Reimported back and adapted from atomdock
     */
    _adjustTheme() {
        const {settings} = Docking.DockManager;

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
        ];

        this._signalsHandler.addWithLabel(Labels.THEME_CHANGED, ...keys.map(key => [
            Docking.DockManager.settings,
            `changed::${key}`,
            () => this.updateCustomTheme(),
        ]));
    }
}
Signals.addSignalMethods(ThemeManager.prototype);
