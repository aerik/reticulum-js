"""
Connect to a JS TCPServerInterface and dump all received data as hex.
Shows HDLC frames as they arrive.

Usage: python scripts/debug-tcp-capture.py <host> <port> [duration_seconds]
"""
import socket
import sys
import time

HDLC_FLAG = 0x7E
HDLC_ESC = 0x7D
HDLC_ESC_MASK = 0x20

def hdlc_unescape(frame_bytes):
    out = bytearray()
    i = 0
    while i < len(frame_bytes):
        if frame_bytes[i] == HDLC_ESC and i + 1 < len(frame_bytes):
            out.append(frame_bytes[i+1] ^ HDLC_ESC_MASK)
            i += 2
        else:
            out.append(frame_bytes[i])
            i += 1
    return bytes(out)

def main():
    host = sys.argv[1] if len(sys.argv) > 1 else '127.0.0.1'
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 15242
    duration = int(sys.argv[3]) if len(sys.argv) > 3 else 30

    print(f"Connecting to {host}:{port}...")
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.connect((host, port))
    s.settimeout(1.0)
    print(f"Connected. Capturing for {duration}s...")

    buf = bytearray()
    frame_count = 0
    start = time.time()

    while time.time() - start < duration:
        try:
            data = s.recv(4096)
            if not data:
                break
            buf.extend(data)

            # Extract HDLC frames
            while True:
                try:
                    first = buf.index(HDLC_FLAG)
                except ValueError:
                    buf.clear()
                    break

                try:
                    second = buf.index(HDLC_FLAG, first + 1)
                except ValueError:
                    if first > 0:
                        del buf[:first]
                    break

                frame_escaped = bytes(buf[first+1:second])
                del buf[:second]

                if len(frame_escaped) == 0:
                    continue

                frame = hdlc_unescape(frame_escaped)
                frame_count += 1

                # Parse basic packet header
                if len(frame) >= 2:
                    flags = frame[0]
                    hops = frame[1]
                    ifac = (flags >> 7) & 1
                    header_type = (flags >> 6) & 1
                    context_flag = (flags >> 5) & 1
                    transport_type = (flags >> 4) & 1
                    dest_type = (flags >> 2) & 3
                    packet_type = flags & 3

                    type_names = ['DATA', 'ANNOUNCE', 'LINKREQ', 'PROOF']
                    dest_names = ['SINGLE', 'GROUP', 'PLAIN', 'LINK']

                    print(f"\n--- Frame #{frame_count} ({len(frame)} bytes) ---")
                    print(f"  Flags: 0x{flags:02x} (ifac={ifac} hdr={header_type} ctx={context_flag} "
                          f"tpt={transport_type} dest={dest_names[dest_type]} type={type_names[packet_type]})")
                    print(f"  Hops: {hops}")

                    if packet_type == 1:  # ANNOUNCE
                        if header_type == 0:  # HEADER_1
                            dest_hash = frame[2:18].hex()
                            context = frame[18]
                            pubkey = frame[19:83].hex() if len(frame) > 82 else '?'
                            name_hash = frame[83:93].hex() if len(frame) > 92 else '?'
                            print(f"  Dest hash: {dest_hash}")
                            print(f"  Context: 0x{context:02x}")
                            print(f"  PubKey (64b): {pubkey[:32]}...{pubkey[-8:]}")
                            print(f"  NameHash (10b): {name_hash}")

                    print(f"  Raw hex: {frame[:40].hex()}{'...' if len(frame) > 40 else ''}")

                    # Try to validate with Python RNS if it's an announce
                    if packet_type == 1:
                        try:
                            import RNS
                            from RNS.Packet import Packet
                            p = Packet(None, frame)
                            if p:
                                print(f"  Python parse: OK")
                        except Exception as e:
                            print(f"  Python parse: FAILED - {e}")

        except socket.timeout:
            continue

    s.close()
    print(f"\nDone. Captured {frame_count} frames in {duration}s.")

if __name__ == '__main__':
    main()
