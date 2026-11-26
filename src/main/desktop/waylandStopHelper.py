#!/usr/bin/env python3
"""Independent GTK layer-shell stop surface; all messages travel over owned stdio.

Mapping a Wayland surface is not proof that it is unobscured. The helper checks
that each output has a mapped, sensitive Stop control and monitors its health.
"""
import json
import os
import sys

MAX_LINE = 16384


def send(kind, **fields):
    sys.stdout.write(json.dumps(dict(kind=kind, **fields), ensure_ascii=True) + "\n")
    sys.stdout.flush()


def main():
    try:
        import gi
        gi.require_version("Gtk", "3.0")
        gi.require_version("GtkLayerShell", "0.1")
        from gi.repository import Gdk, GLib, Gtk, GtkLayerShell, Pango
    except (ImportError, ValueError) as error:
        send("failure", reason="Install Python GObject, GTK 3 and the GTK Layer Shell introspection package: " + str(error))
        # Keep the owned process alive until its supervisor reclaims it.
        for _ in sys.stdin:
            pass
        return

    windows = []
    current = {"revision": None, "failed": False, "namespace": None, "mapped": False}

    def failure(reason):
        if not current["failed"]:
            current["failed"] = True
            send("failure", reason=reason)

    def require_supported():
        ok, _ = Gtk.init_check([])
        if not ok or not GtkLayerShell.is_supported():
            raise RuntimeError("Native Wayland layer-shell unavailable; use KDE Plasma or a wlroots compositor with layer-shell enabled, or disable desktop control")
        if not hasattr(GtkLayerShell, "get_major_version") or not hasattr(GtkLayerShell, "get_minor_version"):
            raise RuntimeError("GTK Layer Shell 0.5 or later and matching introspection bindings are required")
        version = (GtkLayerShell.get_major_version(), GtkLayerShell.get_minor_version())
        if version < (0, 5):
            raise RuntimeError("GTK Layer Shell 0.5 or later is required")
        if version >= (0, 10) and not hasattr(GtkLayerShell, "set_respect_close"):
            raise RuntimeError("GTK Layer Shell introspection bindings do not match the installed library")
        display = Gdk.Display.get_default()
        if display is None or display.get_n_monitors() < 1:
            raise RuntimeError("Wayland has no active display for the Stop control")
        return display

    def check_mapped():
        return bool(windows) and all(
            window.get_mapped() and button.get_mapped() and button.get_visible() and button.get_sensitive()
            and button.get_allocated_width() > 0 and button.get_allocated_height() > 0
            for window, _, _, button in windows
        )

    def acknowledge(revision):
        if not current["failed"] and current["revision"] == revision:
            if not check_mapped():
                # Mapping is asynchronous on Wayland; the host enforces the
                # bounded startup deadline while we wait for every output.
                return True
            else:
                current["mapped"] = True
                send("mapped", revision=revision, pid=os.getpid(), namespace=current["namespace"], outputs=len(windows))
        return False

    def closed(*_args):
        failure("The compositor closed or hid a Wayland Stop control")
        return True

    def on_stop(*_args):
        # Stopping is always safe, including while an update is being rendered.
        if not current["failed"] and current["revision"] is not None:
            send("stop", revision=current["revision"])

    def setup(namespace):
        display = require_supported()
        css = Gtk.CssProvider()
        css.load_from_data(b"#muster-stop { background: #20252b; color: #ffffff; padding: 10px; border: 2px solid #f06449; border-radius: 6px; } #muster-stop button { background: #bc322b; color: #ffffff; font-weight: bold; padding: 7px 15px; }")
        Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        settings = Gtk.Settings.get_default()
        if settings is not None:
            settings.set_property("gtk-enable-animations", False)
        current["namespace"] = namespace
        for index in range(display.get_n_monitors()):
            monitor = display.get_monitor(index)
            if monitor is None:
                raise RuntimeError("Wayland output disappeared while creating the Stop control")
            window = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
            window.set_decorated(False)
            window.set_resizable(False)
            window.set_accept_focus(False)
            window.set_name("muster-stop")
            GtkLayerShell.init_for_window(window)
            GtkLayerShell.set_namespace(window, namespace)
            GtkLayerShell.set_layer(window, GtkLayerShell.Layer.OVERLAY)
            GtkLayerShell.set_keyboard_interactivity(window, False)
            GtkLayerShell.set_monitor(window, monitor)
            GtkLayerShell.set_anchor(window, GtkLayerShell.Edge.TOP, True)
            GtkLayerShell.set_anchor(window, GtkLayerShell.Edge.RIGHT, True)
            GtkLayerShell.set_margin(window, GtkLayerShell.Edge.TOP, 12)
            GtkLayerShell.set_margin(window, GtkLayerShell.Edge.RIGHT, 12)
            # Before 0.10 the library always forwards .closed as delete-event;
            # 0.10+ defaults to ignoring it unless this is explicitly enabled.
            if hasattr(GtkLayerShell, "set_respect_close"):
                GtkLayerShell.set_respect_close(window, True)
            box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
            label, hint, button = Gtk.Label(), Gtk.Label(), Gtk.Button()
            label.set_ellipsize(Pango.EllipsizeMode.END)
            label.set_max_width_chars(38)
            button.connect("clicked", on_stop)
            box.pack_start(label, False, False, 0)
            box.pack_start(hint, False, False, 0)
            box.pack_start(button, False, False, 0)
            window.add(box)
            window.connect("delete-event", closed)
            window.connect("unmap-event", closed)
            windows.append((window, label, hint, button))
        display.connect("monitor-added", lambda *_: failure("Wayland outputs changed; restart desktop control"))
        display.connect("monitor-removed", lambda *_: failure("Wayland outputs changed; restart desktop control"))

    def render(message):
        revision = message.get("revision")
        labels, state = message.get("labels"), message.get("state")
        if (type(revision) is not int or revision < 0 or state not in ("active", "stopping", "unknown")
                or not isinstance(labels, dict) or not isinstance(message.get("namespace"), str)
                or len(message["namespace"]) > 100):
            raise ValueError("Invalid Stop control update")
        if any(not isinstance(labels.get(key), str) or len(labels[key]) > 1024
               for key in ("active", "stopping", "unknown", "stop", "escape", "escapeUnavailable")):
            raise ValueError("Invalid Stop control labels")
        if not windows:
            setup(message["namespace"])
        elif current["namespace"] != message["namespace"] or revision <= current["revision"]:
            raise ValueError("Stop control revision or namespace changed")
        current["revision"] = revision
        target = message.get("target") or ""
        if not isinstance(target, str) or len(target) > 160:
            raise ValueError("Invalid Stop control target")
        for window, label, hint, button in windows:
            label.set_text(labels[state] + (" — " + target if target else ""))
            hint.set_text(labels["escape"] if message.get("escapeAvailable") is True else labels["escapeUnavailable"])
            button.set_label(labels["stop"])
            window.show_all()
        GLib.timeout_add(50, acknowledge, revision)

    def input_ready(_source, condition):
        if condition & (GLib.IO_HUP | GLib.IO_ERR):
            failure("Stop control supervisor disconnected")
            return False
        try:
            line = sys.stdin.buffer.readline(MAX_LINE + 1)
            if not line or len(line) > MAX_LINE or not line.endswith(b"\n"):
                raise ValueError("Invalid Stop control message")
            message = json.loads(line)
            if not isinstance(message, dict) or message.get("kind") != "render":
                raise ValueError("Unexpected Stop control message")
            render(message)
        except Exception as error:
            failure(str(error))
        return not current["failed"]

    def heartbeat():
        if not current["failed"]:
            if current["mapped"] and not check_mapped():
                failure("The Wayland Stop control became unmapped or unavailable")
            else:
                send("heartbeat")
        return True

    try:
        require_supported()
    except Exception as error:
        send("failure", reason=str(error))
        for _ in sys.stdin:
            pass
        return
    GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, input_ready)
    GLib.timeout_add(500, heartbeat)
    Gtk.main()


if __name__ == "__main__":
    main()
