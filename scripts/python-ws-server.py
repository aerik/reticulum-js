"""
Python RNS node with WebSocket server interface for interop testing.

Listens on ws://127.0.0.1:18765, announces a destination,
and echoes link data.

Usage: .venv/Scripts/python.exe scripts/python-ws-server.py
"""

import sys
import os
import json
import time
import threading

config_dir = os.path.join(os.path.dirname(__file__), '..', '.rns_ws_interop_config')
os.makedirs(config_dir, exist_ok=True)

# Install WebSocket interface
iface_dir = os.path.join(config_dir, 'interfaces')
os.makedirs(iface_dir, exist_ok=True)

# Copy our WebSocketInterface to the interfaces dir
import shutil
src_iface = os.path.join(os.path.dirname(__file__), '..', 'python', 'WebSocketInterface.py')
shutil.copy2(src_iface, os.path.join(iface_dir, 'WebSocketInterface.py'))

config_content = """[reticulum]
  enable_transport = False
  share_instance = No

[logging]
  loglevel = 4

[interfaces]
  [[WebSocket Server]]
    type = WebSocketInterface
    enabled = yes
    mode = server
    listen_ip = 127.0.0.1
    listen_port = 18765
"""
with open(os.path.join(config_dir, 'config'), 'w') as f:
    f.write(config_content)

import RNS

reticulum = RNS.Reticulum(configdir=config_dir)

identity = RNS.Identity()
destination = RNS.Destination(
    identity, RNS.Destination.IN, RNS.Destination.SINGLE,
    "ws_interop", "echo"
)

link_established = threading.Event()
test_data_received = threading.Event()
received_data = None
link_ref = None


def on_link(link):
    global link_ref
    link_ref = link
    link.set_packet_callback(on_packet)
    link_established.set()
    RNS.log("Link established!", RNS.LOG_NOTICE)


def on_packet(message, packet):
    global received_data
    received_data = message
    test_data_received.set()
    RNS.log(f"Received: {message}", RNS.LOG_NOTICE)
    if link_ref:
        RNS.Packet(link_ref, b"ECHO:" + message).send()


destination.set_link_established_callback(on_link)

# Output info FIRST, then announce after a delay
info = {
    "ready": True,
    "destination_hash": destination.hash.hex(),
    "identity_public_key": identity.get_public_key().hex(),
    "identity_hash": identity.hash.hex(),
    "ws_port": 18765,
}
print(json.dumps(info), flush=True)

time.sleep(2)
destination.announce(app_data=b"Python WS Echo")

if link_established.wait(timeout=30):
    if test_data_received.wait(timeout=15):
        time.sleep(2)
        print(json.dumps({"status": "ok", "received_hex": received_data.hex()}), flush=True)
    else:
        print(json.dumps({"status": "timeout", "phase": "data"}), flush=True)
else:
    print(json.dumps({"status": "timeout", "phase": "link"}), flush=True)

time.sleep(1)
reticulum.teardown()
