"""Validate generated SVG before sharing it as a downloadable document."""
import re
import sys
import xml.etree.ElementTree as ET

svg = 'http://www.w3.org/2000/svg'
xlink = 'http://www.w3.org/1999/xlink'
elements = set('svg g defs symbol use path rect circle ellipse line polyline polygon text tspan title desc linearGradient radialGradient stop clipPath mask pattern marker'.split())
raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
text = raw.decode('utf-8-sig')
markup = re.sub(r'\A<\?xml\s[^?]*\?>|<!--(?:[^-]|-(?!->))*-->', '', text)
if len(raw) > 8 * 1024 * 1024 or '<!' in markup or '<?' in markup:
    sys.exit(1)
root = ET.fromstring(text)
if root.tag != '{%s}svg' % svg:
    sys.exit(1)
local_ref = re.compile(r'#[\w:.-]+\Z', re.ASCII)
local_url = re.compile(r'url\(\s*#[\w:.-]+\s*\)', re.ASCII | re.IGNORECASE)
for element in root.iter():
    if not element.tag.startswith('{%s}' % svg) or element.tag.split('}', 1)[1] not in elements:
        sys.exit(1)
    for name, value in element.attrib.items():
        if name in ('href', '{%s}href' % xlink):
            if not local_ref.fullmatch(value):
                sys.exit(1)
        elif name.startswith('{') or name.lower().startswith('on') or name in ('src', 'style'):
            sys.exit(1)
        if re.search(r'[\\@]|/\*|url\s*\(|(?:https?|data|file|javascript):|//', local_url.sub('', value), re.IGNORECASE):
            sys.exit(1)
ET.register_namespace('', svg)
ET.register_namespace('xlink', xlink)
sys.stdout.buffer.write(ET.tostring(root, encoding='utf-8', xml_declaration=True))
