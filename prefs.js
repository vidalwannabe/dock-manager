// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// One page with every setting: Position, then Appearance.
export default class DockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.dock-manager');
        window.set_default_size(600, 815);

        const page = new Adw.PreferencesPage();
        page.add(this._positionGroup(settings));
        page.add(this._appearanceGroup(settings));
        window.add(page);
    }

    // ---------- Position ----------

    _positionGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Position'});

        const monitorRow = monitorChoice(settings);
        settings.bind('multi-monitor', monitorRow, 'sensitive', Gio.SettingsBindFlags.INVERT_BOOLEAN);
        group.add(monitorRow);
        group.add(switchRow(settings, 'multi-monitor', 'Show on all monitors'));

        // Isolating monitors only makes sense with a dock on each of them.
        const isolateRow = switchRow(settings, 'isolate-monitors', 'Isolate monitors',
            'Each dock shows only the applications with windows on its monitor.');
        settings.bind('multi-monitor', isolateRow, 'sensitive', Gio.SettingsBindFlags.GET);
        const syncIsolation = () => {
            if (!settings.get_boolean('multi-monitor') && settings.get_boolean('isolate-monitors'))
                settings.set_boolean('isolate-monitors', false);
        };
        settings.connect('changed::multi-monitor', syncIsolation);
        syncIsolation();
        group.add(isolateRow);
        group.add(positionChoice(settings));
        group.add(spinRow(settings, 'screen-edge-distance', 'Distance from screen edge (px)', 0, 200, 1, 0));
        group.add(this._autohideRow(settings));
        return group;
    }

    // Intelligent autohide: on unless the dock is fixed, with its options inside.
    _autohideRow(settings) {
        const row = new Adw.ExpanderRow({
            title: 'Intelligent autohide',
            subtitle: 'Hide the dock when it obstructs a window of the current application. More refined settings are available.',
            show_enable_switch: true,
        });
        settings.bind('dock-fixed', row, 'enable-expansion', Gio.SettingsBindFlags.INVERT_BOOLEAN);

        const allWindows = switchRow(settings, 'intellihide-all-windows', 'Hide for every window',
            'Hide the dock when any window covers it, not only the focused application.');
        const autohide = switchRow(settings, 'autohide', 'Show on mouse hover');
        const fullscreen = switchRow(settings, 'autohide-in-fullscreen', 'Enable in fullscreen mode');
        const urgent = switchRow(settings, 'show-dock-urgent-notify', 'Show dock for urgent notifications');
        for (const option of [fullscreen, urgent])
            settings.bind('autohide', option, 'sensitive', Gio.SettingsBindFlags.GET);

        const animation = spinRow(settings, 'animation-time', 'Animation duration (s)', 0, 1, 0.05, 2);
        const hideTimeout = spinRow(settings, 'hide-delay', 'Hide timeout (s)', 0, 1, 0.05, 2);
        const showTimeout = spinRow(settings, 'show-delay', 'Show timeout (s)', 0, 1, 0.05, 2);

        const reset = new Gtk.Button({label: 'Reset to defaults', valign: Gtk.Align.CENTER});
        reset.connect('clicked', () => {
            for (const key of ['intellihide-all-windows', 'autohide', 'autohide-in-fullscreen',
                'show-dock-urgent-notify', 'animation-time', 'show-delay', 'hide-delay'])
                settings.reset(key);
        });
        const resetRow = new Adw.ActionRow();
        resetRow.add_suffix(reset);

        for (const option of [allWindows, autohide, fullscreen, urgent, animation, hideTimeout, showTimeout, resetRow])
            row.add_row(option);
        return row;
    }

    // ---------- Appearance ----------

    _appearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Appearance'});
        group.add(switchRow(settings, 'extend-height', 'Extended dock'));
        const centerIcons = switchRow(settings, 'always-center-icons', 'Centralize icons');
        settings.bind('extend-height', centerIcons, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(centerIcons);
        group.add(switchRow(settings, 'quick-settings-border', 'Border'));
        group.add(switchRow(settings, 'running-indicator-dominant-color', 'Colored indicator dots'));
        group.add(switchRow(settings, 'overview-zoom', 'Seamless overview zoom'));
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

// Position on screen. The setting keeps the order Top, Right, Bottom, Left.
function positionChoice(settings) {
    const positions = [
        [3, 'Left'],
        [2, 'Bottom'],
        [0, 'Top'],
        [1, 'Right'],
    ];
    const row = new Adw.ComboRow({
        title: 'Position on screen',
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

// ---------- Monitors ----------

// "Show the dock on": the connected monitors, by their connector.
function monitorChoice(settings) {
    const names = new Gtk.StringList();
    const row = new Adw.ComboRow({title: 'Show the dock on', model: names});
    const monitorsConfig = new MonitorsConfig();
    let monitors = [];
    let showing = false;

    const show = () => {
        const preferred = settings.get_int('preferred-monitor');
        const preferredConnector = settings.get_string('preferred-monitor-by-connector');
        monitors = monitorsConfig.monitors.filter(m => m.active || m.index === preferred);
        showing = true;
        names.splice(0, names.get_n_items(), monitors.map(m => m.isPrimary
            ? `${'Primary monitor: ' + m.displayName} - ${m.connector}`
            : `${'Secondary monitor ' + (m.index + 1)} - ${m.displayName} - ${m.connector}`));
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
