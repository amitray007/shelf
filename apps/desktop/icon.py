"""Render Shelf's canonical SVG with macOS app-icon margins."""
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

source = Path(__file__).resolve().parent.parent / 'web/public/favicon.svg'
output = Path(sys.argv[1])
output.parent.mkdir(parents=True, exist_ok=True)
ET.register_namespace('', 'http://www.w3.org/2000/svg')
tree = ET.parse(source)
root = tree.getroot()
# Give the tile a wider transparent margin and center a smaller white mark.
root.set('viewBox', '-5 -5 42 42')
mark = root.find('{http://www.w3.org/2000/svg}g')
if mark is None:
    raise RuntimeError('The canonical Shelf logo has no mark group')
mark.set('transform', 'translate(6 6) scale(.625)')
root.set('width', '1024')
root.set('height', '1024')
vector = output.with_suffix('.svg')
tree.write(vector, encoding='utf-8', xml_declaration=True)
# macOS respects SVG group transforms; Native SDK 0.10.1's rasterizer does not.
subprocess.run(['/usr/bin/sips', '-s', 'format', 'png', str(vector), '--out', str(output)], check=True, stdout=subprocess.DEVNULL)
