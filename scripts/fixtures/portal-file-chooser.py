#!/usr/bin/env python3
"""Controlled XDG FileChooser portal for private-session native picker probes.

Run with /usr/bin/python3 inside dbus-run-session. Emulates the FileChooser and
Request interfaces plus a test-only Control interface that scripts responses,
close failures, malformed payloads, and portal-name release without stopping
the bus.
"""
import gi
from gi.repository import Gio, GLib

NAME = 'org.freedesktop.portal.Desktop'
PATH = '/org/freedesktop/portal/desktop'
CHOOSER = 'org.freedesktop.portal.FileChooser'
REQUEST = 'org.freedesktop.portal.Request'
CONTROL = 'org.heddlework.FileChooserTest'
XML = '''<node>
<interface name="org.freedesktop.portal.FileChooser">
  <method name="OpenFile">
    <arg type="s" direction="in"/><arg type="a{sv}" direction="in"/>
    <arg type="o" direction="out"/>
  </method>
  <property name="version" type="u" access="read"/>
</interface>
<interface name="org.freedesktop.portal.Request">
  <method name="Close"/>
  <signal name="Response"><arg type="u"/><arg type="a{sv}"/></signal>
  <property name="version" type="u" access="read"/>
</interface>
<interface name="org.heddlework.FileChooserTest">
  <method name="Respond">
    <arg type="o" direction="in"/><arg type="u" direction="in"/><arg type="as" direction="in"/>
  </method>
  <method name="RespondEarly"><arg type="u" direction="in"/><arg type="as" direction="in"/></method>
  <method name="RespondPath">
    <arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="as" direction="in"/>
  </method>
  <method name="Malformed"><arg type="o" direction="in"/></method>
  <method name="CloseMode"><arg type="s" direction="in"/></method>
  <method name="Release"/>
</interface>
</node>'''
loop = GLib.MainLoop()
connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
last_request = [None]
owner = None
early = None
close_mode = 'ok'
registrations = []

def emit_response(path, code, uris):
    # Real cancellations carry an empty results dictionary; only selections
    # include a uris entry.
    results = {'uris': GLib.Variant('as', uris)} if code == 0 else {}
    print('EMIT', path, code, uris, flush=True)
    connection.emit_signal(None, path, REQUEST, 'Response',
                           GLib.Variant('(ua{sv})', (code, results)))

def request_method(conn, sender, path, interface, name, parameters, invocation):
    if name == 'Close':
        if close_mode == 'denied':
            invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied', 'denied')
            return
        if close_mode == 'gone':
            invocation.return_dbus_error('org.freedesktop.DBus.Error.UnknownObject', 'gone')
            return
        if close_mode == 'silent':
            invocation.return_value(None)
            return
        emit_response(path, 1, [])
        invocation.return_value(None)

def chooser_method(conn, sender, path, interface, name, parameters, invocation):
    global early
    handle = None
    registration = None
    try:
        print('OPENFILE', sender, flush=True)
        options = dict(parameters.unpack()[1])
        token = options['handle_token']
        handle = '/org/freedesktop/portal/desktop/request/%s/%s' % (
            sender[1:].replace('.', '_'), token)
        info = Gio.DBusNodeInfo.new_for_xml('<node><interface name="%s">'
            '<method name="Close"/><property name="version" type="u" access="read"/>'
            '</interface></node>' % REQUEST)
        registration = connection.register_object(handle, info.interfaces[0],
            request_method, lambda *args: GLib.Variant('u', 1), None)
        registrations.append(registration)
        last_request[0] = handle
        if early is not None:
            code, uris = early
            early = None
            emit_response(handle, code, uris)
    except Exception as error:
        print('OpenFile failed:', error, flush=True)
        # Roll back request state so a stale handle is never reused.
        if registration in registrations:
            registrations.remove(registration)
            connection.unregister_object(registration)
        if last_request and last_request[0] == handle:
            last_request[0] = None
        invocation.return_dbus_error('org.heddlework.FileChooserTest.Failed', str(error))
        return
    invocation.return_value(GLib.Variant('(o)', (handle,)))

def control_method(conn, sender, path, interface, name, parameters, invocation):
    global early, close_mode
    args = parameters.unpack()
    if name == 'Respond':
        target = last_request[0] if args[0] == '/org/freedesktop/portal/desktop/request/last' else args[0]
        emit_response(target, args[1], args[2])
    elif name == 'RespondEarly':
        early = (args[0], args[1])
    elif name == 'RespondPath':
        connection.emit_signal(None, args[0], REQUEST, 'Response',
                               GLib.Variant('(ua{sv})', (args[1], {'uris': GLib.Variant('as', args[2])})))
    elif name == 'Malformed':
        target = last_request[0] if args[0] == '/org/freedesktop/portal/desktop/request/last' else args[0]
        connection.emit_signal(None, target, REQUEST, 'Response', GLib.Variant('(s)', ('nope',)))
    elif name == 'CloseMode':
        close_mode = args[0]
    elif name == 'Release':
        invocation.return_value(None)
        Gio.bus_unown_name(owner)
        return
    invocation.return_value(None)

info = Gio.DBusNodeInfo.new_for_xml(XML)
interfaces = {interface.name: interface for interface in info.interfaces}
registrations += [connection.register_object(PATH, interface, method,
    lambda *args: GLib.Variant('u', 1), None) for interface, method in [
    (interfaces[CHOOSER], chooser_method), (interfaces[CONTROL], control_method)]]
owner = Gio.bus_own_name_on_connection(connection, NAME, Gio.BusNameOwnerFlags.NONE,
    lambda *args: print('READY', flush=True), lambda *args: None)
try:
    loop.run()
finally:
    Gio.bus_unown_name(owner)
    for registration in registrations:
        connection.unregister_object(registration)
