# Atmos — local climate observatory

## Dissertation workspace

This version saves measurements in `../data/measurements/` and its generated device token in `../data/local.config.json`, outside the source repository. Override these paths using `ATMOS_DATA_DIR` and `ATMOS_CONFIG_PATH` when deploying elsewhere. Project concept, acceptance criteria and findings are recorded in `../data/CONCEPT.md`.

The current persistence format is JSONL. A database remains a thesis requirement to implement or confirm with the mentor. The automated server tests do not verify the physical sensor.

A modern local dashboard for **ESP32-WROOM-32D + AM2302 / DHT22**, sampling **every 6 seconds (10 readings per minute)**. The server, charts, icons, and fonts work without an internet connection. There are no runtime packages to install.

## 1. Start the dashboard

On Windows, double-click **start.cmd** and keep the window open.

The launcher asks Windows to open the dashboard in your default browser. If Atmos is already running, it reuses that server rather than trying to start another copy, and keeps the status window open until you press a key. If the browser does not appear, use the dashboard URL printed in the window. If another application owns the selected port, it reports that conflict without stopping the other application or changing the ESP32's endpoint.

Or, with Node.js 20 or newer installed, open a terminal in this folder and run:

```powershell
node server.mjs
```

Open **http://127.0.0.1:3000** on this PC. The server listens on port 3000 on your local network. A custom port can be set with `$env:PORT = '3001'` before starting it.

The dashboard starts in a clearly labelled **Demo** mode if no device data exists. Demo values are generated in the browser, never uploaded or written to sensor logs. The first real reading automatically switches it to Device unless you explicitly chose a mode. Use the **Device / Demo** buttons at any time.

Overview includes current temperature/humidity, 15-minute/1-hour/6-hour/24-hour history, hover and keyboard chart inspection, statistics for the selected window, dew point, signal strength, last measurement time, and CSV export. A reading becomes **stale after 20 seconds**. The temperature reference band is a simple UI reference, not a configurable alarm or a health assessment.

Device setup's wiring illustration reflects the actual live device connection: the wire ends join with a glow and moving electrical pulses while real measurements are fresh. They separate when readings are more than 20 seconds old or the browser loses the server connection. Demo readings do not turn the wires on. The illustration represents received telemetry, not a physical electrical continuity test. Reduced-motion preferences disable the animation.

## 2. Wire the DHT22

These instructions assume a USB development board containing the WROOM-32D module. A bare WROOM module additionally needs appropriate regulated power, boot circuitry, and a USB-to-serial programmer.

Disconnect power before wiring. Use a short cable, under 1 metre for this 3.3V setup.

| DHT22 / AM2302 | ESP32 development board |
|---|---|
| VCC / + | 3V3 |
| DATA / OUT | GPIO 27 |
| GND / − | GND |

For a bare 4-pin DHT22, facing the vented front with pins downward, the usual order is **VCC, DATA, not connected, GND**. Verify your particular sensor's labels/datasheet; module layouts and cable colours vary. Leave the unused pin disconnected.

Add a **4.7k–10kΩ pull-up resistor from DATA to 3V3** unless your sensor module already includes one. Keep the ESP32 signal at 3.3V; do not pull DATA to 5V. Place the sensor away from the ESP32's heat, direct sunlight, and drafts if you want representative room measurements.

## 3. Prepare Arduino IDE

1. In Preferences → Additional Boards Manager URLs, add:

   ```text
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```

2. In Boards Manager, install **esp32 by Espressif Systems**. Select your actual board under Tools → Board. For a generic original ESP32/WROOM development board, choose **ESP32 Dev Module**. Select the correct COM port.
3. In Library Manager install **DHT sensor library by Adafruit**, plus **Adafruit Unified Sensor** if Arduino does not install it automatically. `WiFi` and `HTTPClient` come with the ESP32 board package.
4. On this PC, open the dashboard → **Device setup** → **Download Arduino sketch**. The generated file contains your PC's detected LAN address and the device token. This download is available only from loopback (`127.0.0.1` or `localhost`). Keep the token private.
5. Put the file in a folder named `atmos_sensor`, then open `atmos_sensor.ino`. Arduino IDE can create the matching sketch folder if prompted. Alternatively, open the template at `firmware/atmos_sensor/atmos_sensor.ino` and edit all four configuration values yourself.
6. Edit `WIFI_SSID` and `WIFI_PASSWORD` near the top. Use a **2.4 GHz Wi-Fi network** accessible to the ESP32. Escape `"` and `\` in C++ string literals if your credentials contain them.
7. Verify `SERVER_URL`: it must use **your PC's LAN IPv4 address**, for example `http://192.168.1.6:3000/api/readings`. Never use `localhost` on the ESP32. If multiple network adapters exist, choose the address on the ESP32's network. Set `DEVICE_TOKEN` from Device setup if using the template. Leave `DEVICE_ID` as `esp32-room-01`.
8. Upload. Open Serial Monitor at **115200 baud**. A successful upload prints `Uploaded (201)`; a retry already stored by the server prints `Uploaded (200)`.
9. Choose **Device** in the dashboard to observe real readings.

Official references: [ESP32 installation](https://docs.espressif.com/projects/arduino-esp32/en/latest/installing.html), [board selection](https://docs.espressif.com/projects/arduino-esp32/en/latest/guides/tools_menu.html), [Adafruit DHT library](https://github.com/adafruit/DHT-sensor-library), [AM2302 manual](https://www.aosong.com/uploadfiles/2025/04/20250417105409216.pdf).

## Network and troubleshooting

- Keep the server terminal open. The PC and ESP32 must be on the same LAN; the PC may use Wi-Fi or Ethernet. The original ESP32 uses 2.4 GHz Wi-Fi.
- If Windows Firewall asks, allow the Node.js server on your **private network**. This project does not change firewall rules automatically.
- If uploads cannot connect, check the PC's IP (`ipconfig`), port 3000, firewall, and router guest/client isolation. From another device on the LAN, try `http://YOUR_PC_IP:3000/api/status`.
- `401`: token mismatch. Download the sketch again, or copy the token from Device setup. `400`: check payload/reading validity. Negative HTTP codes usually mean a network connection failed.
- `DHT22 read failed`: check wiring, power, GPIO 27, resistor, and library installation. Never connect the sensor's unused pin to DATA.
- If the PC's IP changes, update the sketch and reflash. A router DHCP reservation makes the IP stable.
- If upload stalls at “Connecting”, some development boards need the BOOT button held during initial connection. Confirm your board and COM port.
- When another device views the dashboard, token access and configured sketch downloads remain restricted to the server PC. Readings themselves are visible to devices that can reach the local server.
- If Node is missing, install a current Node.js LTS release from [nodejs.org](https://nodejs.org/) and reopen your terminal. `start.cmd` also recognizes the bundled Node runtime on this computer.

## Data, reliability, and limits

- Real readings are appended to **`data/YYYY-MM-DD.jsonl`**, using UTC dates. Demo readings stay in the browser.
- Overview keeps the latest **24 hours** of live data (up to 20,000 rows). **Reading log** has a date filter next to the live connection controls: Last 15 minutes, Last hour, Last 24 hours, Today, Yesterday, Last 7 days, All saved data, or Custom dates & times. The log shows the latest 100 matches; **Export CSV exports every matching saved reading**, including older daily files. Export from Overview continues to use the latest 24 hours.
- The date filter uses your browser's local timezone. Today/Yesterday follow local calendar boundaries, including daylight-saving changes. Custom dates include the entire selected end minute. CSV timestamps remain UTC. Empty or reversed ranges show a clear message. Demo filtering and exports remain separate and cover only the simulated 24-hour history.
- In the same filter, **Measurements in CSV** lets you check **Temperature**, **Humidity**, or both (the default). Apply the filter, then Export CSV. Only the selected measurement columns appear in the file; timestamps, device ID, signal, uptime, and source remain included. The selection works with custom dates, all saved data, and demo exports. CSV filenames include the selected measurements. Reset restores the latest 24 hours and both measurements.
- Daily files are retained indefinitely and continue to consume disk space; copy/archive them as needed while the server is stopped. No database or automatic log deletion is included. CSV rows follow the saved arrival order, with the original measurement and receipt timestamps preserved.
- The server acknowledges a sample only after its file append completes. It deduplicates reading IDs within the loaded 24-hour window, including after restart. Abrupt power loss is not equivalent to a database backup or guaranteed disk flush.
- ESP32 buffers **100 samples, about 10 minutes**, in RAM. It retries with backoff and drains the backlog at at most one upload per second. If the queue fills, the oldest sample is dropped and reported over Serial. RAM readings are lost if the ESP32 resets. The usual cadence is one sample every 6 seconds; network timeouts can introduce timing jitter.
- Each sample includes its age. The PC derives measurement time from receipt time minus that age. This works without internet/NTP, including outage backfill. The latest card follows measurement time so old buffered uploads do not replace a fresher measurement.
- The dashboard uses Server-Sent Events (SSE), automatically reconnects, and reloads history after reconnecting. Missing samples appear as chart gaps. Statistics use all samples in the selected window, with min/max-preserving downsampling for chart display.
- Sensor failures are logged over Serial and skipped; the dashboard marks the previous reading stale. There is no separate sensor-health heartbeat.
- The server supports **one configured device** in this first version. The UI has no login; it is intended for your trusted local network. Uploads require a random device token saved in ignored `local.config.json`. Local HTTP is not encrypted. Do not port-forward it or publish this server as-is.
- Keep the PC clock accurate. Measurement times are stored as UTC and displayed in the browser's local timezone.

## Source files

```text
server.mjs                            Local HTTP API, SSE, persistence, sketch download
dist/index.html                       Dashboard structure and inline icon definitions
dist/styles.css                       Responsive dashboard design
dist/app.js                           Charts, live feed, demo, log, CSV, setup
firmware/atmos_sensor/atmos_sensor.ino  Arduino IDE firmware template
start.cmd                             Windows launcher
tests/server.test.mjs                 Isolated API / persistence integration tests
```

Run `node --test tests/server.test.mjs` to verify authentication, validation, concurrent retry deduplication, persistence/recovery, SSE, CSV, and sketch generation. Test data goes into ignored `test-results/`, separate from real measurements.

Firmware compilation and a physical sensor upload need your Arduino board package, libraries, and connected hardware; they have not been verified by the local server tests.
