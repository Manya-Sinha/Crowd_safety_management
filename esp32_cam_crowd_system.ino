/*
  DYNAMIC SAFETY ZONE MONITORING SYSTEM — ESP32-CAM
  ---------------------------------------------------
  Board: AI-Thinker ESP32-CAM
  Single gate, TWO IR beams in a line:
      Outer beam -> GPIO14 (IPO14)
      Inner beam -> GPIO15 (IPO15)

  DIRECTION LOGIC (order matters, not which pin "is" entry/exit):
      IPO14 breaks first, then IPO15 breaks -> ENTRY  (person moving outer->inner)
      IPO15 breaks first, then IPO14 breaks -> EXIT   (person moving inner->outer)
  A short SEQUENCE_TIMEOUT_MS window is used: if the second beam doesn't
  break within that window, the partial trigger is discarded (someone
  waved a hand and left, or paused mid-gate).

  FLASH + YOLO VERIFICATION FLOW (one flash per crossing, not per beam):
      1. Whichever beam breaks FIRST fires the flash once, grabs a frame,
         and POSTs it to the laptop at /verify_frame.
      2. The laptop runs YOLO on that single frame and replies immediately
         with {"is_human": true/false}. The ESP32 remembers this result.
      3. When the second beam breaks (within the timeout), the ESP32 sends
         /entry or /exit to the laptop ONLY IF is_human was true.
      This means each real crossing costs exactly one flash + one YOLO
      call, not two — saving power and bandwidth.

  BROWNOUT NOTES (read this if you're getting random resets):
  The #1 cause is an underpowered supply, not the code. The camera +
  WiFi radio + flash LED together can spike well past 500mA-1A for a
  few milliseconds. A USB-serial (FTDI) programmer's 5V/3.3V pin CANNOT
  supply that.
    -> Use a dedicated 5V/2A (or better) supply wired directly to the
       5V and GND pins with short, thick wires.
    -> Solder a 470-1000uF electrolytic capacitor across 5V/GND right
       at the ESP32-CAM board (not at the far end of a long wire).
    -> Keep the flash at partial (not full) brightness via PWM (done
       below) and reduce WiFi TX power (done below) - both cut peak
       current draw.
    -> The BROWNOUT_DETECTOR_DISABLE line below is a *software band-aid*
       that stops the chip from resetting on a brief dip. It does NOT
       fix the underlying power problem - if your supply is genuinely
       too weak, the chip will still misbehave (corrupt frames, WiFi
       drops), it just won't visibly reboot. Fix the power hardware
       first; treat this as a safety net, not the solution.
*/

#include "esp_camera.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"

// ====== ESP32-CAM's OWN WiFi NETWORK (EDIT THESE IF YOU WANT) ======
const char* ap_ssid     = "CrowdSystem_ESP32";
const char* ap_password = "crowd1234";

// ====== LAPTOP ADDRESS ON THIS NETWORK ======
const char* serverIP = "192.168.4.2";
const int   serverPort = 5000;

String verifyURL = "http://" + String(serverIP) + ":" + String(serverPort) + "/verify_frame";
String entryURL  = "http://" + String(serverIP) + ":" + String(serverPort) + "/entry";
String exitURL   = "http://" + String(serverIP) + ":" + String(serverPort) + "/exit";
String periodicURL = "http://" + String(serverIP) + ":" + String(serverPort) + "/periodic_frame";

// ====== IR SENSOR PINS (single gate, two beams in a line) ======
#define OUTER_SENSOR_PIN 14   // IPO14 - outer beam
#define INNER_SENSOR_PIN 15   // IPO15 - inner beam

// ====== FLASH LED (GPIO4 on AI-Thinker) ======
#define FLASH_GPIO_NUM 4
#define FLASH_LEDC_CHANNEL 7      // channel 0 is used by the camera XCLK, keep flash separate
#define FLASH_DUTY_PERCENT 55     // partial brightness -> lower current spike than full 100%
#define FLASH_ON_MS 60            // brief pulse - long enough for the sensor exposure, short for power

// ====== AI-THINKER ESP32-CAM PIN MAP (do not change) ======
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// ---- Debounce state ----
bool lastOuterReading = HIGH;
bool lastInnerReading = HIGH;
bool outerState = HIGH;
bool innerState = HIGH;
unsigned long lastOuterDebounceTime = 0;
unsigned long lastInnerDebounceTime = 0;
const unsigned long debounceDelay = 60; // ms

// ---- Sequence (direction) state machine ----
enum GateState { IDLE, WAITING_INNER, WAITING_OUTER };
GateState gateState = IDLE;
unsigned long sequenceStartTime = 0;
const unsigned long SEQUENCE_TIMEOUT_MS = 3500; // max gap between the two beams for one crossing
bool pendingIsHuman = false;

// ---- Cooldown so the same person's body finishing the crossing can't double-fire ----
unsigned long lastCompletedEventTime = 0;
const unsigned long EVENT_COOLDOWN_MS = 400;

unsigned long lastPeriodicCapture = 0;
const unsigned long periodicInterval = 4000; // live density frame for the dashboard/heatmap

void initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size   = FRAMESIZE_VGA;
    config.jpeg_quality = 12;
    config.fb_count      = 1;   // 1 is more power-stable than 2; we don't need frame overlap here
  } else {
    config.frame_size   = FRAMESIZE_QVGA;
    config.jpeg_quality = 15;
    config.fb_count      = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
  }
}

void initFlash() {
  ledcSetup(FLASH_LEDC_CHANNEL, 5000, 8); // 5kHz, 8-bit duty (0-255)
  ledcAttachPin(FLASH_GPIO_NUM, FLASH_LEDC_CHANNEL);
  ledcWrite(FLASH_LEDC_CHANNEL, 0); // start off
}

void fireFlash() {
  int duty = (FLASH_DUTY_PERCENT * 255) / 100;
  ledcWrite(FLASH_LEDC_CHANNEL, duty);
  delay(FLASH_ON_MS);
  ledcWrite(FLASH_LEDC_CHANNEL, 0);
}

// Captures one frame, flashes once, uploads for YOLO verification.
// Returns true if the server confirmed a human in that frame.
bool captureFlashAndVerify() {
  if (WiFi.softAPgetStationNum() == 0) {
    Serial.println("No device connected to the AP yet - skipping capture.");
    Serial.println("----------------------------------");
    return false;
  }

  fireFlash();
  camera_fb_t * fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("Camera capture failed");
    return false;
  }

  bool isHuman = false;
  HTTPClient http;
  http.begin(verifyURL);
  http.addHeader("Content-Type", "image/jpeg");
  http.setTimeout(4000);
  int code = http.POST(fb->buf, fb->len);
  if (code == 200) {
    String payload = http.getString();
    // tiny manual parse - avoids pulling in a JSON library for one boolean
    isHuman = payload.indexOf("\"is_human\": true") != -1 ||
              payload.indexOf("\"is_human\":true") != -1;
  }
  Serial.printf("Verify frame -> HTTP %d, is_human=%s\n", code, isHuman ? "true" : "false");
  http.end();
  esp_camera_fb_return(fb);
  return isHuman;
}

void sendDirectionEvent(const String &url, const char* label) {
  if (WiFi.softAPgetStationNum() == 0) return;
  HTTPClient http;
  http.begin(url);
  http.setTimeout(3000);
  int code = http.GET();
  Serial.printf("%s -> HTTP %d\n", label, code);
  http.end();
}

void sendPeriodicFrame() {
  if (WiFi.softAPgetStationNum() == 0) return;
  camera_fb_t * fb = esp_camera_fb_get();
  if (!fb) return;
  HTTPClient http;
  http.begin(periodicURL);
  http.addHeader("Content-Type", "image/jpeg");
  http.setTimeout(5000);
  http.POST(fb->buf, fb->len);
  http.end();
  esp_camera_fb_return(fb);
}

void setup() {
  Serial.begin(115200);

  // Software brownout-detector mask - see the big comment at the top of
  // this file. This is a safety net, NOT a substitute for a proper 5V/2A
  // supply + capacitor.
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  pinMode(OUTER_SENSOR_PIN, INPUT_PULLUP);
  pinMode(INNER_SENSOR_PIN, INPUT_PULLUP);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(ap_ssid, ap_password);
  WiFi.setTxPower(WIFI_POWER_11dBm); // lower TX power -> lower current spikes (laptop is always close by)

  Serial.println("Access Point started.");
  Serial.print("SSID: "); Serial.println(ap_ssid);
  Serial.print("ESP32-CAM IP: "); Serial.println(WiFi.softAPIP());

  initCamera();
  initFlash();
}

void loop() {
  bool outerReading = digitalRead(OUTER_SENSOR_PIN);
  bool innerReading = digitalRead(INNER_SENSOR_PIN);
  unsigned long now = millis();

  // ---- Debounce outer beam ----
  if (outerReading != lastOuterReading) lastOuterDebounceTime = now;
  bool outerJustBroke = false;
  if ((now - lastOuterDebounceTime) > debounceDelay) {
    if (outerReading != outerState) {
      outerState = outerReading;
      if (outerState == LOW) outerJustBroke = true; // beam broken
    }
  }
  lastOuterReading = outerReading;

  // ---- Debounce inner beam ----
  if (innerReading != lastInnerReading) lastInnerDebounceTime = now;
  bool innerJustBroke = false;
  if ((now - lastInnerDebounceTime) > debounceDelay) {
    if (innerReading != innerState) {
      innerState = innerReading;
      if (innerState == LOW) innerJustBroke = true;
    }
  }
  lastInnerReading = innerReading;

  // ---- Sequence / direction state machine ----
  if (gateState != IDLE && (now - sequenceStartTime) > SEQUENCE_TIMEOUT_MS) {
    Serial.println("Sequence timed out - discarding partial crossing.");
    gateState = IDLE;
  }

  if (gateState == IDLE) {
    if (outerJustBroke && (now - lastCompletedEventTime) > EVENT_COOLDOWN_MS) {
      Serial.println("Outer beam broke first - awaiting inner beam...");
      pendingIsHuman = captureFlashAndVerify(); // one flash, one YOLO check
      gateState = WAITING_INNER;
      sequenceStartTime = now;
    } else if (innerJustBroke && (now - lastCompletedEventTime) > EVENT_COOLDOWN_MS) {
      Serial.println("Inner beam broke first - awaiting outer beam...");
      pendingIsHuman = captureFlashAndVerify();
      gateState = WAITING_OUTER;
      sequenceStartTime = now;
    }
  } else if (gateState == WAITING_INNER) {
    if (innerJustBroke) {
      if (pendingIsHuman) {
        Serial.println("ENTRY confirmed (outer -> inner, human)");
        sendDirectionEvent(entryURL, "Entry");
      } else {
        Serial.println("Outer->inner crossing ignored (not human)");
      }
      gateState = IDLE;
      lastCompletedEventTime = now;
    }
  } else if (gateState == WAITING_OUTER) {
    if (outerJustBroke) {
      if (pendingIsHuman) {
        Serial.println("EXIT confirmed (inner -> outer, human)");
        sendDirectionEvent(exitURL, "Exit");
      } else {
        Serial.println("Inner->outer crossing ignored (not human)");
      }
      gateState = IDLE;
      lastCompletedEventTime = now;
    }
  }

  // Periodic frame for the live density/heatmap view (no flash - just ambient light)
  if (now - lastPeriodicCapture > periodicInterval) {
    sendPeriodicFrame();
    lastPeriodicCapture = now;
  }
}
