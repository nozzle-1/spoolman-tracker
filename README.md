# spoolman-tracker

Simple service that listens to supported 3D printers and updates spool weight in Spoolman.

## What it does

- Connects to printers through platform integrations
- Detects spool weight changes
- Updates `remaining_weight` in Spoolman

Current platform support:

- `bambulab`

## Configuration

The app reads its config from:

- `CONFIG_PATH`, if set
- `./config.json`, otherwise

Start from the example file:

```bash
cp config.example.json config.json
```

Main options:

- `logging.level`: `debug`, `info`, `warn`, or `error`
- `spoolman.baseUrl`: Spoolman API base URL
- `spoolman.apiKey`: optional API key
- `spoolman.timeoutMs`: optional HTTP timeout
- `spoolman.autoArchiveEmptySpool.enabled`: enables periodic archival of active spools whose `remaining_weight` is `0`
- `spoolman.autoArchiveEmptySpool.intervalSeconds`: archival interval in seconds
- `supervision.probeIntervalMs`: optional TCP probe interval
- `supervision.connectTimeoutMs`: optional TCP probe timeout
- `printers[]`: list of printers to monitor

Example:

```json
{
  "logging": {
    "level": "info"
  },
  "spoolman": {
    "baseUrl": "http://spoolman:7912/api/v1",
    "autoArchiveEmptySpool": {
      "enabled": true,
      "intervalSeconds": 3600
    }
  },
  "printers": [
    {
      "id": "x1c",
      "platform": "bambulab",
      "enabled": true,
      "host": "192.168.1.50",
      "serial": "01PXXXXXXXXXXXX",
      "accessCode": "12345678"
    }
  ]
}
```

## Run locally

```bash
npm install
npm start
```

Development mode:

```bash
npm run dev
```

Type check:

```bash
npm run check
```

## Run with Docker

Build:

```bash
docker build -t spoolman-tracker .
```

Run:

```bash
docker run --rm \
  -e CONFIG_PATH=/data/config.json \
  -v "$(pwd)/config.json:/data/config.json:ro" \
  spoolman-tracker
```
