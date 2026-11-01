#!/usr/bin/env python3
"""Run plane-mcp-server with Cloudflare Access service-token headers injected.

plane-mcp-server (and the underlying `plane` SDK) builds its HTTP headers
internally and offers no way to add the CF-Access-Client-Id/Secret pair that
Cloudflare Access service-token auth requires. This shim monkeypatches
requests.Session.request to add them, then hands control to the unmodified
plane-mcp-server entry point.

MCP config usage (replaces `uvx plane-mcp-server stdio`):

  "command": "uv",
  "args": ["run", "--with", "plane-mcp-server",
           "/path/to/zero-trust/shims/plane-mcp-cf-shim.py", "stdio"],
  "env": {
    "PLANE_API_KEY": "...", "PLANE_WORKSPACE_SLUG": "...",
    "PLANE_BASE_URL": "https://plane.example.com",
    "CF_ACCESS_CLIENT_ID": "<service token client id>",
    "CF_ACCESS_CLIENT_SECRET": "<service token client secret>"
  }

If the CF_ACCESS_* vars are absent the shim is a transparent no-op.
"""
import os

import requests

_CID = os.environ.get("CF_ACCESS_CLIENT_ID")
_SECRET = os.environ.get("CF_ACCESS_CLIENT_SECRET")

_orig_request = requests.sessions.Session.request


def _patched_request(self, method, url, **kwargs):
    if _CID and _SECRET:
        headers = kwargs.get("headers") or {}
        headers.setdefault("CF-Access-Client-Id", _CID)
        headers.setdefault("CF-Access-Client-Secret", _SECRET)
        kwargs["headers"] = headers
    return _orig_request(self, method, url, **kwargs)


requests.sessions.Session.request = _patched_request

from plane_mcp.__main__ import main  # noqa: E402  (patch must precede import)

main()
