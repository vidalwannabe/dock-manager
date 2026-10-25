// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
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
const ICON_SIZES = [128, 96, 64, 48, 32, 24, 16];

// One page with every setting, in the order of the former Position and size, Launchers and
// Appearance tabs.
export default class DockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.dash-to-dock');
        window.set_default_size(-1, 850);

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
        group.add(switchRow(settings, 'extend-height', __('Panel mode: extend to the screen edge')));
        const centerIcons = switchRow(settings, 'always-center-icons', __('Place icons to the center'));
        settings.bind('extend-height', centerIcons, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(centerIcons);

        group.add(this._scaleRow(settings, 'dash-max-icon-size', __('Icon size limit'), {
            lower: 16, upper: 128, step: 1, digits: 0,
            marks: ICON_SIZES.map(size => [size, `${size}`]),
            format: value => `${value} px`,
        }));
        group.add(switchRow(settings, 'icon-size-fixed', __('Fixed icon size: scroll to reveal other icons')));

        group.add(this._scaleRow(settings, 'preview-size-scale', __('Preview size scale'), {
            lower: 0, upper: 1, step: 0.01, digits: 2,
            format: value => value === 0 ? 'auto' : `${value}`,
        }));
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
        const pressure = switchRow(settings, 'require-pressure-to-show', __('Push to show: require pressure to show the dock'));
        const fullscreen = switchRow(settings, 'autohide-in-fullscreen', __('Enable in fullscreen mode'));
        const urgent = switchRow(settings, 'show-dock-urgent-notify', __('Show dock for urgent notifications'));
        for (const option of [pressure, fullscreen, urgent])
            settings.bind('autohide', option, 'sensitive', Gio.SettingsBindFlags.GET);

        const dodge = switchRow(settings, 'intellihide', __('Dodge windows'),
            __('Show the dock when it doesn\'t obstruct application windows.'));
        const dodgeMode = enumChoice(settings, 'intellihide-mode', __('Windows to dodge'), [
            __('All windows'),
            __('Only focused application\'s windows'),
            __('Only maximized windows'),
            __('Always on top'),
        ]);
        settings.bind('intellihide', dodgeMode, 'sensitive', Gio.SettingsBindFlags.GET);

        const animation = spinRow(settings, 'animation-time', __('Animation duration (s)'), 0, 1, 0.05, 2);
        const hideTimeout = spinRow(settings, 'hide-delay', __('Hide timeout (s)'), 0, 1, 0.05, 2);
        const showTimeout = spinRow(settings, 'show-delay', __('Show timeout (s)'), 0, 1, 0.05, 2);
        settings.bind('require-pressure-to-show', showTimeout, 'sensitive', Gio.SettingsBindFlags.INVERT_BOOLEAN);
        const threshold = spinRow(settings, 'pressure-threshold', __('Pressure threshold'), 0, 100, 5, 0);
        settings.bind('require-pressure-to-show', threshold, 'sensitive', Gio.SettingsBindFlags.GET);

        const reset = new Gtk.Button({label: __('Reset to defaults'), valign: Gtk.Align.CENTER});
        reset.connect('clicked', () => {
            for (const key of ['intellihide', 'autohide', 'intellihide-mode', 'autohide-in-fullscreen',
                'show-dock-urgent-notify', 'require-pressure-to-show', 'animation-time',
                'show-delay', 'hide-delay', 'pressure-threshold'])
                settings.reset(key);
        });
        const resetRow = new Adw.ActionRow();
        resetRow.add_suffix(reset);

        for (const option of [autohide, pressure, fullscreen, urgent, dodge, dodgeMode,
            animation, hideTimeout, showTimeout, threshold, resetRow])
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
        group.add(switchRow(settings, 'show-favorites', __('Show pinned applications')));
        group.add(switchRow(settings, 'show-running', __('Show running applications')));
        group.add(isolateWorkspacesRow(settings));
        group.add(switchRow(settings, 'workspace-agnostic-urgent-windows', __('Show urgent windows despite current workspace')));
        group.add(switchRow(settings, 'isolate-monitors', __('Isolate monitors')));
        group.add(switchRow(settings, 'show-windows-preview', __('Show open windows\' previews')));
        group.add(switchRow(settings, 'scroll-to-focused-application', __('Keep the focused application always visible in the dash')));
        group.add(switchRow(settings, 'dance-urgent-applications', __('Wiggle urgent applications')));

        group.add(switchRow(settings, 'show-icons-emblems', __('Show icons emblems'),
            __('When enabled application icons will show notification counters and progress-bars (if Unity API is used).')));
        const counter = switchRow(settings, 'show-icons-notifications-counter', __('Show the number of unread notifications'));
        settings.bind('show-icons-emblems', counter, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(counter);
        const override = switchRow(settings, 'application-counter-overrides-notifications',
            __('Application-provided counter overrides the notifications counter'));
        const syncOverride = () => {
            override.sensitive = settings.get_boolean('show-icons-emblems') &&
                settings.get_boolean('show-icons-notifications-counter');
        };
        settings.connect('changed::show-icons-emblems', syncOverride);
        settings.connect('changed::show-icons-notifications-counter', syncOverride);
        syncOverride();
        group.add(override);
        return group;
    }

    // ---------- Appearance ----------

    _appearanceGroup(settings) {
        const group = new Adw.PreferencesGroup({title: __('Appearance')});
        group.add(switchRow(settings, 'force-straight-corner', __('Force straight corner')));

        const indicators = enumChoice(settings, 'running-indicator-style', __('Customize windows counter indicators'), [
            __('Default'), __('Dots'), __('Squares'), __('Dashes'), __('Segmented'),
            __('Solid'), __('Ciliora'), __('Metro'), __('Binary'), __('Dot'),
        ]);
        group.add(indicators);

        // Options of the indicators, for any style but Default.
        const backlit = switchRow(settings, 'unity-backlit-items', __('Enable Unity7 like glossy backlit items'));
        const dominant = switchRow(settings, 'running-indicator-dominant-color', __('Use dominant color'));
        const customize = switchRow(settings, 'custom-theme-customize-running-dots', __('Customize indicator style'));
        const dotColor = colorRow(settings, 'custom-theme-running-dots-color', __('Color'));
        const borderColor = colorRow(settings, 'custom-theme-running-dots-border-color', __('Border color'));
        const borderWidth = spinRow(settings, 'custom-theme-running-dots-border-width', __('Border width'), 0, 10, 1, 0);
        for (const row of [dotColor, borderColor, borderWidth])
            settings.bind('custom-theme-customize-running-dots', row, 'sensitive', Gio.SettingsBindFlags.GET);

        const options = [backlit, dominant, customize, dotColor, borderColor, borderWidth];
        const syncOptions = () => {
            const styled = settings.get_enum('running-indicator-style') !== 0;
            options.forEach(row => (row.visible = styled));
        };
        settings.connect('changed::running-indicator-style', syncOptions);
        syncOptions();
        options.forEach(row => group.add(row));
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

// A choice bound to an enum setting whose values are 0, 1, 2... in the order of `labels`.
function enumChoice(settings, key, title, labels) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(labels)});
    row.selected = settings.get_enum(key);
    row.connect('notify::selected', () => {
        if (row.selected !== settings.get_enum(key))
            settings.set_enum(key, row.selected);
    });
    settings.connect(`changed::${key}`, () => (row.selected = settings.get_enum(key)));
    return row;
}

// A color button bound to a color setting saved as CSS text.
function colorRow(settings, key, title) {
    const button = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog(), valign: Gtk.Align.CENTER});
    const rgba = new Gdk.RGBA();
    rgba.parse(settings.get_string(key));
    button.rgba = rgba;
    button.connect('notify::rgba', () => settings.set_string(key, button.rgba.to_string()));
    const row = new Adw.ActionRow({title});
    row.add_suffix(button);
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
