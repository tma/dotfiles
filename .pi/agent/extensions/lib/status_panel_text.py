#!/usr/bin/env python3
"""Clean untrusted text before the status panel draws it.

The panel prints its frame with printf %s, so backslashes stay literal. This
helper removes what a terminal would still act on: escape sequences, C0 and C1
controls, and bidi formatting characters.

Usage:
  status_panel_text.py json < file.json      print the JSON with clean strings
  status_panel_text.py text VALUE...         print each value, cleaned, per line
  status_panel_text.py file-links ROOT PATH...
      print "URI<TAB>LABEL" per git path; the URI is percent-encoded
"""

import json
import os
import re
import sys
from urllib.parse import quote

ESCAPE_SEQUENCE = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]"  # CSI
    r"|\x1b[\]PX^_].*?(?:\x07|\x1b\\|\Z)"  # OSC, DCS, SOS, PM, APC
    r"|\x1b[ -/]*[0-~]"  # other ESC sequences
    r"|\x9b[0-?]*[ -/]*[@-~]"  # 8-bit CSI
    r"|[\x90\x98\x9d\x9e\x9f].*?(?:\x07|\x9c|\Z)",  # 8-bit string sequences
    re.DOTALL,
)
LINE_BREAKS = re.compile(r"[\t\n\v\f\r\x85\u2028\u2029]")
CONTROLS = re.compile(r"[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]")

GIT_ESCAPE = re.compile(rb'\\([0-3][0-7]{2}|[abtnvfr"\\])')
GIT_ESCAPES = {b"a": 7, b"b": 8, b"t": 9, b"n": 10, b"v": 11, b"f": 12, b"r": 13, b'"': 34, b"\\": 92}


def clean_text(value):
    text = ESCAPE_SEQUENCE.sub("", value)
    text = LINE_BREAKS.sub(" ", text)
    return CONTROLS.sub("", text)


def clean_json(value):
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, list):
        return [clean_json(item) for item in value]
    if isinstance(value, dict):
        return {clean_text(key): clean_json(item) for key, item in value.items()}
    return value


def git_path_bytes(path):
    """Undo git's C-style path quoting so links point at the real file."""
    raw = os.fsencode(path)
    if len(raw) < 2 or not (raw.startswith(b'"') and raw.endswith(b'"')):
        return raw

    def unescape(match):
        code = match.group(1)
        if len(code) == 3:
            return bytes([int(code, 8)])
        return bytes([GIT_ESCAPES[code]])

    return GIT_ESCAPE.sub(unescape, raw[1:-1])


def file_link(root, path):
    raw = git_path_bytes(path)
    uri = "file://" + quote(os.fsencode(root) + b"/" + raw, safe="/")
    return uri, clean_text(raw.decode("utf-8", "replace"))


def write_lines(lines):
    sys.stdout.buffer.write("".join(f"{line}\n" for line in lines).encode("utf-8", "replace"))


def main(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command == "json":
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"), strict=False)
        write_lines([json.dumps(clean_json(data), ensure_ascii=False)])
    elif command == "text":
        write_lines(clean_text(value) for value in argv[2:])
    elif command == "file-links" and len(argv) > 2:
        write_lines("\t".join(file_link(argv[2], path)) for path in argv[3:])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
