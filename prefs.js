// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as __,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Sliders save their value this long after the last move, so the dock is not resized for
// every step of a drag.
const SCALE_UPDATE_TIMEOUT = 500;

// One page with every setting, in the order of the former Position and size, Launchers and
// Appearance tabs.
export default class DockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.dock-manager');
        window.set_default_size(600, 850);

        // Pending slider saves are dropped when the window closes.
        this._timeouts = new Set();
        window.connect('close-request', () => {
            this._timeouts.forEach(id => GLib.source_remove(id));
            this._timeouts.clear();
            return false;
        });

        const page = new Adw.PreferencesPage();
        page.add(this._positionAndSizeGroup(settings));
        page.add(this._launchersGroup(settings));
        page.add(this._appearanceGroup(settings));
        window.add(page);
    }

    // ---------- Position and size ----------

    _positionAndSizeGroup(settings) {
        const group = new Adw.PreferencesGroup({title: __('Position and size')});

        const monitorRow = monitorChoice(settings);
        settings.bind('multi-monitor', monitorRow, 'sensitive', Gio.SettingsBindFlags.INVERT_BOOLEAN);
        group.add(monitorRow);
        group.add(switchRow(settings, 'multi-monitor', __('Show on all monitors')));
        group.add(positionChoice(settings));
        group.add(this._autohideRow(settings));

        const dockSize = this._scaleRow(settings, 'height-fraction', __('Dock size limit'), {
            lower: 0.33, upper: 1, step: 0.01, digits: 2, marks: [[0.9, null]],
            format: value => `${Math.round(value * 100)} %`,
        });
        settings.bind('extend-height', dockSize, 'sensitive', Gio.SettingsBindFlags.INVERT_BOOLEAN);
        group.add(dockSize);
        group.add(switchRow(settings, 'icon-size-fixed', __('Fixed icon size: scroll to reveal other icons')));
        return group;
    }

    // Intelligent autohide: on unless the dock is fixed, with its options inside.
    _autohideRow(settings) {
        const row = new Adw.ExpanderRow({
            title: __('Intelligent autohide'),
            subtitle: __('Hide the dock when it obstructs a window of the current application. More refined settings are available.'),
            show_enable_switch: true,
        });
        settings.bind('dock-fixed', row, 'enable-expansion', Gio.SettingsBindFlags.INVERT_BOOLEAN);

        const autohide = switchRow(settings, 'autohide', __('Autohide'),
            __('Show the dock by mouse hover on the screen edge.'));
        const fullscreen = switchRow(settings, 'autohide-in-fullscreen', __('Enable in fullscreen mode'));
        const urgent = switchRow(settings, 'show-dock-urgent-notify', __('Show dock for urgent notifications'));
        for (const option of [fullscreen, urgent])
            settings.bind('autohide', option, 'sensitive', Gio.SettingsBindFlags.GET);

        const animation = spinRow(settings, 'animation-time', __('Animation duration (s)'), 0, 1, 0.05, 2);
        const hideTimeout = spinRow(settings, 'hide-delay', __('Hide timeout (s)'), 0, 1, 0.05, 2);
        const showTimeout = spinRow(settings, 'show-delay', __('Show timeout (s)'), 0, 1, 0.05, 2);

        const reset = new Gtk.Button({label: __('Reset to defaults'), valign: Gtk.Align.CENTER});
        reset.connect('clicked', () => {
            for (const key of ['autohide', 'autohide-in-fullscreen', 'show-dock-urgent-notify',
                'animation-time', 'show-delay', 'hide-delay'])
                settings.reset(key);
        });
        const resetRow = new Adw.ActionRow();
        resetRow.add_suffix(reset);

        for (const option of [autohide, fullscreen, urgent, animation, hideTimeout, showTimeout, resetRow])
            row.add_row(option);
        return row;
    }

    // A slider bound to a number setting, saved a moment after it stops moving.
    _scaleRow(settings, key, title, {lower, upper, step, digits, marks = [], format}) {
        const isInt = settings.settings_schema.get_key(key).get_value_type().dup_string() === 'i';
        const scale = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
            digits, draw_value: true, value_pos: Gtk.PositionType.RIGHT, hexpand: true,
            valign: Gtk.Align.CENTER, width_request: 300,
        });
        scale.set_value(isInt ? settings.get_int(key) : settings.get_double(key));
        scale.set_format_value_func((_scale, value) => format(value));
        for (const [value, label] of marks)
            scale.add_mark(value, Gtk.PositionType.TOP, label);

        let timeoutId = 0;
        scale.connect('value-changed', () => {
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                this._timeouts.delete(timeoutId);
            }
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCALE_UPDATE_TIMEOUT, () => {
                this._timeouts.delete(timeoutId);
                timeoutId = 0;
                if (isInt)
                    settings.set_int(key, scale.get_value());
                else
                    settings.set_double(key, scale.get_value());
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(timeoutId);
        });

        const row = new Adw.ActionRow({title});
        row.add_suffix(scale);
        return row;
    }

    // ---------- Launchers ----------

    _launchersGroup(settings) {
        const group = new Adw.PreferencesGroup({title: __('Launchers')});
        group.add(isolateWorkspacesRow(settings));
        group.add(switchRow(settings, 'workspace-agnostic-urgent-windows', __('Show urgent windows despite current workspace')));
        group.add(switchRow(settings, 'isolate-monitors', __('Isolate monitors')));
        group.add(switchRow(settings, 'scroll-to-focused-application', __('Keep the focused application always visible in the dash')));
        group.add(switchRow(settings, 'dance-urgent-applications', __('Wiggle urgent applications')));
        return group;
    }

    // ---------- Appearance ----------

    _appearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({title: __('Appearance')});
        group.add(switchRow(settings, 'force-straight-corner', __('Force straight corner')));
        group.add(switchRow(settings, 'transparent-background', __('Transparent background')));
        group.add(switchRow(settings, 'extend-height', __('Panel mode: extend to the screen edge')));
        const centerIcons = switchRow(settings, 'always-center-icons', __('Place icons to the center'));
        settings.bind('extend-height', centerIcons, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(centerIcons);

        group.add(switchRow(settings, 'running-indicator-dominant-color', __('Use dominant color for the running dots')));
        return group;
    }
}

// ---------- Rows ----------

function switchRow(settings, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, lower, upper, step, digits) {
    const row = Adw.SpinRow.new_with_range(lower, upper, step);
    row.title = title;
    row.digits = digits;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Position on screen. The setting keeps the order Top, Right, Bottom, Left; in right to left
// languages its Left is on the right.
function positionChoice(settings) {
    const rtl = Gtk.Widget.get_default_direction() === Gtk.TextDirection.RTL;
    const positions = [
        [3, rtl ? __('Right') : __('Left')],
        [2, __('Bottom')],
        [0, __('Top')],
        [1, rtl ? __('Left') : __('Right')],
    ];
    const row = new Adw.ComboRow({
        title: __('Position on screen'),
        model: Gtk.StringList.new(positions.map(([, label]) => label)),
    });
    const show = () => {
        row.selected = positions.findIndex(([value]) => value === settings.get_enum('dock-position'));
    };
    show();
    row.connect('notify::selected', () => {
        const [value] = positions[row.selected];
        if (value !== settings.get_enum('dock-position'))
            settings.set_enum('dock-position', value);
    });
    settings.connect('changed::dock-position', show);
    return row;
}

// Isolate workspaces: follows GNOME Multitasking's Application Switching setting until it is
// set here.
function isolateWorkspacesRow(settings) {
    const appSwitcher = new Gio.Settings({schema_id: 'org.gnome.shell.app-switcher'});
    const row = new Adw.SwitchRow({title: __('Isolate workspaces')});
    const hasOverride = () => settings.get_user_value('isolate-workspaces') !== null;
    const gnomeIsolation = () => appSwitcher.get_boolean('current-workspace-only');

    let showing = false;
    const show = () => {
        showing = true;
        row.active = hasOverride() ? settings.get_boolean('isolate-workspaces') : gnomeIsolation();
        showing = false;
        row.subtitle = hasOverride() ? '' : __('Follows GNOME Multitasking\'s Application Switching setting.');
    };
    row.connect('notify::active', () => {
        if (showing)
            return;
        if (row.active === gnomeIsolation())
            settings.reset('isolate-workspaces');
        else
            settings.set_boolean('isolate-workspaces', row.active);
    });
    settings.connect('changed::isolate-workspaces', show);
    appSwitcher.connect('changed::current-workspace-only', show);
    show();
    return row;
}

// ---------- Monitors ----------

// "Show the dock on": the connected monitors, by their connector.
function monitorChoice(settings) {
    const names = new Gtk.StringList();
    const row = new Adw.ComboRow({title: __('Show the dock on'), model: names});
    const monitorsConfig = new MonitorsConfig();
    let monitors = [];
    let showing = false;

    const show = () => {
        const preferred = settings.get_int('preferred-monitor');
        const preferredConnector = settings.get_string('preferred-monitor-by-connector');
        monitors = monitorsConfig.monitors.filter(m => m.active || m.index === preferred);
        showing = true;
        names.splice(0, names.get_n_items(), monitors.map(m => m.isPrimary
            /* TRANSLATORS: This will be followed by Display Name - Connector. */
            ? `${__('Primary monitor: ') + m.displayName} - ${m.connector}`
            /* TRANSLATORS: Followed by monitor index, Display Name - Connector. */
            : `${__('Secondary monitor ') + (m.index + 1)} - ${m.displayName} - ${m.connector}`));
        let selected = monitors.findIndex(m => m.index === preferred ||
            (preferred === -2 && preferredConnector === m.connector));
        if (selected < 0)
            selected = monitors.findIndex(m => m.isPrimary);
        if (selected >= 0)
            row.selected = selected;
        showing = false;
    };
    row.connect('notify::selected', () => {
        const monitor = monitors[row.selected];
        if (showing || !monitor)
            return;
        settings.set_string('preferred-monitor-by-connector', monitor.connector);
        settings.set_int('preferred-monitor', -2);
    });
    monitorsConfig.connect('updated', show);
    settings.connect('changed::preferred-monitor', show);
    settings.connect('changed::preferred-monitor-by-connector', show);
    return row;
}

// The monitors as Mutter sees them, with the indexes the dock uses (the primary one is 0).
const MonitorsConfig = GObject.registerClass({
    Signals: {
        'updated': {},
    },
}, class MonitorsConfig extends GObject.Object {
    static get XML_INTERFACE() {
        return '<node>\
            <interface name="org.gnome.Mutter.DisplayConfig">\
                <method name="GetCurrentState">\
                <arg name="serial" direction="out" type="u" />\
                <arg name="monitors" direction="out" type="a((ssss)a(siiddada{sv})a{sv})" />\
                <arg name="logical_monitors" direction="out" type="a(iiduba(ssss)a{sv})" />\
                <arg name="properties" direction="out" type="a{sv}" />\
                </method>\
                <signal name="MonitorsChanged" />\
            </interface>\
        </node>';
    }

    static get ProxyWrapper() {
        return Gio.DBusProxy.makeProxyWrapper(MonitorsConfig.XML_INTERFACE);
    }

    constructor() {
        super();

        this._monitorsConfigProxy = new MonitorsConfig.ProxyWrapper(
            Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig'
        );
        this._monitorsConfigProxy.connectSignal('MonitorsChanged',
            () => this._updateResources());

        this._primaryMonitor = null;
        this._monitors = [];
        this._updateResources();
    }

    _updateResources() {
        this._monitorsConfigProxy.GetCurrentStateRemote((resources, err) => {
            if (err) {
                logError(err);
                return;
            }

            const [serial_, monitors, logicalMonitors] = resources;
            this._monitors = [];
            let index = 0;
            for (const monitor of monitors) {
                const [monitorSpecs, modes_, props] = monitor;
                const [connector, vendor, product, serial] = monitorSpecs;
                this._monitors.push({
                    index: index++,
                    active: false,
                    connector, vendor, product, serial,
                    displayName: props['display-name'].unpack(),
                });
            }

            for (const logicalMonitor of logicalMonitors) {
                const [x_, y_, scale_, transform_, isPrimary, monitorsSpecs] = logicalMonitor;

                // We only care about the first one really
                for (const monitorSpecs of monitorsSpecs) {
                    const [connector, vendor, product, serial] = monitorSpecs;
                    const monitor = this._monitors.find(m =>
                        m.connector === connector && m.vendor === vendor &&
                        m.product === product && m.serial === serial);

                    if (monitor) {
                        monitor.active = true;
                        monitor.isPrimary = isPrimary;
                        if (monitor.isPrimary)
                            this._primaryMonitor = monitor;
                        break;
                    }
                }
            }

            const activeMonitors = this._monitors.filter(m => m.active);
            if (activeMonitors.length > 1 && logicalMonitors.length === 1) {
                // We're in cloning mode, so let's just activate the primary monitor
                this._monitors.forEach(m => (m.active = false));
                this._primaryMonitor.active = true;
            }

            this._updateMonitorsIndexes();
            this.emit('updated');
        });
    }

    // The dock indexes monitors the old Gdk way, where the primary monitor is always 0
    // (see _createDocks in docking.js).
    _updateMonitorsIndexes() {
        const {index: primaryMonitorIndex} = this._primaryMonitor;
        for (const monitor of this._monitors) {
            let index = monitor.index - primaryMonitorIndex;
            if (index < 0)
                index += this._monitors.length;
            monitor.index = index;
        }
    }

    get monitors() {
        return this._monitors;
    }
});
