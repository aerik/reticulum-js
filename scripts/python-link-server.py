"""
Python RNS Link server for interop testing.

Runs a TCP server interface on localhost:14242.
Creates a destination, announces it, and echoes link data.

Usage: .venv/Scripts/python.exe scripts/python-link-server.py

First line of stdout: JSON with destination hash and server info.
Second line of stdout: JSON with test result.
"""

import sys
import time
import os
import json
import threading

config_dir = os.path.join(os.path.dirname(__file__), '..', '.rns_interop_config')
os.makedirs(config_dir, exist_ok=True)

# Write a config that sets up a TCP server on port 14242
config_content = """[reticulum]
  enable_transport = False
  share_instance = No

[logging]
  loglevel = 4

[interfaces]
  [[Interop TCP Server]]
    type = TCPServerInterface
    enabled = Yes
    listen_ip = 127.0.0.1
    listen_port = 14242
"""
config_path = os.path.join(config_dir, 'config')
with open(config_path, 'w') as f:
    f.write(config_content)

import RNS

reticulum = RNS.Reticulum(configdir=config_dir)

identity = RNS.Identity()

destination = RNS.Destination(
    identity,
    RNS.Destination.IN,
    RNS.Destination.SINGLE,
    "interop_test",
    "echo"
)

link_established = threading.Event()
test_data_received = threading.Event()
received_data = None
link_ref = None


def link_established_callback(link):
    global link_ref
    link_ref = link
    link.set_link_closed_callback(link_closed_callback)
    link.set_packet_callback(packet_callback)
    link_established.set()
    RNS.log("Link established!", RNS.LOG_NOTICE)


def link_closed_callback(link):
    RNS.log("Link closed", RNS.LOG_NOTICE)


def packet_callback(message, packet):
    global received_data
    received_data = message
    test_data_received.set()
    RNS.log(f"Received {len(message)} bytes: {message}", RNS.LOG_NOTICE)

    # Echo back with prefix
    if link_ref:
        echo_data = b"ECHO:" + message
        RNS.Packet(link_ref, echo_data).send()
        RNS.log(f"Echoed {len(echo_data)} bytes", RNS.LOG_NOTICE)


destination.set_link_established_callback(link_established_callback)

# Output info FIRST so the Node.js client can connect before we announce
info = {
    "ready": True,
    "destination_hash": destination.hash.hex(),
    "identity_public_key": identity.get_public_key().hex(),
    "identity_hash": identity.hash.hex(),
    "server_port": 14242,
}
print(json.dumps(info), flush=True)

# Delay to let the Node.js client connect, then announce
time.sleep(2)
destination.announce(app_data=b"Python Echo")
RNS.log(f"Announced destination {destination.hash.hex()}", RNS.LOG_NOTICE)

# Wait for test
RNS.log("Waiting for link connection...", RNS.LOG_NOTICE)

if link_established.wait(timeout=30):
    RNS.log("Link connected, waiting for data...", RNS.LOG_NOTICE)
    if test_data_received.wait(timeout=15):
        time.sleep(2)  # give echo time to send
        result = {"status": "ok", "received_hex": received_data.hex()}
    else:
        result = {"status": "timeout", "phase": "data"}
else:
    result = {"status": "timeout", "phase": "link"}

print(json.dumps(result), flush=True)
time.sleep(1)
reticulum.teardown()
