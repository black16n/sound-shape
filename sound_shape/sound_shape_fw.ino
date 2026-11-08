// 声音的形状 - 固件 v4（分模式：待机不乱认 / 短按切页 / 长按进入）
// 接线：
//   INMP441 : SCK->IO4  WS->IO5  SD->IO6  L/R->GND  VDD->3V3  GND->GND
//   按键     : OUT->IO10  VCC->3V3  GND->GND
//   OLED     : SDA->IO9  SCL->IO8  VCC->3V3  GND->GND  (I2C 0x3C)
// 依赖库：U8g2 (Oliver)  工具 -> 管理库 -> 搜 U8g2 -> 安装
//
// 操作：
//   待机（不乱认）：短按切换页面 [识别] [录入] [声音管理]
//   长按 3 秒 = 进入当前页面
//     识别页：实时听 + 屏上显示认出的名字，再长按 3 秒退出
//     录入页：倒数 3 2 1，录 3 秒，自动挑一个没录过的名字（敲桌子/门铃/捏塑料瓶…）
//     管理页：单点翻声音，长按删除当前声音，翻到「退出」长按回主页
//   任何模式下短按 = 退出回待机

#include <driver/i2s_std.h>
#include <Preferences.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <WiFi.h>
#include <time.h>

// ===== 想显示真实时间就在这里填 WiFi（留空 = 不联网，只显示开机时长）=====
// 注意：不要把真实 WiFi 密码提交到公开仓库。这里留空，本地烧录前自行填入。
#define WIFI_SSID ""
#define WIFI_PASS ""
// =====================================================================
#include <math.h>

#define PIN_SCK 4
#define PIN_WS  5
#define PIN_SD  6
#define PIN_BTN 10
#define PIN_SDA 9
#define PIN_SCL 8
#define PIN_LED_RED     1    // 红灯：听到"敲桌子"
#define PIN_LED_GREEN   7    // 绿灯：听到"门铃"
#define PIN_LED_BLUE   11    // 蓝灯：其它任何认出来的声音
#define LED_ON_DUTY   380    // PWM 占空比 0-1023，约 37%，既不烫也够亮

static const int   NFFT    = 512;
static const float FS      = 16000.0f;
static const int   NBANDS  = 12;
static const int   MAXTPL  = 8;
static const int   NPRESET = 8;
static const float HIT_TH     = 0.780f;  // 命中阈值（越高越保守）
static const float HIT_MARGIN = 0.050f;   // 第一名要比第二名高出这么多才算数
static const int   HOLD_FRAMES = 12;      // 持续声：连续这么多帧都稳，也算命中（约 0.4 秒）

U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE, PIN_SCL, PIN_SDA);

i2s_chan_handle_t rx;
Preferences prefs;

float edges[NBANDS + 1];
float re[NFFT], im[NFFT], win[NFFT];
float ratio[NBANDS];
float rmsBg  = 300.0f;   // 慢背景（只用于参考/打印）
float rmsSlow = 300.0f;  // 房间常态（很慢）
float rmsFast = 300.0f;  // 瞬时（很快），两者一比就是"突发"

float tpl[MAXTPL][NBANDS];
char  tplName[MAXTPL][24];
int   tplCount = 0;

const char* AUTO_NAME[NPRESET] = {
  "敲桌子", "门铃", "捏塑料瓶", "水开", "有人说话", "电话", "脚步声", "自定义"
};

// 状态
enum State { ST_IDLE, ST_LOG, ST_LISTEN, ST_REC_COUNT, ST_REC_TAKE, ST_MANAGE };
State st = ST_IDLE;
int   pageSel = 0;          // 0=识别 1=录入 2=声音管理
int   mgSel   = 0;          // 管理页当前项：0..NPRESET-1=声音，NPRESET=退出
unsigned long stateAt  = 0;
unsigned long lastDraw = 0;
unsigned long lastSpec = 0;

char  liveBest[24] = "";
float liveConf = 0;
char  showLabel[24] = "";
unsigned long showUntil = 0;
unsigned long minUntil  = 0;   // 命中后至少挂到这一刻（保证看得见）
unsigned long lastHitAt = 0;    // 上次真命中，冷却只看它
unsigned long lastWeakAt = 0;   // 上次打印 NEAR，限流用
bool  clockOK = false;      // 有没有拿到真实时间
bool  ntpAsked = false;     // 是否已经发起过对时
unsigned long nextWifiAt = 0;
bool  isLoud = false;       // 这一帧够不够响（屏上才允许显示名字）

float learnAcc[NBANDS];
int   learnN = 0;
char  recName[24] = "";

// 录模板时只留"最响的两帧"的形状：3 秒平均会把一声门铃摊薄到房间里
float recBest1[NBANDS];
float recBest2[NBANDS];
int   recBestRms1 = 0;
int   recBestRms2 = 0;

// 持续声计帧：烧水、风扇、音乐这类不会"突然变响"，
// 靠连续多帧都稳在阈值之上来确认，而不是靠瞬时峰值
int   holdN = 0;

// 录模板的帧缓存：录完只把"接近最响的那几帧"平均，既去掉房间底噪、又不被单帧噪点带偏
#define MAXREC 128
float recBuf[MAXREC][NBANDS];
int   recRms[MAXREC];
int   recCnt = 0;

// 按键
bool btnWasDown = false;
bool btnFired = false;
unsigned long btnDownAt = 0;
int  btnPressedLevel = LOW;

// ---------------- FFT ----------------
void fft(float* pr, float* pi, int n) {
  for (int i = 1, j = 0; i < n; i++) {
    int bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { float t = pr[i]; pr[i] = pr[j]; pr[j] = t; t = pi[i]; pi[i] = pi[j]; pi[j] = t; }
  }
  for (int len = 2; len <= n; len <<= 1) {
    float ang = -2.0f * (float)M_PI / (float)len;
    float wr = cosf(ang), wi = sinf(ang);
    for (int i = 0; i < n; i += len) {
      float cr = 1.0f, ci = 0.0f;
      for (int k = 0; k < len / 2; k++) {
        int a = i + k, b = i + k + len / 2;
        float xr = pr[b] * cr - pi[b] * ci;
        float xi = pr[b] * ci + pi[b] * cr;
        pr[b] = pr[a] - xr;  pi[b] = pi[a] - xi;
        pr[a] = pr[a] + xr;  pi[a] = pi[a] + xi;
        float ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

void buildEdges() {
  float f0 = 60.0f, f1 = 7000.0f;
  for (int i = 0; i <= NBANDS; i++) edges[i] = f0 * powf(f1 / f0, (float)i / (float)NBANDS);
}

void buildWindow() {
  for (int i = 0; i < NFFT; i++)
    win[i] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * (float)i / (float)(NFFT - 1)));
}

// 两个"归一化频谱分布"（各段和为 1）的相似度：1 - L1距离/2，范围 0~1
// 比余弦好在：余弦会给"平的声音"和任何东西都算 0.95，L1 能分清"平"和"有峰"
float simScore(const float* a, const float* b) {
  float d = 0;
  for (int i = 0; i < NBANDS; i++) d += fabsf(a[i] - b[i]);
  float s = 1.0f - d * 0.5f;
  return (s < 0.0f) ? 0.0f : s;
}

float cosineSim(const float* a, const float* b) {
  float dot = 0, na = 0, nb = 0;
  for (int i = 0; i < NBANDS; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na <= 0.000001f || nb <= 0.000001f) return 0;
  return dot / (sqrtf(na) * sqrtf(nb));
}

void saveTpl(int slot) {
  String k = "t" + String(slot);
  prefs.putBytes(k.c_str(), tpl[slot], sizeof(tpl[slot]));
  String n = "n" + String(slot);
  prefs.putString(n.c_str(), String(tplName[slot]));
}

void loadTpl() {
  tplCount = 0;
  for (int i = 0; i < MAXTPL; i++) {
    String k = "t" + String(i);
    if (prefs.getBytesLength(k.c_str()) == sizeof(tpl[i])) {
      prefs.getBytes(k.c_str(), tpl[i], sizeof(tpl[i]));
      String n = "n" + String(i);
      String s = prefs.getString(n.c_str(), AUTO_NAME[i % NPRESET]);
      strncpy(tplName[i], s.c_str(), 23);
      tplName[i][23] = 0;
      tplCount++;
    }
  }
}

// ---------------- 屏幕 ----------------
void iconEar(int cx, int cy) {
  u8g2.drawCircle(cx, cy, 7);
  u8g2.drawCircle(cx, cy, 3);
}

void iconMic(int cx, int cy) {
  u8g2.drawDisc(cx, cy - 2, 4);
  u8g2.drawLine(cx, cy + 2, cx, cy + 6);
  u8g2.drawLine(cx - 5, cy + 6, cx + 5, cy + 6);
}

void iconX(int cx, int cy) {
  u8g2.drawLine(cx - 5, cy - 5, cx + 5, cy + 5);
  u8g2.drawLine(cx + 5, cy - 5, cx - 5, cy + 5);
}

void iconList(int cx, int cy) {
  for (int i = -1; i <= 1; i++) {
    u8g2.drawDisc(cx - 6, cy + i * 4, 1);
    u8g2.drawLine(cx - 2, cy + i * 4, cx + 6, cy + i * 4);
  }
}

void startClock() {
  if (strlen(WIFI_SSID) == 0) { Serial.println("CLOCK off (no wifi cfg)"); return; }
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("CLOCK searching %s\n", WIFI_SSID);
}

// 不阻塞主循环：每隔一会儿看看连上没有，连上了就去对时
void clockPoll(unsigned long now) {
  if (clockOK) return;
  if (strlen(WIFI_SSID) == 0) return;

  if (WiFi.status() == WL_CONNECTED) {
    if (!ntpAsked) {
      configTime(8 * 3600, 0, "ntp.aliyun.com", "ntp.tencent.com", "pool.ntp.org");
      ntpAsked = true;
      nextWifiAt = now + 600;
      Serial.println("CLOCK wifi ok, waiting ntp");
    } else if (now >= nextWifiAt) {
      nextWifiAt = now + 600;
      time_t n = time(nullptr);
      if (n > 1700000000UL) {
        clockOK = true;
        WiFi.mode(WIFI_OFF);          // 对上了就关射频，省电、不干扰麦克风
        Serial.println("CLOCK ok");
      }
    }
  } else if (now >= nextWifiAt) {
    // 热点可能是开机之后才打开的，所以一直重试，不会放弃
    nextWifiAt = now + 15000;
    ntpAsked = false;
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.println("CLOCK retry");
  }
}
void drawUptime() {
  // 板子没有时钟芯片，这里显示的是"本次开机运行了多久"
  char b[12];
  if (clockOK) {
    time_t n = time(nullptr); struct tm ti; localtime_r(&n, &ti);
    snprintf(b, sizeof(b), "%02d:%02d", ti.tm_hour, ti.tm_min);
  } else {
    unsigned long s = millis() / 1000UL;
    if (s < 3600UL) snprintf(b, sizeof(b), "%d:%02d", (int)(s / 60UL), (int)(s % 60UL));
    else snprintf(b, sizeof(b), "%d:%02d", (int)(s / 3600UL), (int)((s % 3600UL) / 60UL));
  }
  u8g2.drawUTF8(128 - u8g2.getUTF8Width(b), 11, b);
}

void drawIdle() {
  u8g2.clearBuffer();
  u8g2.setDrawColor(1);
  u8g2.setFont(u8g2_font_wqy12_t_gb2312);
  u8g2.drawUTF8(0, 11, "声音的形状");
  drawUptime();
  u8g2.drawHLine(0, 14, 128);

  u8g2.drawFrame(1, 20, 30, 34);
  u8g2.drawFrame(33, 20, 30, 34);
  u8g2.drawFrame(65, 20, 30, 34);
  u8g2.drawFrame(97, 20, 30, 34);

  if (pageSel == 0) u8g2.drawBox(1, 20, 30, 34);
  if (pageSel == 1) u8g2.drawBox(33, 20, 30, 34);
  if (pageSel == 2) u8g2.drawBox(65, 20, 30, 34);
  if (pageSel == 3) u8g2.drawBox(97, 20, 30, 34);

  u8g2.setDrawColor(pageSel == 0 ? 0 : 1);
  iconLog(16, 32);
  u8g2.drawUTF8(4, 50, "日志");

  u8g2.setDrawColor(pageSel == 1 ? 0 : 1);
  iconEar(48, 32);
  u8g2.drawUTF8(36, 50, "识别");

  u8g2.setDrawColor(pageSel == 2 ? 0 : 1);
  iconMic(80, 32);
  u8g2.drawUTF8(68, 50, "录入");

  u8g2.setDrawColor(pageSel == 3 ? 0 : 1);
  iconList(112, 32);
  u8g2.drawUTF8(100, 50, "声音");
  u8g2.setDrawColor(1);

  u8g2.setFont(u8g2_font_wqy12_t_gb2312);
  char buf[32];
  snprintf(buf, sizeof(buf), "已学会 %d 种", tplCount);
  u8g2.drawUTF8(0, 63, buf);
  const char* hint = "长按进入";
  u8g2.drawUTF8(128 - u8g2.getUTF8Width(hint), 63, hint);
  u8g2.sendBuffer();
}

void drawListen(float mx) {
  u8g2.clearBuffer();
  u8g2.setDrawColor(1);
  u8g2.setFont(u8g2_font_wqy12_t_gb2312);
  u8g2.drawUTF8(0, 11, "在听…");
  u8g2.setFont(u8g2_font_5x8_tf);
  u8g2.drawStr(86, 11, "hold=exit");
  u8g2.drawHLine(0, 14, 128);

  for (int b = 0; b < NBANDS; b++) {
    int h = (int)(ratio[b] / (mx > 0.0001f ? mx : 0.0001f) * 24.0f);
    if (h < 2) h = 2;
    if (h > 24) h = 24;
    u8g2.drawBox(2 + b * 10, 42 - h, 7, h);
  }

  if (millis() < showUntil && (millis() < minUntil || isLoud)) {
    u8g2.setFont(u8g2_font_wqy16_t_gb2312);
    int w = u8g2.getUTF8Width(showLabel);
    u8g2.drawUTF8((128 - w) / 2, 62, showLabel);
  } else if (liveConf > 0.70f && isLoud) {
    u8g2.setFont(u8g2_font_wqy12_t_gb2312);
    char b[48];
    snprintf(b, sizeof(b), "%s %.0f%%", liveBest, liveConf * 100.0f);
    u8g2.drawUTF8(4, 62, b);
  } else {
    u8g2.setFont(u8g2_font_wqy12_t_gb2312);
    u8g2.drawUTF8(36, 62, "没有声音");
  }
  u8g2.sendBuffer();
}

void drawRecCount(unsigned long e) {
  u8g2.clearBuffer();
  u8g2.setDrawColor(1);
  u8g2.setFont(u8g2_font_wqy12_t_gb2312);
  u8g2.drawUTF8(0, 12, "准备录入：");
  u8g2.drawUTF8(62, 12, recName);
  int cnt = 3 - (int)(e / 1000);
  if (cnt < 1) cnt = 1;
  u8g2.setFont(u8g2_font_helvB24_tf);
  char b[4];
  snprintf(b, sizeof(b), "%d", cnt);
  u8g2.drawStr(54, 56, b);
  u8g2.sendBuffer();
}

void drawRecTake(unsigned long e) {
  u8g2.clearBuffer();
  u8g2.setDrawColor(1);
  u8g2.setFont(u8g2_font_wqy12_t_gb2312);
  u8g2.drawUTF8(24, 14, "正在听…");
  int p = (int)(e * 100 / 3000);
  if (p < 0) p = 0;
  if (p > 100) p = 100;
  u8g2.drawFrame(14, 26, 100, 14);
  if (p > 0) u8g2.drawBox(14, 26, p, 14);
  u8g2.drawUTF8(40, 58, recName);
  u8g2.sendBuffer();
}

void drawMsg(const char* a, const char* b) {
  u8g2.clearBuffer();
  u8g2.setDrawColor(1);
  u8g2.setFont(u8g2_font_wqy12_t_gb2312);
  int w = u8g2.getUTF8Width(a);
  u8g2.drawUTF8((128 - w) / 2, 22, a);
  u8g2.setFont(u8g2_font_wqy16_t_gb2312);
  w = u8g2.getUTF8Width(b);
  u8g2.drawUTF8((128 - w) / 2, 52, b);
  u8g2.sendBuffer();
}

// ---------------- 按键 ----------------
void clearAll() {
  prefs.clear();
  tplCount = 0;
  for (int i = 0; i < MAXTPL; i++) {
    tplName[i][0] = 0;
    for (int b = 0; b < NBANDS; b++) tpl[i][b] = 0;
  }
  Serial.println("CLEARED");
  drawMsg("已清空", "全部忘掉");
  delay(900);
}

// ===== LED：敲桌子→红(IO1)，门铃→绿(IO7)，其它声音→蓝(IO11) =====
int ledPin = -1;

int ledFor(const char* label) {
  if (strcmp(label, "敲桌子") == 0) return PIN_LED_RED;
  if (strcmp(label, "门铃") == 0) return PIN_LED_GREEN;
  return PIN_LED_BLUE;   // 其它认出来的声音都亮蓝灯
}

void lightLed(const char* label) {
  int p = ledFor(label);
  Serial.printf("LED \"%s\" -> %d\n", label, p);
  if (p < 0) return;
  ledcWrite(PIN_LED_RED, 0);
  ledcWrite(PIN_LED_GREEN, 0);
  ledcWrite(PIN_LED_BLUE, 0);
  ledcWrite(p, LED_ON_DUTY);
  ledPin = p;
}

int findTpl(const char* nm) {  for (int i = 0; i < tplCount; i++)
    if (strcmp(tplName[i], nm) == 0) return i;
  return -1;
}

// 删掉第 idx 个模板：后面的往前挪，再把 NVS 整体重写一遍
void deleteTpl(int idx) {
  if (idx < 0 || idx >= tplCount) return;
  char gone[24];
  strncpy(gone, tplName[idx], 23);
  gone[23] = 0;
  for (int i = idx; i < tplCount - 1; i++) {
    for (int b = 0; b < NBANDS; b++) tpl[i][b] = tpl[i + 1][b];
    strncpy(tplName[i], tplName[i + 1], 23);
    tplName[i][23] = 0;
  }
  tplCount--;
  for (int i = 0; i < tplCount; i++) saveTpl(i);
  for (int i = tplCount; i < MAXTPL; i++) {
    String k = "t" + String(i); prefs.remove(k.c_str());
    String n = "n" + String(i); prefs.remove(n.c_str());
  }
  Serial.printf("DELETED idx=%d tpl=%d\n", idx, tplCount);
  Serial.printf("{\"ev\":\"deleted\",\"label\":\"%s\"}\n", gone);
}

// 录新声音时挑一个还没用过的名字
const char* pickName() {
  for (int i = 0; i < NPRESET; i++)
    if (findTpl(AUTO_NAME[i]) < 0) return AUTO_NAME[i];
  return "自定义";
}

// ---------------- 日志：最近听到的声音 ----------------
#define LOG_MAX 24
struct LogItem {
  char name[20];
  unsigned long ms;
};
LogItem gLog[LOG_MAX];
int gLogN = 0;
int gLogHead = 0;
int logScroll = 0;

void iconLog(int cx, int cy) {
  u8g2.drawCircle(cx, cy, 7);
  u8g2.drawLine(cx, cy, cx, cy - 4);
  u8g2.drawLine(cx, cy, cx + 4, cy + 1);
}

void pushLog(const char* nm) {
  if (gLogN == LOG_MAX) { gLogHead = (gLogHead + 1) % LOG_MAX; gLogN--; }
  int idx = (gLogHead + gLogN) % LOG_MAX;
  strncpy(gLog[idx].name, nm, 19);
  gLog[idx].name[19] = 0;
  gLog[idx].ms = millis();
  gLogN++;
  Serial.printf("LOG + %s n=%d\n", nm, gLogN);
}

void fmtAge(unsigned long age, char* out, unsigned int n) {
  if (age < 60000UL) snprintf(out, n, "刚刚");
  else if (age < 3600000UL) snprintf(out, n, "%d分前", (int)(age / 60000UL));
  else snprintf(out, n, "%d时前", (int)(age / 3600000UL));
}

void drawLog() {
  u8g2.clearBuffer();
  u8g2.setDrawColor(1);
  u8g2.setFont(u8g2_font_wqy12_t_gb2312);
  u8g2.drawUTF8(0, 11, "日志");
  char b[16];
  snprintf(b, sizeof(b), "共%d条", gLogN);
  u8g2.drawUTF8(128 - u8g2.getUTF8Width(b), 11, b);
  u8g2.drawHLine(0, 14, 128);

  if (gLogN == 0) {
    u8g2.drawUTF8(28, 40, "还没有记录");
    u8g2.sendBuffer();
    return;
  }
  for (int i = 0; i < 4; i++) {
    int k = gLogN - 1 - logScroll - i;
    if (k < 0) break;
    int idx = (gLogHead + k) % LOG_MAX;
    char age[12];
    if (clockOK) {
      time_t tt = time(nullptr) - (time_t)((millis() - gLog[idx].ms) / 1000UL);
      struct tm ti; localtime_r(&tt, &ti);
      snprintf(age, sizeof(age), "%02d:%02d", ti.tm_hour, ti.tm_min);
    } else {
      fmtAge(millis() - gLog[idx].ms, age, sizeof(age));
    }
    u8g2.drawUTF8(0, 26 + i * 12, age);
    u8g2.drawUTF8(56, 26 + i * 12, gLog[idx].name);
  }
  u8g2.sendBuffer();
}
void drawManage() {
  u8g2.clearBuffer();
  u8g2.setDrawColor(1);
  u8g2.setFont(u8g2_font_wqy12_t_gb2312);
  u8g2.drawUTF8(0, 11, "声音管理");
  char b[16];
  snprintf(b, sizeof(b), "%d/%d", mgSel + 1, NPRESET + 1);
  u8g2.drawUTF8(128 - u8g2.getUTF8Width(b), 11, b);
  u8g2.drawHLine(0, 14, 128);

  u8g2.setFont(u8g2_font_wqy16_t_gb2312);
  const char* nm = (mgSel < NPRESET) ? AUTO_NAME[mgSel] : "退出";
  int w = u8g2.getUTF8Width(nm);
  u8g2.drawUTF8((128 - w) / 2, 34, nm);

  u8g2.setFont(u8g2_font_wqy12_t_gb2312);
  if (mgSel < NPRESET) {
    bool has = (findTpl(AUTO_NAME[mgSel]) >= 0);
    if (has) {
      u8g2.drawUTF8(4, 48, "已录入");
      u8g2.drawUTF8(62, 48, "长按删除");
    } else {
      u8g2.drawUTF8(4, 48, "未录入");
      u8g2.drawUTF8(62, 48, "长按跳过");
    }
    u8g2.drawUTF8(4, 62, "单点 下一个");
  } else {
    u8g2.drawUTF8(4, 48, "长按 返回主页");
    u8g2.drawUTF8(4, 62, "单点 回到第一个");
  }
  u8g2.sendBuffer();
}

void doShort() {
  if (st == ST_IDLE) {
    pageSel = (pageSel + 1) % 4;
    Serial.printf("PAGE %d\n", pageSel);
    drawIdle();
  } else if (st == ST_LOG) {
    if (gLogN > 4) { logScroll = logScroll + 4; if (logScroll > gLogN - 1) logScroll = 0; }
    drawLog();
  } else if (st == ST_MANAGE) {
    mgSel = (mgSel + 1) % (NPRESET + 1);
    Serial.printf("MGSEL %d\n", mgSel);
    drawManage();
  } else {
    st = ST_IDLE;
    Serial.println("EXIT");
    drawIdle();
  }
}

void doLong() {
  if (st == ST_IDLE) {
    if (pageSel == 0) {
      st = ST_LOG;
      logScroll = 0;
      Serial.printf("MODE LOG n=%d\n", gLogN);
      drawLog();
    } else if (pageSel == 1) {
      st = ST_LISTEN;
      stateAt = millis();
      liveConf = 0;
      liveBest[0] = 0;
      showUntil = 0;
      Serial.println("MODE LISTEN");
    } else if (pageSel == 2) {
      st = ST_REC_COUNT;
      stateAt = millis();
      learnN = 0;
      recCnt = 0;
      for (int i = 0; i < NBANDS; i++) { learnAcc[i] = 0; recBest1[i] = 0; recBest2[i] = 0; }
      recBestRms1 = 0;
      recBestRms2 = 0;
      const char* nm = pickName();
      strncpy(recName, nm, 23);
      recName[23] = 0;
      Serial.printf("MODE RECORD %s\n", recName);
      drawRecCount(0);
    } else {
      st = ST_MANAGE;
      mgSel = 0;
      Serial.printf("MODE MANAGE tpl=%d\n", tplCount);
      drawManage();
    }
  } else if (st == ST_LOG) {
    st = ST_IDLE;
    Serial.println("EXIT");
    drawIdle();
  } else if (st == ST_MANAGE) {
    if (mgSel < NPRESET) {
      int t = findTpl(AUTO_NAME[mgSel]);
      if (t >= 0) {
        deleteTpl(t);
        drawMsg("已删除", AUTO_NAME[mgSel]);
        delay(700);
      } else {
        drawMsg("没录过", AUTO_NAME[mgSel]);
        delay(600);
      }
      drawManage();
    } else {
      st = ST_IDLE;
      Serial.println("EXIT");
      drawIdle();
    }
  } else {
    st = ST_IDLE;
    Serial.println("EXIT");
    drawIdle();
  }
}

bool btnDown() { return digitalRead(PIN_BTN) == btnPressedLevel; }

void handleButton(unsigned long now) {
  bool down = btnDown();
  if (down && !btnWasDown) {
    btnWasDown = true;
    btnFired = false;
    btnDownAt = now;
    Serial.println("BTN_DOWN");
  }
  if (down && btnWasDown && !btnFired && (now - btnDownAt >= 3000)) {
    btnFired = true;
    doLong();
  }
  if (!down && btnWasDown) {
    btnWasDown = false;
    if (!btnFired) doShort();
    btnFired = false;
  }
}

void setup() {
  Serial.begin(115200);
#if defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);   // 关键：串口没人读时立刻丢弃，绝不阻塞（曾经因此卡死）
#endif
  delay(400);
  Serial.println("BOOT v28");
  startClock();

  pinMode(PIN_BTN, INPUT_PULLUP);
  ledcAttach(PIN_LED_RED, 5000, 10);
  ledcAttach(PIN_LED_GREEN, 5000, 10);
  ledcAttach(PIN_LED_BLUE, 5000, 10);
  ledcWrite(PIN_LED_RED, 0);
  ledcWrite(PIN_LED_GREEN, 0);
  ledcWrite(PIN_LED_BLUE, 0);
  delay(30);
  int idle = digitalRead(PIN_BTN);
  btnPressedLevel = (idle == LOW) ? HIGH : LOW;
  Serial.printf("BTN idle=%d pressed_level=%d\n", idle, btnPressedLevel);

  Wire.begin(PIN_SDA, PIN_SCL);
  u8g2.begin();
  drawMsg("启动中", "");

  buildEdges();
  buildWindow();
  for (int i = 0; i < NBANDS; i++) { ratio[i] = 0; }

  prefs.begin("sndshape", false);
  loadTpl();
  Serial.printf("HELLO tpl=%d\n", tplCount);
  Serial.printf("{\"ev\":\"hello\",\"tpl\":%d}\n", tplCount);
  for (int i = 0; i < tplCount; i++) {
    Serial.printf("TPL %d %s", i, tplName[i]);
    for (int b = 0; b < NBANDS; b++) Serial.printf(" %.3f", tpl[i][b]);
    Serial.println();
  }
  for (int i = 0; i < tplCount; i++)
    for (int j = i + 1; j < tplCount; j++)
      Serial.printf("SIM %d-%d %.3f\n", i, j, simScore(tpl[i], tpl[j]));

  i2s_chan_config_t cc = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  ESP_ERROR_CHECK(i2s_new_channel(&cc, NULL, &rx));

  i2s_std_config_t sc = {
    .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG((uint32_t)FS),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = (gpio_num_t)PIN_SCK,
      .ws   = (gpio_num_t)PIN_WS,
      .dout = I2S_GPIO_UNUSED,
      .din  = (gpio_num_t)PIN_SD,
      .invert_flags = { false, false, false },
    },
  };
  sc.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;
  ESP_ERROR_CHECK(i2s_channel_init_std_mode(rx, &sc));
  ESP_ERROR_CHECK(i2s_channel_enable(rx));
  Serial.println("MIC READY");

  st = ST_IDLE;
  pageSel = 0;
  drawIdle();
}

void loop() {
  unsigned long now = millis();
  clockPoll(now);

  // LED 和屏幕上那个大字同进退：字在，灯亮；字没了，灯灭
  if (ledPin >= 0) {
    bool labelOn = (st == ST_LISTEN) && (now < showUntil) && (now < minUntil || isLoud);
    if (!labelOn) {
      ledcWrite(ledPin, 0);
      ledPin = -1;
    }
  }
  handleButton(now);

  float mx = 0.0001f;
  int32_t buf[NFFT];
  size_t got = 0;

  if (i2s_channel_read(rx, buf, sizeof(buf), &got, 1000) == ESP_OK) {
    int n = got / 4;
    if (n >= 64) {
      float mean = 0;
      double sum = 0;
      for (int i = 0; i < n; i++) mean += (float)(buf[i] >> 14);
      mean /= (float)n;
      for (int i = 0; i < n; i++) {
        float v = (float)(buf[i] >> 14) - mean;
        re[i] = v * win[i];
        im[i] = 0;
        sum += (double)v * v;
      }
      for (int i = n; i < NFFT; i++) { re[i] = 0; im[i] = 0; }

      float rms = (float)sqrt(sum / (double)n);
      fft(re, im, NFFT);

      float bandE[NBANDS];
      for (int b = 0; b < NBANDS; b++) bandE[b] = 0;
      for (int k = 1; k < NFFT / 2; k++) {
        float f = (float)k * FS / (float)NFFT;
        float m2 = re[k] * re[k] + im[k] * im[k];
        for (int b = 0; b < NBANDS; b++) {
          if (f >= edges[b] && f < edges[b + 1]) { bandE[b] += m2; break; }
        }
      }
      float total = 0;
      for (int b = 0; b < NBANDS; b++) { bandE[b] = sqrtf(bandE[b]); total += bandE[b]; }
      if (total < 0.0001f) total = 0.0001f;
      for (int b = 0; b < NBANDS; b++) {
        ratio[b] = bandE[b] / total;
        if (ratio[b] > mx) mx = ratio[b];
      }

      // 双时间常数：slow=房间常态（音乐/风扇/空调被吸收），fast=瞬时
      // 突发声音（敲门/捏瓶子）会让 fast 立刻冲高，而 slow 基本不动
      rmsFast += (rms - rmsFast) * 0.5f;
      rmsSlow += (rms - rmsSlow) * 0.02f;
      if (rmsSlow < 120.0f) rmsSlow = 120.0f;
      rmsBg = rmsSlow;

      // 安静（相对房间常态，或绝对太轻）时把实时结果清掉，屏上不瞎猜名字
      // 绝对音量闸很关键：安静时噪声频谱也偏低频，会和"敲桌子"模板长得像
      isLoud = (rms > 600.0f && rms > rmsSlow * 1.5f);
      if (!isLoud) {
        liveConf = 0; liveBest[0] = 0;
        // 声音真的停下来了，就把大字也一起撤掉：
        // 原来只靠 showUntil 计时，敲完的余音过去后名字还挂着，回不去"没有声音"
        if (rms < rmsSlow * 1.30f && now > minUntil) showUntil = 0;
      }

      if (st == ST_LISTEN && tplCount > 0) {
        int best = -1, second = -1;
        float bs = 0, b2 = 0;
        for (int t = 0; t < tplCount; t++) {
          float s = simScore(ratio, tpl[t]);
          if (s > bs) { b2 = bs; second = best; bs = s; best = t; }
          else if (s > b2) { b2 = s; second = t; }
        }
        if (best >= 0) {
          strncpy(liveBest, tplName[best], 23);
          liveBest[23] = 0;
          liveConf = bs;

          bool okTh  = (bs > HIT_TH);
          bool okMar = (second < 0) || ((bs - b2) > HIT_MARGIN);
          // 用"瞬时 vs 常态"判断突发，而不是"相对慢背景的倍数"——
          // 有音乐时慢背景会被抬上去，老判据几乎永远不成立
          bool okLoud = (rmsFast > rmsSlow * 1.45f && rms > 350.0f);

          // 持续声通道：烧水是平稳的嘶嘶声，永远"不突然"，
          // 所以换个判据——形状对得上、音量确实高于常态，并且稳够 12 帧
          bool okSteady = (okTh && okMar && rms > 400.0f && rms > rmsSlow * 1.15f);
          if (okSteady) { if (holdN < 32000) holdN++; } else holdN = 0;
          bool steadyHit = (holdN == HOLD_FRAMES);

          if ((okTh && okMar && okLoud) || steadyHit) {
            holdN = 0;
            if (now - lastHitAt > 900) {
              lastHitAt = now;
              strncpy(showLabel, tplName[best], 23);
              showLabel[23] = 0;
              showUntil = now + 1800;
              minUntil  = now + 750;   // 先保证看清 0.75 秒，之后声音一停就回落
              lightLed(tplName[best]);
              pushLog(tplName[best]);
              Serial.printf("{\"ev\":\"hit\",\"label\":\"%s\",\"conf\":%.2f,\"gap\":%.2f}\n",
                            tplName[best], bs, bs - b2);
            }
          } else if (bs > 0.45f && now - lastWeakAt > 500) {
            lastWeakAt = now;
            Serial.printf("NEAR %s %.3f / %s %.3f gap=%.3f th=%d mar=%d loud=%d\n",
                          tplName[best], bs,
                          (second >= 0 ? tplName[second] : "-"), b2,
                          bs - b2, okTh ? 1 : 0, okMar ? 1 : 0, okLoud ? 1 : 0);
          }
        }
      }

      if (st == ST_REC_TAKE && now - stateAt < 3000) {
        learnN++;
        int ri = (int)rms;
        if (recCnt < MAXREC) {                      // 缓存这一帧，录完再挑
          recRms[recCnt] = ri;
          for (int b = 0; b < NBANDS; b++) recBuf[recCnt][b] = ratio[b];
          recCnt++;
        }
        if (ri > recBestRms1) {
          recBestRms2 = recBestRms1;
          for (int b = 0; b < NBANDS; b++) recBest2[b] = recBest1[b];
          recBestRms1 = ri;
          for (int b = 0; b < NBANDS; b++) recBest1[b] = ratio[b];
        } else if (ri > recBestRms2) {
          recBestRms2 = ri;
          for (int b = 0; b < NBANDS; b++) recBest2[b] = ratio[b];
        }
        for (int b = 0; b < NBANDS; b++) learnAcc[b] += ratio[b];
      }

      if (st == ST_LISTEN && now - lastSpec > 200) {
        lastSpec = now;
        Serial.print("SPEC");
        for (int b = 0; b < NBANDS; b++) Serial.printf(" %d", (int)(ratio[b] / mx * 99.0f));
        Serial.printf(" %d  f=%d s=%d\n", (int)(rms > 4000 ? 99 : rms / 40), (int)rmsFast, (int)rmsSlow);
      }
    }
  }

  if (st == ST_REC_COUNT) {
    unsigned long e = now - stateAt;
    if (e >= 3000) {
      st = ST_REC_TAKE;
      stateAt = now;
      Serial.printf("TAKE_START %s\n", recName);
      drawRecTake(0);            // 只在开始时画一次，3 秒内不再刷屏
    } else if (now - lastDraw > 200) {
      lastDraw = now;
      drawRecCount(e);
    }
  } else if (st == ST_REC_TAKE) {
    unsigned long e = now - stateAt;
    if (e >= 3000) {
      int slot = (tplCount < MAXTPL) ? tplCount : 0;
      float n = (float)(learnN ? learnN : 1);
      Serial.printf("TAKE_DONE n=%d\n", learnN);
      drawMsg("正在保存", recName);       // 写 flash 前先告诉用户，别让它看起来像死了
      // 用"最响那几帧"的平均做模板：既不被房间底噪稀释，也不被单帧噪点带偏
      int peak = 0;
      for (int i = 0; i < recCnt; i++) if (recRms[i] > peak) peak = recRms[i];
      float gate = (float)peak * 0.55f;
      int used = 0;
      for (int b = 0; b < NBANDS; b++) tpl[slot][b] = 0;
      // 有没有"突然变响"决定怎么取模板：
      //   有突发（敲门/门铃）→ 只取最响那几帧，别被底噪稀释
      //   没突发（烧水/风扇）→ 取整段平均，否则取到的就是噪声
      bool steadyRec = (peak < (int)(rmsSlow * 1.35f));
      if (steadyRec) {
        for (int b = 0; b < NBANDS; b++) tpl[slot][b] = learnAcc[b] / n;
        used = -1;
      } else {
      for (int i = 0; i < recCnt; i++) {
        if ((float)recRms[i] >= gate) {
          for (int b = 0; b < NBANDS; b++) tpl[slot][b] += recBuf[i][b];
          used++;
        }
      }
      if (used >= 2) {
        for (int b = 0; b < NBANDS; b++) tpl[slot][b] /= (float)used;
      } else if (recBestRms1 > 0) {
        for (int b = 0; b < NBANDS; b++) tpl[slot][b] = recBest1[b];
      } else {
        for (int b = 0; b < NBANDS; b++) tpl[slot][b] = learnAcc[b] / n;
      }
      }
      Serial.printf("RECPEAK p1=%d used=%d frames=%d slow=%d steady=%d\n",
                    peak, used, learnN, (int)rmsSlow, steadyRec ? 1 : 0);
      if (recBestRms1 < (int)(rmsSlow * 1.25f))
        Serial.println("WARN 这 3 秒里没听到明显的动静（p1 没超过常态），按持续声处理");
      Serial.print("TPLNEW");
      for (int b = 0; b < NBANDS; b++) Serial.printf(" %.3f", tpl[slot][b]);
      Serial.println();
      for (int i = 0; i < slot; i++)
        Serial.printf("SIMNEW %d-%d %.3f\n", i, slot, simScore(tpl[i], tpl[slot]));
      strncpy(tplName[slot], recName, 23);
      tplName[slot][23] = 0;
      saveTpl(slot);
      if (tplCount < MAXTPL) tplCount++;
      Serial.print("{\"ev\":\"learned\",\"label\":\"");
      Serial.print(recName);
      Serial.printf("\",\"tpl\":%d,\"bands\":[", tplCount);
      for (int b = 0; b < NBANDS; b++) {
        Serial.printf("%.3f", tpl[slot][b]);
        if (b < NBANDS - 1) Serial.print(",");
      }
      Serial.println("]}");
      drawMsg("学会了", recName);
      delay(1000);
      st = ST_IDLE;
      lastDraw = 0;
      drawIdle();
    } else if (now - lastDraw > 150) {
      lastDraw = now;
      drawRecTake(e);
    }
  } else if (st == ST_LISTEN) {
    if (now - lastDraw > 150) { lastDraw = now; drawListen(mx); }
  } else if (st == ST_LOG) {
    // 日志页也是事件驱动的，靠按键重绘
  } else if (st == ST_MANAGE) {
    // 管理页是事件驱动的（按键才重绘），这里什么都不做，免得把画面刷掉
  } else {
    if (now - lastDraw > 800) { lastDraw = now; drawIdle(); }
  }
}
