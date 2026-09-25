// =============================================================================
//  PowerTrap  —  ESP32-S3 TFT Feather heartbeat sender
// =============================================================================
//  Connects to WiFi and POSTs a "heartbeat" to your VPS every few seconds.
//  If this board loses power (or WiFi, or crashes), the heartbeats stop and
//  the server notices and alerts you.
//
//  Board: Adafruit Feather ESP32-S3 TFT
//    Arduino IDE -> Tools -> Board -> "Adafruit Feather ESP32-S3 TFT"
//    (also works on the ESP32-S2 TFT Feather — pin macros come from the board)
//
//  Libraries (Sketch -> Include Library -> Manage Libraries...):
//    - Adafruit GFX Library
//    - Adafruit ST7735 and ST7789 Library
//    - Adafruit NeoPixel
//    - (optional) Adafruit MAX1704X  — only if ENABLE_BATTERY is set to 1
//
//  Setup:
//    1. Copy secrets.example.h -> secrets.h and fill in your values.
//    2. Select the board + port, then Upload.
// =============================================================================

#include "secrets.h"

// ---- tunables ---------------------------------------------------------------
#define USE_TLS               0          // set to 1 if SERVER_URL is https://
#define HEARTBEAT_INTERVAL_MS 20000UL    // send a heartbeat this often
#define HTTP_TIMEOUT_MS       8000       // per-request timeout
#define REBOOT_AFTER_FAIL_MS  300000UL   // self-reboot after this long w/o a good beat
#define ENABLE_BATTERY        0          // 1 = also report LiPo % (needs MAX1704X lib)

// ---- includes ---------------------------------------------------------------
#include <WiFi.h>
#include <HTTPClient.h>
#if USE_TLS
  #include <WiFiClientSecure.h>
#endif
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <Adafruit_NeoPixel.h>
#if ENABLE_BATTERY
  #include <Adafruit_MAX1704X.h>
#endif

// ---- hardware ---------------------------------------------------------------
// TFT_CS / TFT_DC / TFT_RST / TFT_BACKLITE / TFT_I2C_POWER / PIN_NEOPIXEL are
// all defined by the selected board — we never hardcode pin numbers.
Adafruit_ST7789   tft   = Adafruit_ST7789(TFT_CS, TFT_DC, TFT_RST);
Adafruit_NeoPixel pixel = Adafruit_NeoPixel(1, PIN_NEOPIXEL, NEO_GRB + NEO_KHZ800);
#if ENABLE_BATTERY
  Adafruit_MAX17048 maxlipo;
  bool  batteryOk  = false;
  float batteryPct = 0;
#endif

// ---- colors -----------------------------------------------------------------
#define COL_BG   ST77XX_BLACK
#define COL_OK   ST77XX_GREEN
#define COL_BAD  ST77XX_RED
#define COL_WARN ST77XX_YELLOW
#define COL_TXT  ST77XX_WHITE
#define COL_HEAD ST77XX_CYAN
#define COL_DIM  0x7BEF                   // gray

// ---- state ------------------------------------------------------------------
unsigned long lastAttempt   = 0;
unsigned long lastGoodBeat  = 0;
uint32_t      okCount       = 0;
uint32_t      failCount     = 0;
bool          lastOk        = false;
int           lastCode      = 0;

// -----------------------------------------------------------------------------
void setPixel(uint8_t r, uint8_t g, uint8_t b) {
  pixel.setPixelColor(0, pixel.Color(r, g, b));
  pixel.show();
}

void setupDisplay() {
  // Power up the TFT / STEMMA-QT rail and NeoPixel (macros vary by board).
#ifdef TFT_I2C_POWER
  pinMode(TFT_I2C_POWER, OUTPUT);
  digitalWrite(TFT_I2C_POWER, HIGH);
#endif
#ifdef NEOPIXEL_POWER
  pinMode(NEOPIXEL_POWER, OUTPUT);
  digitalWrite(NEOPIXEL_POWER, HIGH);
#endif
#ifdef TFT_BACKLITE
  pinMode(TFT_BACKLITE, OUTPUT);
  digitalWrite(TFT_BACKLITE, HIGH);
#endif
  delay(10);

  tft.init(135, 240);        // 240x135 ST7789
  tft.setRotation(3);        // landscape, USB on the right
  tft.fillScreen(COL_BG);
  tft.setTextWrap(false);

  pixel.begin();
  pixel.setBrightness(40);
  setPixel(0, 0, 40);        // blue = booting
}

void bootMessage(const char* msg) {
  tft.fillScreen(COL_BG);
  tft.setTextColor(COL_HEAD);
  tft.setTextSize(2);
  tft.setCursor(4, 4);
  tft.print("SIBO");
  tft.setTextColor(COL_TXT);
  tft.setTextSize(1);
  tft.setCursor(4, 40);
  tft.print(msg);
}

void connectWiFi() {
  bootMessage("Connecting WiFi...");
  setPixel(30, 20, 0);       // amber
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(250);
  }

  if (WiFi.status() == WL_CONNECTED) {
    bootMessage("WiFi OK");
    tft.setCursor(4, 56);
    tft.print(WiFi.localIP().toString());
    setPixel(0, 30, 0);
    delay(600);
  } else {
    bootMessage("WiFi FAILED - retrying");
    setPixel(40, 0, 0);
  }
}

// Reconnect if the link dropped. Blocks briefly while trying.
void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  setPixel(30, 20, 0);
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 10000) {
    delay(250);
  }
}

#if ENABLE_BATTERY
void readBattery() {
  if (!batteryOk) return;
  batteryPct = maxlipo.cellPercent();
}
#endif

bool sendHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) { lastCode = 0; return false; }

  HTTPClient http;
#if USE_TLS
  WiFiClientSecure client;
  client.setInsecure();            // skip cert validation (fine for a heartbeat)
#else
  WiFiClient client;
#endif
  http.setConnectTimeout(HTTP_TIMEOUT_MS);
  http.setTimeout(HTTP_TIMEOUT_MS);

  if (!http.begin(client, SERVER_URL)) { lastCode = -1; return false; }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + SHARED_TOKEN);

  String body = String("{\"device\":\"") + DEVICE_ID +
                "\",\"uptime\":" + (millis() / 1000) +
                ",\"rssi\":" + WiFi.RSSI()
#if ENABLE_BATTERY
                + ",\"battery\":" + String(batteryPct, 1)
#endif
                + "}";

  int code = http.POST(body);
  http.end();
  lastCode = code;
  return code >= 200 && code < 300;
}

// Cosmetic charging indicator — always draws a full battery at 100% with a
// charging bolt, regardless of the real battery state. Top-left corner at (x,y).
void drawBattery(int x, int y) {
  const int w = 40, h = 18, nub = 3;

  // white shell (2px) + positive terminal nub
  tft.drawRect(x, y, w, h, COL_TXT);
  tft.drawRect(x + 1, y + 1, w - 2, h - 2, COL_TXT);
  tft.fillRect(x + w, y + h / 2 - 3, nub, 6, COL_TXT);

  // full green fill
  tft.fillRect(x + 3, y + 3, w - 6, h - 6, COL_OK);

  // charging bolt, cut out of the green
  int cx = x + w / 2, cy = y + h / 2;
  tft.fillTriangle(cx + 2, cy - 6, cx - 3, cy + 1, cx + 1, cy + 1, COL_BG);
  tft.fillTriangle(cx - 2, cy + 6, cx + 3, cy - 1, cx - 1, cy - 1, COL_BG);
}

void drawScreen() {
  bool linked = (WiFi.status() == WL_CONNECTED);
  tft.fillScreen(COL_BG);

  // Title + (fake) battery charging indicator, always showing 100%
  tft.setTextSize(2);
  tft.setTextColor(COL_HEAD);
  tft.setCursor(4, 4);
  tft.print("SIBO");
  tft.setTextSize(1);
  tft.setTextColor(COL_OK);
  tft.setCursor(150, 7);
  tft.print("100%");
  drawBattery(190, 2);

  // Big status word
  tft.setTextSize(2);
  tft.setCursor(4, 28);
  if (!linked)      { tft.setTextColor(COL_WARN); tft.print("WIFI..."); }
  else if (lastOk)  { tft.setTextColor(COL_OK);   tft.print("ONLINE"); }
  else              { tft.setTextColor(COL_BAD);  tft.print("SEND FAIL"); }

  // Detail lines
  tft.setTextSize(1);
  int y = 54;
  auto line = [&](const char* label, const String& val, uint16_t c) {
    tft.setCursor(4, y);
    tft.setTextColor(COL_DIM);
    tft.print(label);
    tft.setTextColor(c);
    tft.print(val);
    y += 12;
  };

  line("wifi   ", String(WIFI_SSID), COL_TXT);
  line("rssi   ", linked ? String(WiFi.RSSI()) + " dBm" : String("--"), COL_TXT);
  line("ip     ", linked ? WiFi.localIP().toString() : String("--"), COL_TXT);
  line("beat   ", (lastOk ? String("OK ") : String("FAIL ")) + lastCode, lastOk ? COL_OK : COL_BAD);
  line("lastok ", String((millis() - lastGoodBeat) / 1000) + "s ago", COL_TXT);
  line("count  ", String("ok=") + okCount + " fail=" + failCount, COL_TXT);

  long remain = (long)HEARTBEAT_INTERVAL_MS - (long)(millis() - lastAttempt);
  if (remain < 0) remain = 0;
  line("next   ", String("in ") + (remain / 1000) + "s", COL_DIM);
}

// -----------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  setupDisplay();

#if ENABLE_BATTERY
  batteryOk = maxlipo.begin();
  if (batteryOk) maxlipo.quickStart();
#endif

  connectWiFi();
  lastGoodBeat = millis();   // don't trip the reboot timer before the first beat
  lastAttempt  = 0;          // force an immediate first heartbeat
}

void loop() {
  unsigned long now = millis();
  ensureWiFi();

  if (lastAttempt == 0 || now - lastAttempt >= HEARTBEAT_INTERVAL_MS) {
    lastAttempt = now;
#if ENABLE_BATTERY
    readBattery();
#endif
    setPixel(0, 0, 40);              // blue = sending
    bool ok = sendHeartbeat();
    lastOk = ok;
    if (ok) {
      okCount++;
      lastGoodBeat = millis();
      setPixel(0, 30, 0);            // green = good
      Serial.printf("beat OK  (%d)  rssi=%d\n", lastCode, WiFi.RSSI());
    } else {
      failCount++;
      setPixel(40, 0, 0);           // red = failed
      Serial.printf("beat FAIL (%d)\n", lastCode);
    }
  }

  // Self-heal: if we can't get a heartbeat through for a long time, reboot.
  if (millis() - lastGoodBeat > REBOOT_AFTER_FAIL_MS) {
    Serial.println("No good heartbeat for too long — restarting.");
    delay(50);
    ESP.restart();
  }

  static unsigned long lastDraw = 0;
  if (millis() - lastDraw >= 1000) {
    lastDraw = millis();
    drawScreen();
  }

  delay(20);
}
