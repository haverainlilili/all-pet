#!/usr/bin/env python3
"""VTE adapters: identify an existing PTY with a transient, random title token.
Only the names/roles/states of terminal applications are read; never Text/scrollback.
"""
import json, os, sys, time, uuid, subprocess
try:
    import pyatspi as a
except ImportError:
    sys.exit(1)
cache = {}
allowed = ('gnome-terminal', 'xfce4-terminal', 'mate-terminal', 'terminator', 'tilix', 'kgx')
def walk(obj, budget):
    if budget[0] <= 0: return
    budget[0] -= 1
    yield obj
    try:
        for child in obj:
            yield from walk(child, budget)
    except Exception: pass

def terminal_child(obj):
    candidates = [x for x in walk(obj, [250]) if x.getRole() == a.ROLE_TERMINAL]
    return candidates[0] if len(candidates) == 1 else None

def bind(tty):
    if tty in cache:
        terminal, tab, frame, window = cache[tty]
        if not terminal.getState().contains(a.STATE_DEFUNCT): return cache[tty]
        del cache[tty]
    # Push/pop title uses the terminal's own title stack. No shell input is sent.
    marker = 'AllPet-' + uuid.uuid4().hex
    fd = os.open(tty, os.O_WRONLY | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        os.write(fd, ('\x1b[22;0t\x1b]2;' + marker + '\x07').encode())
        for attempt in range(5):
            time.sleep(.035)
            found = []
            for app in a.Registry.getDesktop(0):
                try:
                    exe = os.path.basename(os.readlink('/proc/%d/exe' % app.get_process_id()))
                    if not any(name in exe for name in allowed): continue
                    for frame in app:
                        frame_matches = []
                        for obj in walk(frame, [500]):
                            if obj.getRole() == a.ROLE_PAGE_TAB and marker in (obj.name or ''):
                                term = terminal_child(obj)
                                if term: frame_matches.append((term, obj, frame))
                        if not frame_matches and marker in (frame.name or ''):
                            term = terminal_child(frame)
                            if term: frame_matches.append((term, None, frame))
                        found.extend(frame_matches)
                except Exception: pass
            if len(found) == 1:
                window = None
                if os.environ.get('XDG_SESSION_TYPE') != 'wayland':
                    try:
                        ids = subprocess.check_output(['xdotool', 'search', '--name', marker], timeout=.4, stderr=subprocess.DEVNULL).decode().split()
                        if len(ids) == 1 and ids[0].isdigit(): window = ids[0]
                    except Exception: pass
                target = (*found[0], window)
                cache[tty] = target
                if len(cache) > 128: cache.clear(); cache[tty] = target
                return target
    finally:
        try: os.write(fd, b'\x1b[23;0t')
        finally: os.close(fd)
    return None

def viewed(target):
    terminal, tab, frame, window = target
    return (terminal.getState().contains(a.STATE_FOCUSED) and
            terminal.getState().contains(a.STATE_SHOWING) and
            frame.getState().contains(a.STATE_ACTIVE))

def focus(target):
    terminal, tab, frame, window = target
    if tab:
        try:
            selection = tab.parent.querySelection()
            if not selection.selectChild(tab.getIndexInParent()): return False
        except Exception:
            action = tab.queryAction()
            choices = [i for i in range(action.nActions) if action.getName(i).lower() in ('click', 'activate', 'select', 'switch')]
            if len(choices) != 1 or not action.doAction(choices[0]): return False
    if window:
        subprocess.run(['xdotool', 'windowactivate', '--sync', window], timeout=.5, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        frame.queryComponent().grabFocus()
    terminal.queryComponent().grabFocus()
    time.sleep(.05)
    return viewed(target)

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        tty = request.get('tty', '')
        if not tty.startswith('/dev/pts/') or not tty[9:].isdigit(): raise ValueError()
        # The process identity is checked again in this helper before touching a PTY.
        pid = int(request['pid'])
        stat = open('/proc/%d/stat' % pid).read().rsplit(') ', 1)[1].split()
        boot = open('/proc/sys/kernel/random/boot_id').read().strip()
        if request['start'] != boot + ':' + stat[19]: raise ValueError()
        target = bind(tty)
        ok = bool(target and (focus(target) if request.get('operation') == 'focus' else viewed(target)))
        reply = {'type': 'terminal-result', 'requestID': request.get('requestID'), 'succeeded': ok, 'viewed': ok}
    except Exception:
        reply = {'type': 'terminal-result', 'requestID': request.get('requestID'), 'succeeded': False, 'viewed': False}
    print(json.dumps(reply), flush=True)
