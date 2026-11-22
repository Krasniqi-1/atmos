/*
 * ATMOS — ESP32-WROOM-32D + AM2302 / DHT22
 * Arduino IDE: install "esp32" by Espressif Systems,
 * "DHT sensor library" by Adafruit, and "Adafruit Unified Sensor".
 * Board: your actual ESP32 board, or ESP32 Dev Module for a generic WROOM board.
 * Wiring: sensor VCC -> 3V3, GND -> GND, DATA -> GPIO27.
 * Bare sensor: add a 4.7k–10k ohm pull-up from DATA to 3V3.
 * Keep 3.3V sensor wiring short (under 1 m). Never pull DATA up to 5V.
 *
 * Local HTTP prototype. Do not expose this server to the public internet.
 * No internet/NTP is needed: the PC derives measurement time from sample age.
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <DHT.h>
#include <esp_system.h>

#if __has_include("secrets.h")
#include "secrets.h"
#else
// EDIT THESE FOUR VALUES. Use your PC's LAN IPv4, never "localhost".
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL = "http://YOUR_PC_IP:3000/api/readings";
const char* DEVICE_TOKEN = "YOUR_DEVICE_TOKEN";
#endif

#ifdef ATMOS_HOSTED_UPLOAD
#include <WiFiClientSecure.h>
#include <time.h>
constexpr time_t MIN_VALID_CLOCK = 1735689600; // 1 January 2025 UTC
#endif

const char* DEVICE_ID = "esp32-room-01";
constexpr uint8_t DHT_PIN = 27;
constexpr uint32_t SAMPLE_INTERVAL_MS = 6000; // 10 readings / minute
constexpr uint16_t QUEUE_CAPACITY = 100;     // ~10 minutes; RAM only
DHT dht(DHT_PIN, DHT22);

struct Sample {
  float temperature;
  float humidity;
  uint32_t sampledMs;
  uint32_t sequence;
  int32_t rssi;
};
Sample pending[QUEUE_CAPACITY];
uint16_t queueHead = 0;
uint16_t queueSize = 0;
uint32_t sequenceNumber = 0;
uint32_t lastSampleMs = 0;
uint32_t lastWifiAttemptMs = 0;
uint32_t lastUploadMs = 0;
uint32_t retryDelayMs = 1000;
uint32_t droppedSamples = 0;
char bootId[18];

void removeOldest() {
  queueHead = (queueHead + 1) % QUEUE_CAPACITY;
  queueSize--;
}

void sampleSensor() {
  const float humidity = dht.readHumidity();
  const float temperature = dht.readTemperature();
  if (isnan(temperature) || isnan(humidity) || temperature < -40 || temperature > 80 || humidity < 0 || humidity > 100) {
    Serial.println("DHT22 read failed. Check power, DATA pin, pull-up, and wiring.");
    return; // No made-up/zero readings on failure.
  }
  if (queueSize == QUEUE_CAPACITY) {
    removeOldest();
    droppedSamples++;
    Serial.printf("Offline queue full; oldest sample dropped. Total dropped: %lu\n", (unsigned long)droppedSamples);
  }
  const uint16_t tail = (queueHead + queueSize) % QUEUE_CAPACITY;
  pending[tail] = { temperature, humidity, millis(), sequenceNumber++, WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : -127 };
  queueSize++;
  Serial.printf("Sample: %.1f C | %.1f %% RH | queued: %u\n", temperature, humidity, queueSize);
}

void uploadOldest() {
  Sample& sample = pending[queueHead];
  char body[384];
#ifdef ATMOS_HOSTED_UPLOAD
  if (time(nullptr) < MIN_VALID_CLOCK) {
    Serial.println("Waiting for network time before HTTPS upload.");
    retryDelayMs = 5000;
    return;
  }
  if (!String(SERVER_URL).startsWith("https://")) {
    Serial.println("Hosted uploads require an HTTPS URL.");
    retryDelayMs = 30000;
    return;
  }
  snprintf(body, sizeof(body),
    "{\"readingId\":\"%s-%lu\",\"temperature\":%.2f,\"humidity\":%.2f,\"ageMs\":%lu}",
    bootId, (unsigned long)sample.sequence, sample.temperature, sample.humidity,
    (unsigned long)(millis() - sample.sampledMs));
  WiFiClientSecure client;
  client.setCACert(ATMOS_ROOT_CA);
  client.setHandshakeTimeout(8);
#else
  snprintf(body, sizeof(body),
    "{\"deviceId\":\"%s\",\"readingId\":\"%s-%lu\",\"temperature\":%.2f,\"humidity\":%.2f,\"rssi\":%ld,\"uptimeMs\":%lu,\"ageMs\":%lu}",
    DEVICE_ID, bootId, (unsigned long)sample.sequence, sample.temperature, sample.humidity,
    (long)sample.rssi, (unsigned long)sample.sampledMs, (unsigned long)(millis() - sample.sampledMs));

  WiFiClient client;
#endif
  HTTPClient http;
#ifdef ATMOS_HOSTED_UPLOAD
  http.setConnectTimeout(7000);
  http.setTimeout(7000);
#else
  http.setConnectTimeout(1200);
  http.setTimeout(1200);
#endif
  if (!http.begin(client, SERVER_URL)) {
    Serial.println("Could not open SERVER_URL. Check the address.");
    retryDelayMs = 30000;
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  const int status = http.POST(String(body));
  if (status >= 200 && status < 300) {
    removeOldest();
    retryDelayMs = 1000; // Drain an outage backlog at at most one upload / second.
    Serial.printf("Uploaded (%d). Pending: %u\n", status, queueSize);
  } else if (status == 400 || status == 413 || status == 415) {
    Serial.printf("Server rejected sample (%d): %s\n", status, http.getString().c_str());
    removeOldest(); // A malformed sample must not block subsequent valid samples.
    retryDelayMs = 1000;
  } else {
    if (status == 401 || status == 403) Serial.println("Authorization failed. Check DEVICE_TOKEN / local server configuration.");
    else Serial.printf("Upload failed (%d). Will retry the same reading ID.\n", status);
    retryDelayMs = retryDelayMs < 15000 ? retryDelayMs * 2 : 30000;
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  dht.begin();
  snprintf(bootId, sizeof(bootId), "%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random());
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
#ifdef ATMOS_HOSTED_UPLOAD
  configTime(0, 0, "time.cloudflare.com", "pool.ntp.org");
#endif
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.println("\nATMOS | ESP32 + DHT22 | one reading every 6 seconds");
  Serial.println("Connecting to 2.4 GHz Wi-Fi. Readings buffer while disconnected.");
  delay(2100); // DHT22 needs >2 seconds to settle after power-up.
  lastSampleMs = millis() - SAMPLE_INTERVAL_MS;
  lastWifiAttemptMs = millis();
}

void loop() {
  const uint32_t now = millis();
  static bool reportedConnection = false;
  const bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !reportedConnection) {
    Serial.printf("Wi-Fi connected | IP: %s | gateway: %s | server: %s\n", WiFi.localIP().toString().c_str(), WiFi.gatewayIP().toString().c_str(), SERVER_URL);
  }
  if (!connected && reportedConnection) Serial.println("Wi-Fi disconnected.");
  reportedConnection = connected;
  // Unsigned subtraction keeps scheduling safe across millis() rollover.
  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    sampleSensor();
  }
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiAttemptMs >= 10000) {
      lastWifiAttemptMs = now;
      Serial.println("Reconnecting to Wi-Fi...");
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  } else if (queueSize && now - lastUploadMs >= retryDelayMs) {
    uploadOldest();
    lastUploadMs = millis();
  }
  delay(5);
}
