"""
Test LXMF interop: send a message from Python to the JS node.

Connects to the same RNS network as the JS rnsd, discovers the JS node's
lxmf.delivery destination via announce, and sends a direct LXMF message.

Usage:
    1. Start the JS node:
       node bin/rnsd.js --config /tmp/rnsd-test --lxmf --http 4281 -v

    2. Note the delivery destination hash printed in the JS output, e.g.:
       Delivery: 518511706075ee55e328bcd41c863b2a

    3. Run this script:
       python scripts/test-lxmf-send.py <dest_hash>

    4. Check http://localhost:4281/api/messages for the delivered message.
"""

import sys
import os
import time
import argparse

def main():
    parser = argparse.ArgumentParser(description='Send test LXMF message to JS node')
    parser.add_argument('dest_hash', help='Hex destination hash of the JS lxmf.delivery destination')
    parser.add_argument('--rns-host', default='rns.noderage.org', help='RNS network host')
    parser.add_argument('--rns-port', type=int, default=4242, help='RNS network port')
    parser.add_argument('--message', default='Hello from Python LXMF!', help='Message content')
    parser.add_argument('--title', default='Test Message', help='Message title')
    parser.add_argument('--timeout', type=int, default=60, help='Timeout in seconds')
    args = parser.parse_args()

    # Set up a temporary RNS config
    config_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.lxmf_test_config')
    os.makedirs(config_dir, exist_ok=True)

    config = f"""[reticulum]
  enable_transport = False
  share_instance = No
[logging]
  loglevel = 7
[interfaces]
  [[RNS Network]]
    type = TCPClientInterface
    enabled = yes
    target_host = {args.rns_host}
    target_port = {args.rns_port}
"""
    with open(os.path.join(config_dir, 'config'), 'w') as f:
        f.write(config)

    import RNS
    import LXMF

    print("=== LXMF Interop Test ===")
    print(f"  Target: {args.dest_hash}")
    print(f"  Network: {args.rns_host}:{args.rns_port}")
    print()

    reticulum = RNS.Reticulum(configdir=config_dir)

    # Create our sender identity
    sender_identity = RNS.Identity()
    print(f"  Sender identity: {sender_identity.hexhash}")

    # Set up LXMF router
    router = LXMF.LXMRouter(identity=sender_identity, storagepath=os.path.join(config_dir, 'lxmf'))

    # Register our delivery destination (needed to send)
    sender_destination = router.register_delivery_identity(sender_identity, display_name="Python Test Sender")

    # Parse destination hash
    dest_hash = bytes.fromhex(args.dest_hash)

    print(f"  Waiting for path to {args.dest_hash}...")

    # Wait for announces to arrive, then request path
    time.sleep(5)

    # Request path to the destination
    RNS.Transport.request_path(dest_hash)

    # Wait for both identity and path to become available
    start = time.time()
    dest_identity = None
    while time.time() - start < args.timeout:
        dest_identity = RNS.Identity.recall(dest_hash)
        has_path = RNS.Transport.has_path(dest_hash)
        if dest_identity and has_path:
            break
        # Re-request path periodically
        if int(time.time() - start) % 10 == 0 and int(time.time() - start) > 0:
            RNS.Transport.request_path(dest_hash)
        time.sleep(1)

    if not dest_identity:
        print(f"  ERROR: Could not discover identity for {args.dest_hash}")
        print(f"  The JS node must announce its lxmf.delivery destination first.")
        print(f"  Make sure both nodes are connected to the same RNS network.")
        sys.exit(1)

    if not RNS.Transport.has_path(dest_hash):
        print(f"  ERROR: Found identity but no path to {args.dest_hash}")
        print(f"  The network path may not be established yet. Try again.")
        sys.exit(1)

    print(f"  Found identity: {dest_identity.hexhash}")
    print(f"  Path available: {RNS.Transport.has_path(dest_hash)}")

    # Create destination
    destination = RNS.Destination(dest_identity, RNS.Destination.OUT, RNS.Destination.SINGLE, "lxmf", "delivery")
    print(f"  Destination hash check: {destination.hexhash} (should match {args.dest_hash})")

    if destination.hexhash != args.dest_hash:
        print(f"  WARNING: Destination hash mismatch!")

    # Create LXMF message
    lxm = LXMF.LXMessage(
        destination,
        sender_destination,
        args.message,
        title=args.title,
        desired_method=LXMF.LXMessage.DIRECT,
    )

    # Track delivery status
    delivery_status = {"done": False, "success": False}

    def delivery_callback(message):
        print(f"  Delivery callback: state={message.state}")
        if message.state == LXMF.LXMessage.DELIVERED:
            delivery_status["done"] = True
            delivery_status["success"] = True
            print(f"  ✓ Message DELIVERED!")
        elif message.state == LXMF.LXMessage.FAILED:
            delivery_status["done"] = True
            delivery_status["success"] = False
            print(f"  ✗ Message FAILED")

    lxm.delivery_callback = delivery_callback
    lxm.failed_callback = delivery_callback

    # Send
    print(f"\n  Sending message: \"{args.title}\" — \"{args.message}\"")
    router.handle_outbound(lxm)

    # Wait for delivery
    start = time.time()
    while time.time() - start < args.timeout and not delivery_status["done"]:
        time.sleep(0.5)

    if delivery_status["success"]:
        print(f"\n  SUCCESS! Message delivered in {time.time() - start:.1f}s")
        print(f"  Check http://localhost:4281/api/messages to see it")
    elif delivery_status["done"]:
        print(f"\n  FAILED: Message delivery failed after {time.time() - start:.1f}s")
    else:
        print(f"\n  TIMEOUT: No delivery confirmation after {args.timeout}s")
        print(f"  Message state: {lxm.state}, progress: {lxm.progress}")

    # Clean up
    time.sleep(2)
    try:
        reticulum.teardown_all()
    except:
        pass

if __name__ == '__main__':
    main()
