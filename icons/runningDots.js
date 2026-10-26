// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {DockManager} from '../dock/manager.js';
import {GlobalSignalsHandler} from '../handlers.js';
import {DominantColorExtractor} from './dominantColor.js';

const MAX_WINDOWS_CLASSES = 4;

const IndicatorDrawingArea = GObject.registerClass(
class IndicatorDrawingArea extends St.DrawingArea {
    vfunc_allocate(box) {
        if (box.x1 !== 0 || box.y1 !== 0)
            return super.vfunc_allocate(box);

        // We assume that the are is a rectangle in the operations below:
        const size = Math.min(box.get_width(), box.get_height());
        box.x2 = size;
        box.y2 = size;
        this.set_allocation(box);

        return super.vfunc_allocate(box);
    }
});

// The running dots: one per window, up to MAX_WINDOWS_CLASSES, drawn in place of GNOME's dot
// (kept hidden, so the icon keeps its layout) with the dot's style or the icon's dominant color.
export class RunningIndicatorDots {
    constructor(source) {
        this._source = source;
        this._signalsHandler = new GlobalSignalsHandler(source);
        this._side = DockManager.settings.dockPosition;
        this._dominantColorExtractor = new DominantColorExtractor(source.app);

        // I use opacity to hide the default dot because the show/hide function
        // are used by the parent class.
        source._dot.opacity = 0;

        this._area = new IndicatorDrawingArea({
            x_expand: true,
            y_expand: true,
        });

        // We draw for the bottom case and rotate the canvas for other placements
        // set center of rotations to the center
        this._area.set_pivot_point(0.5, 0.5);

        switch (this._side) {
        case St.Side.TOP:
            this._area.rotation_angle_z = 180;
            break;

        case St.Side.LEFT:
            this._area.rotation_angle_z = 90;
            break;

        case St.Side.RIGHT:
            this._area.rotation_angle_z = -90;
            break;
        }

        this._area.connectObject('repaint', this._updateIndicator.bind(this), this);
        source._iconContainer.add_child(this._area);

        this._signalsHandler.add([
            source,
            'notify::running',
            () => this.update(),
        ], [
            source,
            'notify::focused',
            () => this.update(),
        ], [
            source,
            'notify::windows-count',
            () => this._updateCounterClass(),
        ], [
            DockManager.settings,
            'changed::running-indicator-dominant-color',
            () => this.update(),
        ]);
        this.update();
    }

    get _number() {
        return Math.min(this._source.windowsCount, MAX_WINDOWS_CLASSES);
    }

    update() {
        this._updateCounterClass();

        if (this._source.running)
            this._source._dot.show();
        else
            this._source._dot.hide();

        this._area.queue_repaint();
    }

    _updateCounterClass() {
        for (let i = 1; i <= MAX_WINDOWS_CLASSES; i++) {
            const className = `running${i}`;
            if (i !== this._number)
                this._source.remove_style_class_name(className);
            else
                this._source.add_style_class_name(className);
        }
    }

    _computeStyle() {
        const [width, height] = this._area.get_surface_size();
        this._width = height;
        this._height = width;

        // By default re-use the style - background color, and border width and color -
        // of the default dot
        const themeNode = this._source._dot.get_theme_node();
        this._borderColor = themeNode.get_border_color(this._side);
        this._borderWidth = themeNode.get_border_width(this._side);
        this._bodyColor = themeNode.get_background_color();

        // Apply dominant color if requested, keeping the dot's color when the icon has none
        if (DockManager.settings.runningIndicatorDominantColor) {
            const colorPalette = this._dominantColorExtractor._getColorPalette();
            if (colorPalette) {
                [, this._bodyColor] = Cogl.Color.from_string(colorPalette.original);
            }
        }

        // Define the radius as an arbitrary size, but keep large enough to account
        // for the drawing of the border.
        this._radius = Math.max(this._width / 22, this._borderWidth / 2);
        this._padding = 0; // distance from the margin
        this._spacing = this._radius + this._borderWidth; // separation between the dots
    }

    _updateIndicator() {
        const cr = this._area.get_context();

        this._computeStyle();
        this._drawIndicator(cr);
        cr.$dispose();
    }

    _drawIndicator(cr) {
        // Draw the required numbers of dots
        const n = this._number;

        cr.setLineWidth(this._borderWidth);
        cr.setSourceColor(this._borderColor);

        // draw for the bottom case:
        cr.translate(
            (this._width - (2 * n) * this._radius - (n - 1) * this._spacing) / 2,
            this._height - this._padding);

        for (let i = 0; i < n; i++) {
            cr.newSubPath();
            cr.arc((2 * i + 1) * this._radius + i * this._spacing,
                -this._radius - this._borderWidth / 2,
                this._radius, 0, 2 * Math.PI);
        }

        cr.strokePreserve();
        cr.setSourceColor(this._bodyColor);
        cr.fill();
    }

    destroy() {
        this._area.destroy();
        delete this._area;
        this._source._dot.opacity = 255;
        this._source = null;
        this._signalsHandler.destroy();
        this._signalsHandler = null;
    }
}
