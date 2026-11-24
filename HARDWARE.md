# ESP32 and DHT22 setup

## Wiring

With the ESP32 development board unpowered, connect DHT22 VCC to **3V3**, DATA to **GPIO 27**, and GND to **GND**. For a bare four-pin DHT22, leave the unused pin disconnected and add a **4.7–10 kΩ** resistor from DATA to 3V3. Check the labels on your sensor before wiring.

## Local dashboard

1. Run `npm start` and open http://127.0.0.1:3000 on the server PC.
2. In Arduino IDE, install **esp32 by Espressif Systems**, **DHT sensor library** by Adafruit, and **Adafruit Unified Sensor**. Select your board and serial port.
3. In Atmos, open **Device setup** and download the configured sketch. Save it as `atmos_sensor/atmos_sensor.ino`. Fill in the 2.4 GHz Wi-Fi credentials and confirm that the server URL uses the PC's LAN address.
4. Upload the sketch, open Serial Monitor at **115200 baud**, and select **Device** in Atmos. HTTP 201 indicates a new reading and 200 indicates an accepted retry.

Keep the ESP32 and PC on the same trusted LAN. If the board cannot connect, check the PC address, port, and firewall. A 401 usually means the device token did not match.

## Hosted uploads

Start from the [firmware sketch](firmware/atmos_sensor/atmos_sensor.ino). Create a local `secrets.h` beside it. Define `ATMOS_HOSTED_UPLOAD` and supply these `const char*` settings:

| Setting | Value |
| --- | --- |
| `WIFI_SSID`, `WIFI_PASSWORD` | Wi-Fi credentials |
| `SERVER_URL` | `https://atmos-roan.vercel.app/api/v1/readings` |
| `DEVICE_TOKEN` | Assigned production device token |
| `ATMOS_ROOT_CA` | Trusted root CA PEM for the HTTPS endpoint |

The board uses network time for certificate validation. Keep `secrets.h` private. The firmware samples approximately every six seconds and buffers up to 100 samples in RAM during interruptions.
