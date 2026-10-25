/*
 * Credits:
 * This file is based on code from the Dash to Panel extension by Jason DeRose
 * and code from the Taskbar extension by Zorin OS
 * Some code was also adapted from the upstream Gnome Shell source code.
 */

import {
    Clutter,
    GLib,
    GObject,
    Meta,
    St,
} from './dependencies/gi.js';

import {
    Main,
    PopupMenu,
    Workspace,
} from './dependencies/shell/ui.js';

import {
    Docking,
    Theming,
    Utils,
} from './imports.js';

const PREVIEW_MAX_WIDTH = 250;
const PREVIEW_MAX_HEIGHT = 150;

const PREVIEW_ANIMATION_DURATION = 250;
const MAX_PREVIEW_GENERATION_ATTEMPTS = 15;

export const WindowPreviewMenuItem = GObject.registerClass(
class WindowPreviewMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(window, position, params) {
        super._init(params);

        this._window = window;
        this._destroyId = 0;
        this._windowAddedId = 0;

        // We don't want this: it adds spacing on the left of the item.
        this.remove_child(this._ornamentIcon);
        this.add_style_class_name('dashtodock-app-well-preview-menu-item');
        this.add_style_class_name(Theming.PositionStyleClass[position]);

        // Now we don't have to set PREVIEW_MAX_WIDTH and PREVIEW_MAX_HEIGHT as
        // preview size - that made all kinds of windows either stretched or
        // squished (aspect ratio problem)
        this._cloneBin = new St.Bin();

        this._updateWindowPreviewSize();

        // TODO: improve the way the closebutton is layout. Just use some padding
        // for the moment.
        this._cloneBin.set_style('padding-bottom: 0.5em');

        const buttonLayout = Meta.prefs_get_button_layout();
        this.closeButton = new St.Button({
            style_class: 'window-close',
            opacity: 0,
            x_expand: true,
            y_expand: true,
            x_align: buttonLayout.left_buttons.includes(Meta.ButtonFunction.CLOSE)
                ? Clutter.ActorAlign.START : Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        Utils.addActor(this.closeButton, new St.Icon({icon_name: 'window-close-symbolic'}));
        this.closeButton.connect('clicked', () => this._closeWindow());

        const overlayGroup = new Clutter.Actor({
            layout_manager: new Clutter.BinLayout(),
            y_expand: true,
        });

        overlayGroup.add_child(this._cloneBin);
        overlayGroup.add_child(this.closeButton);

        const label = new St.Label({text: window.get_title()});
        label.set_style(`max-width: ${PREVIEW_MAX_WIDTH}px`);
        const labelBin = new St.Bin({
            child: label,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._windowTitleId = this._window.connect('notify::title', () => {
            label.set_text(this._window.get_title());
        });

        const box = new St.BoxLayout({
            reactive: true,
            x_expand: true,
        });

        if (box.orientation !== undefined)
            box.orientation = Clutter.Orientation.VERTICAL;
        else
            box.vertical = true;

        if (box.add) {
            box.add(overlayGroup);
            box.add(labelBin);
        } else {
            box.add_child(overlayGroup);
            box.add_child(labelBin);
        }
        this._box = box;
        this.add_child(box);

        this._cloneTexture(window);

        this.connect('destroy', this._onDestroy.bind(this));
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();

        // For some crazy clutter / St reason we can't just have this handled
        // automatically or here via vfunc_allocate + vfunc_get_preferred_*
        // because if we do so, the St paddings on first / last child are lost
        const themeNode = this.get_theme_node();
        let [minWidth, naturalWidth] = this._box.get_preferred_width(-1);
        let [minHeight, naturalHeight] = this._box.get_preferred_height(naturalWidth);
        [minWidth, naturalWidth] = themeNode.adjust_preferred_width(minWidth, naturalWidth);
        [minHeight, naturalHeight] = themeNode.adjust_preferred_height(minHeight, naturalHeight);
        this.set({minWidth, naturalWidth, minHeight, naturalHeight});
    }

    _getWindowPreviewSize() {
        const emptySize = [0, 0, 0];

        const mutterWindow = this._window.get_compositor_private();
        if (!mutterWindow?.get_texture())
            return emptySize;

        const [width, height] = mutterWindow.get_size();
        if (!width || !height)
            return emptySize;

        let {previewSizeScale: scale} = Docking.DockManager.settings;
        if (!scale) {
            // a simple example with 1680x1050:
            // * 250/1680 = 0,1488
            // * 150/1050 = 0,1429
            // => scale is 0,1429
            scale = Math.min(1.0, PREVIEW_MAX_WIDTH / width, PREVIEW_MAX_HEIGHT / height);
        }

        scale *= St.ThemeContext.get_for_stage(global.stage).scaleFactor;

        // width and height that we wanna multiply by scale
        return [width, height, scale];
    }

    _updateWindowPreviewSize() {
        // This gets the actual windows size for the preview
        [this._width, this._height, this._scale] = this._getWindowPreviewSize();
        this._cloneBin.set_size(this._width * this._scale, this._height * this._scale);
    }

    _cloneTexture(metaWin) {
        // Newly-created windows are added to a workspace before
        // the compositor finds out about them...
        if (!this._width || !this._height) {
            this._cloneTextureLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
                // Check if there's still a point in getting the texture,
                // otherwise this could go on indefinitely
                this._updateWindowPreviewSize();

                if (this._width && this._height) {
                    this._cloneTexture(metaWin);
                } else {
                    this._cloneAttempt = (this._cloneAttempt || 0) + 1;
                    if (this._cloneAttempt < MAX_PREVIEW_GENERATION_ATTEMPTS)
                        return GLib.SOURCE_CONTINUE;
                }
                delete this._cloneTextureLater;
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        const mutterWindow = metaWin.get_compositor_private();
        const clone = new Clutter.Clone({
            source: mutterWindow,
            reactive: true,
            width: this._width * this._scale,
            height: this._height * this._scale,
        });

        // when the source actor is destroyed, i.e. the window closed, first destroy the clone
        // and then destroy the menu item (do this animating out)
        this._destroyId = mutterWindow.connect('destroy', () => {
            clone.destroy();
            this._destroyId = 0; // avoid to try to disconnect this signal from mutterWindow in _onDestroy(),
            // as the object was just destroyed
            this._animateOutAndDestroy();
        });

        this._clone = clone;
        this._mutterWindow = mutterWindow;
        this._cloneBin.set_child(this._clone);

        this._clone.connect('destroy', () => {
            if (this._destroyId) {
                mutterWindow.disconnect(this._destroyId);
                this._destroyId = 0;
            }
            this._clone = null;
        });
    }

    _windowCanClose() {
        return this._window.can_close() &&
               !this._hasAttachedDialogs();
    }

    _closeWindow() {
        this._workspace = this._window.get_workspace();

        // This mechanism is copied from the workspace.js upstream code
        // It forces window activation if the windows don't get closed,
        // for instance because asking user confirmation, by monitoring the opening of
        // such additional confirmation window
        this._windowAddedId = this._workspace.connect('window-added',
            this._onWindowAdded.bind(this));

        this.deleteAllWindows();
    }

    deleteAllWindows() {
        // Delete all windows, starting from the bottom-most (most-modal) one
        // let windows = this._window.get_compositor_private().get_children();
        const windows = this._clone.get_children();
        for (let i = windows.length - 1; i >= 1; i--) {
            const realWindow = windows[i].source;
            const metaWindow = realWindow.meta_window;

            metaWindow.delete(global.get_current_time());
        }

        this._window.delete(global.get_current_time());
    }

    _onWindowAdded(workspace, win) {
        const metaWindow = this._window;

        if (win.get_transient_for() === metaWindow) {
            workspace.disconnect(this._windowAddedId);
            this._windowAddedId = 0;

            // use an idle handler to avoid mapping problems -
            // see comment in Workspace._windowAdded
            const activationEvent = Clutter.get_current_event();
            this._windowAddedLater = Utils.laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
                delete this._windowAddedLater;
                this.emit('activate', activationEvent);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _hasAttachedDialogs() {
        // count transient windows
        let n = 0;
        this._window.foreach_transient(() => {
            n++;
        });
        return n > 0;
    }

    vfunc_key_focus_in() {
        super.vfunc_key_focus_in();
        this._showCloseButton();
    }

    vfunc_key_focus_out() {
        super.vfunc_key_focus_out();
        this._hideCloseButton();
    }

    vfunc_enter_event(crossingEvent) {
        this._showCloseButton();
        return super.vfunc_enter_event(crossingEvent);
    }

    vfunc_leave_event(crossingEvent) {
        this._hideCloseButton();
        return super.vfunc_leave_event(crossingEvent);
    }

    _idleToggleCloseButton() {
        this._idleToggleCloseId = 0;

        this._hideCloseButton();

        return GLib.SOURCE_REMOVE;
    }

    _showCloseButton() {
        if (this._windowCanClose()) {
            this.closeButton.show();
            this.closeButton.remove_all_transitions();
            this.closeButton.ease({
                opacity: 255,
                duration: Workspace.WINDOW_OVERLAY_FADE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _hideCloseButton() {
        if (this.closeButton.has_pointer ||
            this.get_children().some(a => a.has_pointer))
            return;

        this.closeButton.remove_all_transitions();
        this.closeButton.ease({
            opacity: 0,
            duration: Workspace.WINDOW_OVERLAY_FADE_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    show(animate) {
        const fullWidth = this.get_width();

        this.opacity = 0;
        this.set_width(0);

        const time = animate ? PREVIEW_ANIMATION_DURATION : 0;
        this.remove_all_transitions();
        this.ease({
            opacity: 255,
            width: fullWidth,
            duration: time,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
        });
    }

    _animateOutAndDestroy() {
        this.remove_all_transitions();
        this.ease({
            opacity: 0,
            duration: PREVIEW_ANIMATION_DURATION,
        });

        this.ease({
            width: 0,
            height: 0,
            duration: PREVIEW_ANIMATION_DURATION,
            delay: PREVIEW_ANIMATION_DURATION,
            onComplete: () => this.destroy(),
        });
    }

    activate() {
        Main.activateWindow(this._window);
        this._getTopMenu().close();
    }

    _onDestroy() {
        if (this._cloneTextureLater) {
            Utils.laterRemove(this._cloneTextureLater);
            delete this._cloneTextureLater;
        }

        if (this._windowAddedLater) {
            Utils.laterRemove(this._windowAddedLater);
            delete this._windowAddedLater;
        }

        if (this._windowAddedId > 0) {
            this._workspace.disconnect(this._windowAddedId);
            this._windowAddedId = 0;
        }

        if (this._destroyId > 0) {
            this._mutterWindow.disconnect(this._destroyId);
            this._destroyId = 0;
        }

        if (this._windowTitleId > 0) {
            this._window.disconnect(this._windowTitleId);
            this._windowTitleId = 0;
        }
    }
});
