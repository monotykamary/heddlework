#!/usr/bin/env python3
"""Controlled XDG Settings service for private-session native appearance probes.

Run with /usr/bin/python3 inside dbus-run-session. The test-only Control
interface changes preferences or releases the portal name without stopping the
bus, distinguishing service loss from session-bus loss.
"""
import gi
from gi.repository import Gio, GLib

NAME = 'org.freedesktop.portal.Desktop'
PATH = '/org/freedesktop/portal/desktop'
SETTINGS = 'org.freedesktop.portal.Settings'
XML = '''<node>
<interface name="org.freedesktop.portal.Settings">
  <method name="Read"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
  <method name="ReadAll"><arg type="as" direction="in"/><arg type="a{sa{sv}}" direction="out"/></method>
  <signal name="SettingChanged"><arg type="s"/><arg type="s"/><arg type="v"/></signal>
  <property name="version" type="u" access="read"/>
</interface>
<interface name="org.heddlework.AppearanceTest">
  <method name="Set"><arg type="u" direction="in"/></method>
  <method name="Invalid"/>
  <method name="Release"/>
  <method name="Race"><arg type="u" direction="in"/></method>
</interface>
</node>'''
loop = GLib.MainLoop()
connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
value = 0
race = None
owner = None

def emit(variant):
    connection.emit_signal(None, PATH, SETTINGS, 'SettingChanged',
                          GLib.Variant('(ssv)', ('org.freedesktop.appearance', 'color-scheme', variant)))

def method(conn, sender, path, interface, name, parameters, invocation):
    global value, race
    if interface == SETTINGS:
        if name == 'Read':
            initial = value
            if race is not None:
                value, race = race, None
                emit(GLib.Variant('u', value))
            invocation.return_value(GLib.Variant('(v)', (GLib.Variant('u', initial),)))
        elif name == 'ReadAll':
            invocation.return_value(GLib.Variant('(a{sa{sv}})', ({'org.freedesktop.appearance': {'color-scheme': GLib.Variant('u', value)}},)))
    elif name == 'Set':
        value = parameters.unpack()[0]
        emit(GLib.Variant('u', value))
        invocation.return_value(None)
    elif name == 'Invalid':
        emit(GLib.Variant('s', 'invalid-preference'))
        invocation.return_value(None)
    elif name == 'Race':
        race = parameters.unpack()[0]
        invocation.return_value(None)
    elif name == 'Release':
        invocation.return_value(None)
        Gio.bus_unown_name(owner)

info = Gio.DBusNodeInfo.new_for_xml(XML)
registrations = [connection.register_object(PATH, interface, method,
    lambda *args: GLib.Variant('u', 1), None) for interface in info.interfaces]
owner = Gio.bus_own_name_on_connection(connection, NAME, Gio.BusNameOwnerFlags.NONE,
    lambda *args: print('READY', flush=True), lambda *args: None)
try:
    loop.run()
finally:
    Gio.bus_unown_name(owner)
    for registration in registrations:
        connection.unregister_object(registration)
