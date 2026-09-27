"""Serve only the disposable mockup folder on loopback."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from pathlib import Path
import os
root = Path(__file__).resolve().parent
port = int(os.environ.get('PORT', '8769'))
print(f'Shelf layout mockups: http://127.0.0.1:{port}', flush=True)
ThreadingHTTPServer(('127.0.0.1', port), partial(SimpleHTTPRequestHandler, directory=str(root))).serve_forever()
