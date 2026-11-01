#!/usr/bin/env python3
"""Stdlib JSON RPC over the native Codex Unix WebSocket transport.

Derived from the verified image/codex-remote-project client. RPC errors deliberately
omit server payloads, which can contain private conversation data.
"""

import base64
import hashlib
import json
import os
import socket
import struct


class Rpc:
    def __init__(self, path, timeout=15):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(timeout)
        self.buffer = b""
        self.sequence = 0
        try:
            self.socket.connect(path)
            key = base64.b64encode(os.urandom(16)).decode()
            self.socket.sendall((
                "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
                f"Sec-WebSocket-Key: {key}\r\n\r\n"
            ).encode())
            while b"\r\n\r\n" not in self.buffer:
                self._receive()
                if len(self.buffer) > 16384:
                    raise RuntimeError("Invalid Codex WebSocket handshake")
            headers, self.buffer = self.buffer.split(b"\r\n\r\n", 1)
            lines = headers.decode("ascii").split("\r\n")
            fields = {name.lower(): value.strip() for name, value in
                      (line.split(":", 1) for line in lines[1:] if ":" in line)}
            expected = base64.b64encode(hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
            ).digest()).decode()
            if (lines[0].split()[1] != "101" or
                    fields.get("sec-websocket-accept") != expected):
                raise RuntimeError("Codex WebSocket handshake was rejected")
            self.call("initialize", {
                "clientInfo": {"name": "devbox_catalog_sync", "version": "1.0.0"},
                "capabilities": {"experimentalApi": True},
            })
            self.send({"method": "initialized"})
        except BaseException:
            self.close()
            raise

    def close(self):
        self.socket.close()

    def _receive(self):
        data = self.socket.recv(65536)
        if not data:
            raise RuntimeError("Codex closed its local connection")
        self.buffer += data

    def _read(self, length):
        while len(self.buffer) < length:
            self._receive()
        data, self.buffer = self.buffer[:length], self.buffer[length:]
        return data

    def _send_frame(self, opcode, payload):
        length = len(payload)
        header = bytes([0x80 | opcode])
        if length < 126:
            header += bytes([0x80 | length])
        elif length < 65536:
            header += bytes([0x80 | 126]) + struct.pack("!H", length)
        else:
            header += bytes([0x80 | 127]) + struct.pack("!Q", length)
        mask = os.urandom(4)
        encoded = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        self.socket.sendall(header + mask + encoded)

    def send(self, value):
        self._send_frame(1, json.dumps(value).encode())

    def receive(self):
        parts = []
        total = 0
        while True:
            first, second = self._read(2)
            opcode, length = first & 15, second & 127
            if first & 0x70 or second & 0x80:
                raise RuntimeError("Unsupported Codex WebSocket frame")
            if length == 126:
                length = struct.unpack("!H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read(8))[0]
            if length > 32 * 1024 * 1024:
                raise RuntimeError("Codex response exceeds 32 MiB")
            payload = self._read(length)
            if opcode == 8:
                raise RuntimeError("Codex closed its local connection")
            if opcode == 9:
                self._send_frame(10, payload)
                continue
            if opcode == 10:
                continue
            if opcode not in (0, 1):
                raise RuntimeError("Expected a JSON Codex response")
            total += len(payload)
            if total > 32 * 1024 * 1024:
                raise RuntimeError("Codex response exceeds 32 MiB")
            parts.append(payload)
            if first & 0x80:
                return json.loads(b"".join(parts))

    def call(self, method, params):
        self.sequence += 1
        request_id = self.sequence
        self.send({"id": request_id, "method": method, "params": params})
        for _ in range(10000):
            response = self.receive()
            if "method" in response or response.get("id") != request_id:
                continue
            if "error" in response:
                # Avoid printing response payloads that might include chat text.
                raise RuntimeError(f"Codex {method} failed (code {response['error'].get('code')})")
            return response["result"]
        raise RuntimeError("Codex request did not receive a response")
