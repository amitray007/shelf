"""Install the locally built Shelf bundle without touching application data."""
from pathlib import Path
import os
import plistlib
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / '.build/Shelf.app'
DESTINATION = Path('/Applications/Shelf.app')
BUNDLE_ID = 'in.pyxo.shelf.desktop'


def validate(bundle):
    if bundle.is_symlink():
        raise RuntimeError(f'Refusing a symlink at {bundle}')
    with (bundle / 'Contents/Info.plist').open('rb') as file:
        info = plistlib.load(file)
    if info.get('CFBundleIdentifier') != BUNDLE_ID:
        raise RuntimeError(f'Refusing to replace a different application at {bundle}')
    executable = info.get('CFBundleExecutable', '')
    if not executable or Path(executable).name != executable:
        raise RuntimeError('The bundle has an invalid executable name')
    binary = bundle / 'Contents/MacOS' / executable
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise RuntimeError('The bundle executable is missing or is not executable')
    return binary


def verify(bundle):
    validate(bundle)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(bundle)], check=True)


def stop_previous_copies(binaries):
    paths = {str(path.resolve()) for path in binaries}
    processes = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True)
    pids = []
    for row in processes.splitlines():
        parts = row.strip().split(None, 1)
        if len(parts) == 2 and parts[1] in paths:
            pids.append(int(parts[0]))
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 10
    while pids and time.monotonic() < deadline:
        remaining = []
        for pid in pids:
            try:
                os.kill(pid, 0)
                remaining.append(pid)
            except ProcessLookupError:
                pass
        pids = remaining
        if pids:
            time.sleep(0.1)
    if pids:
        raise RuntimeError('Shelf did not quit. Close it, then run the install again.')


def install():
    verify(SOURCE)
    binaries = [validate(SOURCE)]
    if DESTINATION.exists() or DESTINATION.is_symlink():
        binaries.append(validate(DESTINATION))
    backup = ROOT / '.build/previous/Shelf.app'
    if backup.exists() or backup.is_symlink():
        validate(backup)
    # Stage on the Applications volume; rename only after validating the full copy.
    with tempfile.TemporaryDirectory(prefix='.shelf-install-', dir=DESTINATION.parent) as temporary:
        stage = Path(temporary) / 'Shelf.app'
        previous = Path(temporary) / 'Previous.app'
        shutil.copytree(SOURCE, stage, symlinks=True)
        verify(stage)
        stop_previous_copies(binaries)
        had_previous = DESTINATION.exists()
        if had_previous:
            DESTINATION.rename(previous)
        try:
            stage.rename(DESTINATION)
            verify(DESTINATION)
        except BaseException:
            if DESTINATION.exists():
                shutil.rmtree(DESTINATION)
            if had_previous:
                previous.rename(DESTINATION)
            raise
        if had_previous:
            backup.parent.mkdir(parents=True, exist_ok=True)
            if backup.exists():
                shutil.rmtree(backup)
            shutil.move(str(previous), backup)
    subprocess.run(['/usr/bin/open', str(DESTINATION)], check=True)
    print(f'Installed and launched {DESTINATION}')


if __name__ == '__main__':
    try:
        install()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'Shelf install failed: {error}') from error
