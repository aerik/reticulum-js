# CLI Tools

## rnstatus

Display the status of a Reticulum node: identity, interfaces, path table, known destinations.

```bash
node bin/rnstatus.js [--config <dir>] [--json]
```

### Options

| Flag | Description |
|------|-------------|
| `--config <dir>` | Config directory (default: `~/.reticulum`) |
| `--json` | Output as JSON |

### Example

```
$ node bin/rnstatus.js --config .rns_test_config

Reticulum Node.js Status
========================

Config directory : .rns_test_config
Transport enabled: false
Transport identity: 9f2032ea4eb792a15ddb6d1c6c97bd62

Interfaces (1):
  [enabled] Default Interface (AutoInterface)

Known destinations: 0
Path table entries: 0
Packet hashlist: 0 entries
```

### JSON output

```json
{
  "configDir": ".rns_test_config",
  "identity": "9f2032ea4eb792a15ddb6d1c6c97bd62",
  "transport": false,
  "interfaces": [
    { "name": "Default Interface", "type": "AutoInterface", "enabled": true }
  ],
  "knownDestinations": 0,
  "pathTableEntries": 0,
  "packetHashlistSize": 0
}
```

## rnpath

Request and display a path to a destination.

```bash
node bin/rnpath.js <destination_hash> [--config <dir>] [--timeout <ms>]
```

### Options

| Flag | Description |
|------|-------------|
| `<destination_hash>` | 32-character hex hash of the destination |
| `--config <dir>` | Config directory |
| `--timeout <ms>` | Path request timeout (default: 15000) |

### Example

```
$ node bin/rnpath.js ff41470c0c58afeb129103a5753bbc0f

Looking up path to ff41470c0c58afeb129103a5753bbc0f...
Connected via 1 interface(s). Requesting path...

Path to ff41470c0c58afeb129103a5753bbc0f:
  Hops     : 7
  Interface: Dublin
  Expires  : 167h 59m
  Identity : 72c2c02b87862416a998cba2b3675805
```

## npm scripts

```bash
npm run rnstatus -- --config .rns_test_config
npm run rnpath -- ff41470c0c58afeb129103a5753bbc0f
```

## Installing globally

```bash
npm link
# Now available as system commands:
rnstatus
rnpath ff41470c0c58afeb129103a5753bbc0f
```
