"""Exercise the actual helper with an in-process fake GTK/GObject display.

No real Wayland server, window, keyboard, or compositor is used here.
"""
import importlib.util
import io
import json
from pathlib import Path
import sys
import types

sys.dont_write_bytecode = True
source = Path(__file__).resolve().parents[1] / "src/main/desktop/waylandStopHelper.py"
spec = importlib.util.spec_from_file_location("wayland_stop_helper", source)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


def run(supported=True, close=False, disconnect=False, old_version=False, delayed=False, mismatched=False, disable_button=False):
    events, windows, calls = {}, [], []

    class Window:
        def __init__(self, **_):
            self.signals, self.mapped, self.contents = {}, False, None
            windows.append(self)

        def set_decorated(self, value): calls.append(("decorated", value))
        def set_resizable(self, value): calls.append(("resizable", value))
        def set_accept_focus(self, value): calls.append(("focus", value))
        def set_name(self, value): calls.append(("name", value))
        def connect(self, signal, callback): self.signals[signal] = callback
        def add(self, box): self.contents = box
        def show_all(self): self.mapped = not delayed
        def get_mapped(self): return self.mapped

    class Label:
        def set_ellipsize(self, _value): pass
        def set_max_width_chars(self, _value): pass
        def set_text(self, value): self.text = value

    class Button:
        def __init__(self): self.signals, self.sensitive = {}, True
        def connect(self, signal, callback): self.signals[signal] = callback
        def set_label(self, value): self.label = value
        def get_mapped(self): return True
        def get_visible(self): return True
        def get_sensitive(self): return self.sensitive
        def get_allocated_width(self): return 100
        def get_allocated_height(self): return 30

    class Box:
        def __init__(self, **_): self.children = []
        def pack_start(self, widget, *_): self.children.append(widget)

    class Display:
        def get_n_monitors(self): return 2
        def get_monitor(self, index): return index + 1
        def connect(self, signal, callback): events[signal] = callback

    display = Display()
    layer = types.SimpleNamespace(
        is_supported=lambda: supported,
        get_major_version=lambda: 0,
        get_minor_version=lambda: 9 if old_version else 10,
        init_for_window=lambda window: calls.append(("init", window)),
        set_namespace=lambda window, value: calls.append(("namespace", value)),
        set_layer=lambda window, value: calls.append(("layer", value)),
        set_keyboard_interactivity=lambda window, value: calls.append(("keyboard", value)),
        set_monitor=lambda window, value: calls.append(("monitor", value)),
        set_anchor=lambda window, edge, value: calls.append(("anchor", edge, value)),
        set_margin=lambda window, edge, value: None,
        set_respect_close=lambda window, value: calls.append(("respect-close", value)),
        Layer=types.SimpleNamespace(OVERLAY="overlay"), Edge=types.SimpleNamespace(TOP="top", RIGHT="right"))
    if old_version or mismatched:
        del layer.set_respect_close

    class Css:
        def load_from_data(self, data): calls.append(("css", data))

    def mainloop():
        events["input"](None, 1)
        if delayed:
            assert "retry" in events, "mapping must wait instead of failing prematurely"
            events["timer"]()
            for window in windows: window.mapped = True
            events["retry"]()
        if windows:
            windows[0].contents.children[2].signals["clicked"]()
        if close:
            windows[1].signals["delete-event"]()
        if disconnect:
            events["monitor-removed"]()
        if disable_button:
            windows[0].contents.children[2].sensitive = False
        events["timer"]()

    gtk = types.SimpleNamespace(
        init_check=lambda _: (True, []), main=mainloop, Window=Window, Box=Box, Label=Label, Button=Button,
        WindowType=types.SimpleNamespace(TOPLEVEL=1), Orientation=types.SimpleNamespace(HORIZONTAL=1),
        CssProvider=Css, StyleContext=types.SimpleNamespace(add_provider_for_screen=lambda *_: None),
        STYLE_PROVIDER_PRIORITY_APPLICATION=1,
        Settings=types.SimpleNamespace(get_default=lambda: types.SimpleNamespace(set_property=lambda *_: None)))
    def timeout_add(delay, callback, *args):
        if delay == 500:
            events["timer"] = callback
        else:
            if callback(*args): events["retry"] = lambda: callback(*args)

    glib = types.SimpleNamespace(IO_IN=1, IO_HUP=2, IO_ERR=4,
        io_add_watch=lambda _fd, _mask, callback: events.update(input=callback),
        timeout_add=timeout_add)
    gdk = types.SimpleNamespace(Display=types.SimpleNamespace(get_default=lambda: display),
        Screen=types.SimpleNamespace(get_default=lambda: object()))
    pango = types.SimpleNamespace(EllipsizeMode=types.SimpleNamespace(END=1))
    gi = types.ModuleType("gi"); gi.require_version = lambda *_: None
    repository = types.ModuleType("gi.repository")
    for name, value in {"Gdk": gdk, "GLib": glib, "Gtk": gtk, "GtkLayerShell": layer, "Pango": pango}.items():
        setattr(repository, name, value)
    gi.repository = repository
    sys.modules["gi"], sys.modules["gi.repository"] = gi, repository
    labels = {"active": "Active", "stopping": "Stopping", "unknown": "Unknown", "stop": "Stop", "escape": "Esc", "escapeUnavailable": "Use Stop"}
    update = json.dumps({"kind": "render", "namespace": "test", "revision": 1, "state": "active",
                         "target": "Test window", "escapeAvailable": False, "labels": labels}) + "\n"

    class Input:
        def __init__(self): self.buffer = io.BytesIO(update.encode())
        def fileno(self): return 10
        def __iter__(self): return iter(())

    oldin, oldout = sys.stdin, sys.stdout
    sys.stdin, sys.stdout = Input(), io.StringIO()
    try:
        helper.main()
        output = sys.stdout.getvalue()
    finally:
        sys.stdin, sys.stdout = oldin, oldout
    return [json.loads(line) for line in output.splitlines()], windows, calls


messages, windows, calls = run()
assert [item["kind"] for item in messages] == ["mapped", "stop", "heartbeat"], messages
assert messages[0]["outputs"] == 2 and messages[0]["namespace"] == "test"
assert len(windows) == 2 and all(window.get_mapped() for window in windows)
assert [(name, value) for name, value, *rest in calls if name == "keyboard"] == [("keyboard", False)] * 2
assert [(name, value) for name, value, *rest in calls if name == "layer"] == [("layer", "overlay")] * 2
assert all(window.contents.children[2].label == "Stop" for window in windows)
assert all(window.contents.children[1].text == "Use Stop" for window in windows)
messages, _, _ = run(supported=False)
assert messages[0]["kind"] == "failure" and "layer-shell unavailable" in messages[0]["reason"]
messages, _, _ = run(close=True)
assert messages[-1]["kind"] == "failure" and "closed or hid" in messages[-1]["reason"]
messages, _, calls = run(old_version=True, close=True)
assert messages[-1]["kind"] == "failure" and "closed or hid" in messages[-1]["reason"]
assert not any(call[0] == "respect-close" for call in calls)
messages, _, _ = run(mismatched=True)
assert messages[0]["kind"] == "failure" and "bindings do not match" in messages[0]["reason"]
messages, _, _ = run(delayed=True)
assert [item["kind"] for item in messages] == ["heartbeat", "mapped", "stop", "heartbeat"]
messages, _, _ = run(disconnect=True)
assert messages[-1]["kind"] == "failure" and "outputs changed" in messages[-1]["reason"]
messages, _, _ = run(disable_button=True)
assert messages[-1]["kind"] == "failure" and "unavailable" in messages[-1]["reason"]
print("GTK layer-shell helper: fake widgets, multi-output stop, no keyboard focus and failure paths passed; no native GUI tested")
