"""
Test LXMF interop: receive messages from a JS node (or any LXMF sender) into Python.

Connects to the same RNS network as the JS rnsd, registers a Python LXMF
delivery destination, announces it, and prints any received messages with
their delivery method and signature status.

Usage:
    1. Start this script:
       python scripts/test-lxmf-recv.py [--rns-host rns.noderage.org] [--display-name "Recv"]

    2. Note the delivery destination hash printed in stdout, e.g.:
       Delivery destination: 518511706075ee55e328bcd41c863b2a

    3. From your JS rnsd (or any LXMF client), send a message to that hash.
       For example, with the rnsd HTTP API:
         curl -X POST http://localhost:4281/api/messages \
              -H 'Content-Type: application/json' \
              -d '{"destinationHash":"518511706075ee55e328bcd41c863b2a",
                   "title":"hi","content":"hello python","method":"opportunistic"}'

    4. This script will print each received message and stay running until
       Ctrl+C.
"""

import sys
import os
import time
import argparse
import shutil


def main():
    parser = argparse.ArgumentParser(description='LXMF receiver for interop testing')
    parser.add_argument('--rns-host', default='rns.noderage.org', help='RNS network host (client mode)')
    parser.add_argument('--rns-port', type=int, default=4242, help='RNS network port (client mode)')
    parser.add_argument('--listen', action='store_true',
                        help='Run as TCPServerInterface on --listen-port instead of '
                             'connecting to a public network. Lets JS senders connect '
                             'directly without ingress-limit issues.')
    parser.add_argument('--listen-ip', default='127.0.0.1', help='Listen address (--listen mode)')
    parser.add_argument('--listen-port', type=int, default=14242, help='Listen port (--listen mode)')
    parser.add_argument('--display-name', default='Python Recv',
                        help='Display name announced for the delivery destination')
    parser.add_argument('--config-dir', default=None,
                        help='RNS config dir (default: scripts/.lxmf_recv_config)')
    parser.add_argument('--reset', action='store_true',
                        help='Wipe the config dir to get a fresh identity')
    parser.add_argument('--enable-propagation', action='store_true',
                        help='Also enable a propagation node (so JS PROPAGATED can target us)')
    args = parser.parse_args()

    config_dir = args.config_dir or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '.lxmf_recv_config'
    )
    if args.reset and os.path.exists(config_dir):
        shutil.rmtree(config_dir)
    os.makedirs(config_dir, exist_ok=True)

    if args.listen:
        iface_block = f"""  [[Interop TCP Server]]
    type = TCPServerInterface
    enabled = yes
    listen_ip = {args.listen_ip}
    listen_port = {args.listen_port}
"""
    else:
        iface_block = f"""  [[RNS Network]]
    type = TCPClientInterface
    enabled = yes
    target_host = {args.rns_host}
    target_port = {args.rns_port}
"""

    config = f"""[reticulum]
  enable_transport = False
  share_instance = No
[logging]
  loglevel = 7
[interfaces]
{iface_block}"""
    with open(os.path.join(config_dir, 'config'), 'w') as f:
        f.write(config)

    import RNS
    import LXMF

    print("=== LXMF Receiver ===")
    if args.listen:
        print(f"  Mode    : LISTEN  ({args.listen_ip}:{args.listen_port})")
    else:
        print(f"  Mode    : CLIENT  ({args.rns_host}:{args.rns_port})")
    print()

    reticulum = RNS.Reticulum(configdir=config_dir)

    # Persistent identity (so the destination hash is stable across runs).
    identity_path = os.path.join(config_dir, 'recv_identity')
    if os.path.exists(identity_path):
        recv_identity = RNS.Identity.from_file(identity_path)
        print(f"  Loaded identity: {recv_identity.hexhash}")
    else:
        recv_identity = RNS.Identity()
        recv_identity.to_file(identity_path)
        print(f"  Generated new identity: {recv_identity.hexhash}")

    # LXMF router with delivery + (optional) propagation
    router = LXMF.LXMRouter(
        identity=recv_identity,
        storagepath=os.path.join(config_dir, 'lxmf'),
        autopeer=True,
    )

    delivery_destination = router.register_delivery_identity(
        recv_identity, display_name=args.display_name
    )

    if args.enable_propagation:
        router.enable_propagation()
        print(f"  Propagation: ENABLED")
        if router.propagation_destination:
            print(f"  Propagation destination: {router.propagation_destination.hexhash}")

    print(f"  Delivery destination: {delivery_destination.hexhash}")
    print()

    received_count = [0]

    def on_message(message):
        received_count[0] += 1
        method_name = {
            LXMF.LXMessage.OPPORTUNISTIC: 'opportunistic',
            LXMF.LXMessage.DIRECT: 'direct',
            LXMF.LXMessage.PROPAGATED: 'propagated',
        }.get(message.method, f'unknown({message.method})')

        sig = 'VALID' if message.signature_validated else 'UNVERIFIED'

        print()
        print(f"--- Received #{received_count[0]} ({method_name}, sig={sig}) ---")
        print(f"  From  : {RNS.prettyhexrep(message.source_hash) if message.source_hash else '?'}")
        print(f"  To    : {RNS.prettyhexrep(message.destination_hash)}")
        print(f"  Title : {message.title_as_string()!r}")
        print(f"  Body  : {message.content_as_string()!r}")
        if message.fields:
            print(f"  Fields: {message.fields}")
        sys.stdout.flush()

    router.register_delivery_callback(on_message)

    # Announce the delivery destination so JS senders can resolve it
    delivery_destination.announce()
    print("Announced delivery destination. Waiting for messages... (Ctrl+C to stop)")
    print()
    sys.stdout.flush()

    # Re-announce periodically
    last_announce = time.time()
    try:
        while True:
            time.sleep(1)
            if time.time() - last_announce > 60:
                delivery_destination.announce()
                if args.enable_propagation and router.propagation_destination:
                    router.propagation_destination.announce(
                        app_data=router.get_propagation_node_app_data() if hasattr(router, 'get_propagation_node_app_data') else None
                    )
                last_announce = time.time()
    except KeyboardInterrupt:
        print()
        print(f"Stopping. Received {received_count[0]} messages total.")
        try:
            reticulum.teardown_all()
        except Exception:
            pass


if __name__ == '__main__':
    main()
