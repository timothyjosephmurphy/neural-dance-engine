// Copyright (c) 2026 TJ Murphy / Vermillion Aurora Productions
// SPDX-License-Identifier: MIT

// Neural Dance mural runtime.
// Closed loop: band onsets + a sticker map → this pulse network → a projector.
// Kick / bass / snare-mid / hi-hat-treble are dancer types 0..3.
// The page supplies the mic spectrum (or calls nd_hit from another detector)
// and sticker positions. Preferred install is an iPhone driving a projector:
// room mic in, UV-camera sticker map in, projection out. The traced points
// stand in for that UV map. A phone camera is not the sticker sensor.
// Drawing and projector corner-pin stay outside this module.

constexpr int MAX_DANCERS = 48;
constexpr int MAX_PULSES = 48;
constexpr int MAX_TRAIL = 10;
constexpr int MAX_BINS = 2048;
constexpr int HIST = 15;
constexpr int WARMUP = 6;
// Link radius in stage units. The page widens it to the layout's spacing so
// spread dancers (nearest neighbour 88-115) still pass pulses (TJ 7:41 PM).
constexpr float LINK_R_DEFAULT = 82.f;
static float LINK_R = LINK_R_DEFAULT;
constexpr float RATES[4] = {1.f, 0.5f, 1.5f, 2.f};
constexpr int PULSE_STRIDE = 28;

struct Dancer {
  int id;
  float x, y;
  int k;
  float phase;
  float a;
  float recv; // energy received from neighbours — not own band arm()
  float rest;
  float peak;  // seconds spent hot (at peak) in the current peak period
  float ref;
  float charge;   // slow build-up from repeated own-band hits (lets a dancer reach peak)
  float last_hit; // sim_time of the last own-band hit
  int hot;        // 1 while the dancer is in its peak period
};

struct Pulse {
  int a;
  int b;
  int k;
  float age;
  float duration;
  int trail_len;
  float trail_x[MAX_TRAIL];
  float trail_y[MAX_TRAIL];
  // Free particle in stage space. Once released it keeps its own position
  // and velocity; gravity homes it toward the target's current aim (head
  // if the page wrote one, otherwise the hip). The published view is
  // still 28 floats: fields here only change the head and the trail.
  float px, py, vx, vy, cruise;
  int wandered;
  unsigned char hit[MAX_DANCERS];
  int gen;
  // 1 once the pulse has contacted its target (or another dancer). The
  // head stays on that dancer while the trail tail catches up and collapses.
  int arrived;
  // Seconds since the pulse outlived its first travel estimate (missed or
  // retargeted). Drives the capture ramp so it homes in instead of orbiting.
  float overtime;
  // 1 only if the 20 s leak guard fired (or no dancers are left): the trail
  // shrinks in place instead of popping.
  int fading;
};

struct Band {
  float lo, hi;
  float ratio;
  float min_flux;
  float refractory_ms;
  float hist[HIST];
  int hist_n;
  int hist_i;
  double last_ms;
  int samples;
  float level;
};

static const float BAND_LO[4] = {40.f, 120.f, 300.f, 5000.f};
static const float BAND_HI[4] = {120.f, 300.f, 2500.f, 14000.f};
static const float BAND_RATIO[4] = {1.8f, 1.75f, 1.6f, 1.5f};
static const float BAND_MIN[4] = {10.f, 9.f, 8.f, 8.f};
static const float BAND_REF[4] = {150.f, 160.f, 110.f, 90.f};

static Dancer dancers[MAX_DANCERS];
static Pulse pulses[MAX_PULSES];
static int count = 0;
static int pulse_count = 0;
static int next_id = 1;
static float bpm = 120.f;
static float sim_time = 0.f;
static int low_power = 0;
static int was_listening = 0;
static int pending_hits = 0;
// Beat entrainment (TJ Nov 11 2:29 PM): a real attack that lands on a
// predicted beat boosts its band's dancers more than an off-grid one.
static int pending_onbeat = 0;
static const float ON_BEAT_GAIN = 1.5f;
static int clock_on = 1;
static float sticker_in[MAX_DANCERS * 4];
// Prototype defaults are applied by the page. Zero gravity and wander keep
// the straight pulse path this runtime shipped with, so existing callers
// stay put until a slider moves.
static float gravity_pull = 0.f;
static float wander_rate = 0.f;
static float fire_threshold = 1.4f;
// Peak period length before the forced rest (TJ Nov 11: 2.8 s -> 5 s).
constexpr float PEAK_HOLD_DEFAULT = 5.f;
static float peak_hold = PEAK_HOLD_DEFAULT;
// Pulse network (TJ Nov 11 2:27 PM): a dancer only sends pulses (visible
// pulses AND energy to neighbours) while it is at peak activation. Band hits
// below peak raise its own activation but emit nothing.
constexpr float PEAK_LEVEL = 1.75f;
// Once hot, a dancer stays at peak for peak_hold seconds while its band keeps
// hitting; HOT_IDLE without an own-band hit (song stopped, band dropped out)
// ends the peak period early so nothing stays lit after the music.
constexpr float HOT_IDLE = 1.2f;
// Emit rate at peak (TJ Nov 11 2:43 PM): about one pulse per dancer every
// 2 beats of the locked tempo (120 BPM -> 1.0 s), clamped 0.6-1.6 s, and
// 1.0 s when no tempo is locked. The emission waits for a band hit, and a hit
// up to EMIT_EARLY before the interval expires counts, so pulses stay on the
// beat instead of drifting a frame late.
constexpr float EMIT_BEATS = 2.f;
constexpr float EMIT_MIN = 0.6f;
constexpr float EMIT_MAX = 1.6f;
constexpr float EMIT_UNLOCKED = 1.f;
constexpr float EMIT_EARLY = 0.12f;
static float emit_bpm = 0.f;   // locked listen tempo from the page; 0 = unlocked
static float emit_tempo = 0.f; // tempo used this frame
static float emit_interval() {
  if (!(emit_tempo > 0.f)) return EMIT_UNLOCKED;
  float iv = EMIT_BEATS * 60.f / emit_tempo;
  if (iv < EMIT_MIN) iv = EMIT_MIN;
  if (iv > EMIT_MAX) iv = EMIT_MAX;
  return iv;
}
// Forced rest after the peak period. The dancer keeps dancing to its own band
// hits, capped at REST_CAP so motion stays visibly lower, and sends nothing.
constexpr float REST_TIME = 1.6f;
constexpr float REST_CAP = 0.7f;
// Charge: each own-band hit adds CHARGE_HIT*sens, decaying CHARGE_DECAY/s.
// It lifts the hit floor so a steadily hitting band climbs to peak.
constexpr float CHARGE_HIT = 0.16f;
constexpr float CHARGE_DECAY = 0.45f;
constexpr float CHARGE_MAX = 1.0f;
static int emit_total = 0;
static int spawn_total = 0;
static int landed_total = 0; // pulses that made contact
static int faded_total = 0;  // pulses ended by the leak guard
static int missed_total = 0; // pulses that outlived their first travel window
static float band_sens[4] = {1.f, 1.f, 1.f, 1.f};
static unsigned rng_state = 0xC0FFEEu;

static int queue[MAX_DANCERS];
static int qn = 0;
static int q_cursor = 0;
static unsigned char emitted[MAX_DANCERS];
// Fire generation this frame: 0 = the dancer's own band hit, 1 = fired by
// energy from a gen-0 neighbour, ... Only fires below MAX_GEN pass energy on,
// so a hit ripples two hops out and then dies: no self-sustaining cascade
// once the music stops (the wider link radius made one possible).
constexpr int MAX_GEN = 2;
static int fire_gen[MAX_DANCERS];
static float received[MAX_DANCERS];
static int tone_mask = 0;

static unsigned char spectrum[MAX_BINS];
static unsigned char prev_spec[MAX_BINS];
static int prev_bins = 0;
static Band bands[4];
static int bands_ready = 0;

static float dancer_view[MAX_DANCERS * 6];
static float received_view[MAX_DANCERS];
static float pulse_view[MAX_PULSES * PULSE_STRIDE];
static float levels[4];
// Aim points (current heads) written by the page each frame. Fallback: hips.
static float head_in[MAX_DANCERS * 2];
static float aim_x[MAX_DANCERS];
static float aim_y[MAX_DANCERS];
static int heads_ready = 0;

extern "C" void* memcpy(void* dst, const void* src, unsigned long n) {
  unsigned char* d = (unsigned char*)dst;
  const unsigned char* s = (const unsigned char*)src;
  for (unsigned long i = 0; i < n; i++) d[i] = s[i];
  return dst;
}

extern "C" void* memset(void* dst, int c, unsigned long n) {
  unsigned char* d = (unsigned char*)dst;
  for (unsigned long i = 0; i < n; i++) d[i] = (unsigned char)c;
  return dst;
}

static float clampf(float v, float lo, float hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

static float nd_sin(float x) {
  const float pi = 3.14159265358979323846f;
  const float tau = 6.28318530717958647692f;
  float turns = x / tau;
  float n = (float)(int)(turns >= 0.f ? turns + 0.5f : turns - 0.5f);
  float y = x - n * tau;
  if (y > pi) y -= tau;
  if (y < -pi) y += tau;
  float y2 = y * y;
  return y * (1.f + y2 * (-0.1666666716f + y2 * (0.008333333768f + y2 * (-0.0001984127011f + y2 * 0.000002755731429f))));
}

static void path_point(float ax, float ay, float bx, float by, float t, float* ox, float* oy) {
  float dx = bx - ax;
  float dy = by - ay;
  float amp = dx < 0.f ? -dx : dx;
  amp *= 0.15f;
  if (amp > 18.f) amp = 18.f;
  *ox = ax + dx * t;
  *oy = ay + dy * t - nd_sin(3.14159265358979323846f * t) * amp;
}

static void setup_bands() {
  if (bands_ready) return;
  bands_ready = 1;
  for (int i = 0; i < 4; i++) {
    bands[i].lo = BAND_LO[i];
    bands[i].hi = BAND_HI[i];
    bands[i].ratio = BAND_RATIO[i];
    bands[i].min_flux = BAND_MIN[i];
    bands[i].refractory_ms = BAND_REF[i];
    bands[i].hist_n = 0;
    bands[i].hist_i = 0;
    bands[i].last_ms = -1.0e300;
    bands[i].samples = 0;
    bands[i].level = 0.f;
    for (int h = 0; h < HIST; h++) bands[i].hist[h] = 0.f;
  }
}

static void reset_onsets() {
  setup_bands();
  prev_bins = 0;
  for (int i = 0; i < 4; i++) {
    bands[i].hist_n = 0;
    bands[i].hist_i = 0;
    bands[i].last_ms = -1.0e300;
    bands[i].samples = 0;
    bands[i].level = 0.f;
    for (int h = 0; h < HIST; h++) bands[i].hist[h] = 0.f;
  }
}

static int iceil(float x) {
  int i = (int)x;
  if (x > 0.f && (float)i < x) i++;
  return i;
}

// Half-open [lo, hi) in FFT bins. Returns 0 when the band is above Nyquist.
static int band_range(int band, float sample_rate, int fft_size, int bin_count, int* i0, int* i1) {
  if (band < 0 || band > 3 || !(sample_rate > 0.f) || fft_size <= 0 || bin_count < 2) return 0;
  float hz = sample_rate / (float)fft_size;
  int a = iceil(bands[band].lo / hz - 1.0e-4f);
  int b = iceil(bands[band].hi / hz - 1.0e-4f) - 1;
  if (a < 1) a = 1;
  if (b > bin_count - 1) b = bin_count - 1;
  if (b < a) return 0;
  *i0 = a;
  *i1 = b;
  return 1;
}

static float median_of(float* tmp, int n) {
  for (int i = 1; i < n; i++) {
    float v = tmp[i];
    int j = i - 1;
    while (j >= 0 && tmp[j] > v) {
      tmp[j + 1] = tmp[j];
      j--;
    }
    tmp[j + 1] = v;
  }
  int mid = n >> 1;
  if (n & 1) return tmp[mid];
  return (tmp[mid - 1] + tmp[mid]) * 0.5f;
}

// Peak rise inside each band, against a short median. A held tone or a flat
// noise floor has ~0 flux, so dancers fire on attacks rather than loudness.
static int detect_onsets(int bin_count, float sample_rate, int fft_size, double now_ms, int* hits) {
  if (bin_count > MAX_BINS) bin_count = MAX_BINS;
  if (bin_count < 2) return 0;
  if (prev_bins != bin_count) {
    for (int i = 0; i < bin_count; i++) prev_spec[i] = spectrum[i];
    prev_bins = bin_count;
    return 0;
  }
  int n_hits = 0;
  for (int b = 0; b < 4; b++) {
    int i0 = 0, i1 = 0;
    float peak = 0.f;
    float loud = 0.f;
    if (band_range(b, sample_rate, fft_size, bin_count, &i0, &i1)) {
      for (int i = i0; i <= i1; i++) {
        int v = spectrum[i];
        int d = v - (int)prev_spec[i];
        if ((float)d > peak) peak = (float)d;
        if ((float)v > loud) loud = (float)v;
      }
      for (int i = i0; i <= i1; i++) prev_spec[i] = spectrum[i];
    }
    bands[b].level = loud > 56.f ? 1.f : loud / 56.f;
    float med = 0.f;
    if (bands[b].hist_n > 0) {
      float tmp[HIST];
      for (int i = 0; i < bands[b].hist_n; i++) tmp[i] = bands[b].hist[i];
      med = median_of(tmp, bands[b].hist_n);
    }
    bands[b].samples++;
    float sens = band_sens[b];
    float threshold = bands[b].min_flux + med * bands[b].ratio;
    if (sens > 0.f) threshold /= sens;
    else threshold = 1.0e30f;
    if (bands[b].samples > WARMUP && peak > threshold &&
        (now_ms - bands[b].last_ms) >= (double)bands[b].refractory_ms) {
      bands[b].last_ms = now_ms;
      hits[n_hits++] = b;
    }
    bands[b].hist[bands[b].hist_i] = peak;
    bands[b].hist_i++;
    if (bands[b].hist_i >= HIST) bands[b].hist_i = 0;
    if (bands[b].hist_n < HIST) bands[b].hist_n++;
  }
  return n_hits;
}

static void copy_pulse(Pulse* d, const Pulse* s) {
  memcpy(d, s, sizeof(Pulse));
}

static float rnd() {
  rng_state = rng_state * 1664525u + 1013904223u;
  return (float)(rng_state >> 8) * (1.f / 16777216.f);
}

static float nd_exp(float x) {
  if (x > 4.f) x = 4.f;
  if (x < -8.f) return 0.f;
  float term = 1.f;
  float sum = 1.f;
  for (int i = 1; i <= 12; i++) {
    term *= x / (float)i;
    sum += term;
  }
  return sum;
}

static void remove_pulse_at(int index) {
  for (int j = index; j < pulse_count - 1; j++) copy_pulse(&pulses[j], &pulses[j + 1]);
  pulse_count--;
}

static int pulse_cap() { return low_power ? 24 : MAX_PULSES; }

// Pulses never vanish mid-flight (TJ Nov 11): a pulse whose target is gone,
// resting, or missed retargets to the nearest eligible dancer and homes in
// with a capture ramp. The source may disappear (a = -1) without affecting it.
static int pulse_alive(const Pulse* p) {
  return p->b >= 0 && p->b < count;
}
// Leak guard only: a pulse still flying after this long fades out.
constexpr float PULSE_HARD_LIFE = 20.f;
static int settling = 0; // nd_settle: pulses land visually, no energy
// Last band hit anywhere. A pulse that lands after the music has stopped
// still gives energy but cannot set off a relay, so nothing cascades on.
static float last_any_hit = -99.f;
constexpr float QUIET_AFTER = 1.f; // no band hit this long = music stopped

static void sync_aims_from_hips() {
  for (int i = 0; i < count; i++) {
    aim_x[i] = dancers[i].x;
    aim_y[i] = dancers[i].y;
  }
  heads_ready = 0;
}

static void aim_of(int i, float* ox, float* oy) {
  if (i < 0 || i >= count) {
    *ox = 0.f;
    *oy = 0.f;
    return;
  }
  *ox = aim_x[i];
  *oy = aim_y[i];
}

static void head_pos(const Pulse* p, float* ox, float* oy) {
  if (!p) {
    *ox = 0.f;
    *oy = 0.f;
    return;
  }
  *ox = p->px;
  *oy = p->py;
}

static void publish() {
  for (int i = 0; i < count; i++) {
    float* o = dancer_view + i * 6;
    o[0] = dancers[i].x;
    o[1] = dancers[i].y;
    o[2] = dancers[i].a;
    o[3] = dancers[i].rest;
    o[4] = (float)dancers[i].k;
    o[5] = (float)dancers[i].id;
    float heard = 0.f;
    for (int j = 0; j < count; j++) {
      if (j == i) continue;
      float dx = dancers[i].x - dancers[j].x;
      float dy = dancers[i].y - dancers[j].y;
      float dist = __builtin_sqrtf(dx * dx + dy * dy);
      if (dist >= LINK_R) continue;
      heard += dancers[j].a * (0.2f + 0.25f * (1.f - dist / LINK_R));
    }
    if (heard > 2.f) heard = 2.f;
    received_view[i] = dancers[i].recv > heard ? dancers[i].recv : heard;
  }
  for (int i = 0; i < pulse_count; i++) {
    Pulse* p = &pulses[i];
    float hx = 0.f, hy = 0.f;
    head_pos(p, &hx, &hy);
    float* o = pulse_view + i * PULSE_STRIDE;
    o[0] = (float)p->a;
    o[1] = (float)p->b;
    o[2] = (float)p->k;
    o[3] = p->age;
    o[4] = p->duration;
    o[5] = hx;
    o[6] = hy;
    o[7] = (float)p->trail_len;
    for (int t_i = 0; t_i < MAX_TRAIL; t_i++) {
      o[8 + t_i * 2] = p->trail_x[t_i];
      o[9 + t_i * 2] = p->trail_y[t_i];
    }
  }
  for (int i = 0; i < 4; i++) levels[i] = bands_ready ? bands[i].level : 0.f;
}

static void enqueue_gen(int index, int g) {
  if (emitted[index]) return;
  emitted[index] = 1;
  fire_gen[index] = g;
  if (qn < MAX_DANCERS) queue[qn++] = index;
}

static void enqueue(int index) { enqueue_gen(index, 0); }

static int can_emit(const Dancer* d) {
  return d->rest <= 0.f && d->a >= PEAK_LEVEL && d->a >= fire_threshold && sim_time >= d->ref - EMIT_EARLY;
}

// Enter the peak period the moment activation crosses PEAK_LEVEL.
// Returns 1 on the crossing (the caller emits once for it).
static int enter_peak(Dancer* d) {
  if (d->hot || d->rest > 0.f || d->a < PEAK_LEVEL) return 0;
  // last_hit is left alone: a dancer pushed to peak by neighbours while its
  // own band is silent leaves the peak again on the next frame (HOT_IDLE).
  d->hot = 1;
  return 1;
}

static void arm(int index, float sens, int onbeat = 0) {
  Dancer* d = &dancers[index];
  if (!(sens > 0.f)) return;
  const float gain = onbeat ? ON_BEAT_GAIN : 1.f;
  d->last_hit = sim_time;
  last_any_hit = sim_time;
  // The band tone/ring reports every hit the dancer dances to, at peak or not.
  if (d->k >= 0 && d->k <= 3) tone_mask |= 1 << d->k;
  float boost = 0.25f * sens * gain;
  float next = d->a + boost;
  if (d->rest > 0.f) {
    // Cooldown: keep dancing to the band at a low level, send nothing.
    float floor_r = 0.95f * sens;
    if (next < floor_r) next = floor_r;
    if (next > REST_CAP) next = REST_CAP;
    if (next > d->a) d->a = next;
    return;
  }
  float charge = d->charge + CHARGE_HIT * sens * gain;
  d->charge = charge > CHARGE_MAX ? CHARGE_MAX : charge;
  float floor_v = 0.95f * sens + d->charge;
  if (next < floor_v) next = floor_v;
  float cap = sens > 1.f ? 2.f * sens : 2.f;
  if (cap > 8.f) cap = 8.f;
  if (next > cap) next = cap;
  d->a = next;
  enter_peak(d);
  // Emit only at peak: on the crossing hit and on every band hit while hot.
  if (d->hot && can_emit(d)) {
    d->ref = sim_time + emit_interval();
    enqueue(index);
  }
}

static void spawn_pulse(int ai, int bi, float dist) {
  if (pulse_count >= pulse_cap()) return;
  spawn_total++;
  Pulse* p = &pulses[pulse_count++];
  p->a = ai;
  p->b = bi;
  p->k = dancers[ai].k;
  p->age = 0.f;
  float ax, ay, bx, by;
  aim_of(ai, &ax, &ay);
  aim_of(bi, &bx, &by);
  float dx = bx - ax, dy = by - ay;
  float L = __builtin_sqrtf(dx * dx + dy * dy);
  if (!(L > 0.f)) L = dist > 1.f ? dist : 1.f;
  if (!(dist > 0.f)) dist = L;
  // Expected travel matches the old 0.3 + dist/170 clock; duration is a
  // max-lifetime safety (about 2×), not a path parameter.
  float travel = 0.3f + dist / 170.f;
  if (travel < 0.25f) travel = 0.25f;
  p->duration = travel * 1.6f;
  if (p->duration < 0.8f) p->duration = 0.8f;
  if (p->duration > 2.2f) p->duration = 2.2f;
  p->trail_len = 0;
  for (int t = 0; t < MAX_TRAIL; t++) {
    p->trail_x[t] = 0.f;
    p->trail_y[t] = 0.f;
  }
  p->px = ax;
  p->py = ay;
  p->cruise = dist / travel;
  p->vx = (dx / L) * p->cruise;
  p->vy = (dy / L) * p->cruise;
  p->wandered = 0;
  memset(p->hit, 0, sizeof(p->hit));
  if (ai >= 0 && ai < MAX_DANCERS) p->hit[ai] = 1;
  p->gen = (ai >= 0 && ai < MAX_DANCERS) ? fire_gen[ai] : MAX_GEN;
  p->arrived = 0;
  p->overtime = 0.f;
  p->fading = 0;
}

static int target_ok(const Pulse* p, int i, int need_awake) {
  if (i < 0 || i >= count || i == p->a || p->hit[i]) return 0;
  return need_awake ? dancers[i].rest <= 0.f : 1;
}

// Nearest dancer to the pulse head: awake first, then any other dancer, and
// as a last resort the source itself (it was the only one left).
static int nearest_target(const Pulse* p) {
  for (int pass = 0; pass < 3; pass++) {
    int best = -1;
    float bd = 1e30f;
    for (int i = 0; i < count; i++) {
      if (pass < 2 ? !target_ok(p, i, pass == 0) : i < 0) continue;
      float tx, ty;
      aim_of(i, &tx, &ty);
      float dx = tx - p->px, dy = ty - p->py;
      float d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = i; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

static int any_awake_target(const Pulse* p) {
  for (int i = 0; i < count; i++) if (target_ok(p, i, 1)) return 1;
  return 0;
}

// Point the pulse at a (new) target from where it is now, keeping its
// position, velocity, and trail. The travel estimate restarts from here.
static void retarget(Pulse* p, int b) {
  if (b < 0) return;
  p->b = b;
  float tx, ty;
  aim_of(b, &tx, &ty);
  float dx = tx - p->px, dy = ty - p->py;
  float L = __builtin_sqrtf(dx * dx + dy * dy);
  float travel = 0.3f + L / 170.f;
  if (travel < 0.25f) travel = 0.25f;
  float cruise = L / travel;
  if (cruise < 60.f) cruise = 60.f;
  p->cruise = cruise;
  float need = travel * 1.6f;
  if (need < 0.6f) need = 0.6f;
  p->duration = p->age + need;
}

// Tight contact radius in stage units.
constexpr float CONTACT_R = 4.f;

// Homing toward the target's current aim. Inverse-distance pull, mild
// damping, and a capture-radius steering ramp so the pulse arrives in
// about the old travel time and does not orbit.
constexpr float CAPTURE_R = 28.f;
constexpr float SOFT_R = 12.f;
constexpr float V_MAX = 280.f;

static void home_toward(Pulse* p, float dt) {
  if (!p || p->arrived || !(dt > 0.f) || !pulse_alive(p)) return;
  float tx, ty;
  aim_of(p->b, &tx, &ty);
  float dx = tx - p->px;
  float dy = ty - p->py;
  float r = __builtin_sqrtf(dx * dx + dy * dy);
  if (r <= CONTACT_R) {
    p->px = tx;
    p->py = ty;
    p->vx = p->vy = 0.f;
    return;
  }
  float ux = dx / r;
  float uy = dy / r;
  float pull = (gravity_pull > 0.f ? gravity_pull : 0.f) * 220.f;
  float denom = r > SOFT_R ? r : SOFT_R;
  float acc = pull / denom;
  p->vx += ux * acc * dt;
  p->vy += uy * acc * dt;
  // Steering ramp: stronger inside the capture radius, always a little
  // so a moving target is followed and we don't loop.
  float capture = 0.f;
  if (r < CAPTURE_R) capture = 1.f - r / CAPTURE_R;
  // Capture ramp: the longer a pulse is overdue, the harder it steers, so a
  // miss turns into a landing instead of an orbit.
  float late = p->overtime > 0.f ? 0.25f + p->overtime / 0.8f : 0.f;
  if (late > 1.f) late = 1.f;
  if (late > capture) capture = late;
  float steer_rate = 1.6f + 10.f * capture + 30.f * late;
  float s = 1.f - nd_exp(-steer_rate * dt);
  if (s < 0.f) s = 0.f;
  if (s > 1.f) s = 1.f;
  float sp = __builtin_sqrtf(p->vx * p->vx + p->vy * p->vy);
  float cruise = p->cruise > 8.f ? p->cruise : 8.f;
  // Overdue pulses speed up (up to 3x) so a moving target can't outrun them.
  cruise *= 1.f + 2.f * late;
  if (late > 0.f && sp < cruise) sp = cruise;
  if (sp < 0.1f) sp = cruise;
  p->vx = p->vx * (1.f - s) + ux * sp * s;
  p->vy = p->vy * (1.f - s) + uy * sp * s;
  if (sp < cruise) {
    float boost = (cruise - sp) * (1.2f + 2.f * capture) * dt;
    p->vx += ux * boost;
    p->vy += uy * boost;
  }
  float damp = nd_exp(-0.4f * dt * (1.f + 3.f * capture));
  p->vx *= damp;
  p->vy *= damp;
  sp = __builtin_sqrtf(p->vx * p->vx + p->vy * p->vy);
  float vmax = V_MAX * (1.f + 1.5f * late);
  if (sp > vmax) {
    p->vx = p->vx / sp * vmax;
    p->vy = p->vy / sp * vmax;
  }
  float nx = p->px + p->vx * dt;
  float ny = p->py + p->vy * dt;
  float dx2 = tx - nx;
  float dy2 = ty - ny;
  // If this step would pass through the target, snap onto it.
  if (dx * dx2 + dy * dy2 < 0.f && r < CAPTURE_R * 1.4f) {
    p->px = tx;
    p->py = ty;
    p->vx = p->vy = 0.f;
    return;
  }
  p->px = nx;
  p->py = ny;
}

static void maybe_wander(Pulse* p, float dt) {
  if (!(wander_rate > 0.f) || p->wandered || p->arrived || !(dt > 0.f)) return;
  if (rnd() > wander_rate * dt) return;
  float hx = p->px, hy = p->py;
  int cand[MAX_DANCERS];
  int nc = 0;
  for (int i = 0; i < count; i++) {
    if (i == p->a || i == p->b) continue;
    float ax, ay;
    aim_of(i, &ax, &ay);
    float dx = ax - hx;
    float dy = ay - hy;
    if (dx * dx + dy * dy < 190.f * 190.f) cand[nc++] = i;
  }
  if (!nc) return;
  int pick = (int)(rnd() * (float)nc);
  if (pick < 0 || pick >= nc) pick = 0;
  p->wandered = 1;
  p->b = cand[pick];
  // Keep the current position, velocity, age, and world-space trail; the
  // particle now homes toward the new target's live head.
  float tx, ty;
  aim_of(p->b, &tx, &ty);
  float dx = tx - p->px;
  float dy = ty - p->py;
  float L = __builtin_sqrtf(dx * dx + dy * dy);
  if (L > 1.f) {
    float travel = 0.3f + L / 170.f;
    p->cruise = L / travel;
    float remain = p->duration - p->age;
    float need = travel * 1.2f;
    if (need > remain) p->duration = p->age + need;
  }
}

// Tight contact radius in stage units. The old 18 px window fired early, so a
// pulse could be marked as hitting while its head was still short of (or, with
// gravity, already past) the dancer it was aimed at.
static void impact_dancer(Pulse* p, int i) {
  if (!p || i < 0 || i >= count) return;
  if (p->hit[i]) return;
  p->hit[i] = 1;
  int src = p->a;
  if (settling) return; // silence: the pulse lands, nothing re-energises
  float sens = 1.f;
  if (p->k >= 0 && p->k <= 3) sens = band_sens[p->k];
  if (!(sens > 0.f)) return;
  float add = 0.48f * sens;
  if (dancers[i].rest > 0.f) {
    // A pulse already in flight still lands on a resting dancer, but only
    // nudges it up to the cooldown cap and never relays.
    float next_r = dancers[i].a + add * 0.5f;
    if (next_r > REST_CAP) next_r = REST_CAP;
    if (next_r > dancers[i].a) dancers[i].a = next_r;
    return;
  }
  float cap = sens > 1.f ? 2.f * sens : 2.f;
  if (cap > 8.f) cap = 8.f;
  float next = dancers[i].a + add;
  if (next > cap) next = cap;
  dancers[i].a = next;
  if (i != src) {
    float rec = dancers[i].recv + add;
    if (rec > cap) rec = cap;
    dancers[i].recv = rec;
  }
  // Pulse arrival can carry the receiver into peak; it emits once on that
  // crossing (inside the 2-hop cap). Already-hot dancers emit on their own
  // band hits, not on arrivals.
  if (enter_peak(&dancers[i]) && p->gen + 1 < MAX_GEN && sim_time - last_any_hit <= QUIET_AFTER && can_emit(&dancers[i])) {
    dancers[i].ref = sim_time + emit_interval();
    enqueue_gen(i, p->gen + 1);
  }
}

static void arrive_at(Pulse* p, int idx) {
  if (!p || p->arrived || idx < 0 || idx >= count) return;
  p->arrived = 1;
  p->b = idx;
  p->age = p->duration;
  aim_of(idx, &p->px, &p->py);
  p->vx = p->vy = 0.f;
  p->wandered = 0;
  impact_dancer(p, idx);
}

static int close_to(float x, float y, int i) {
  if (i < 0 || i >= count) return 0;
  float tx, ty;
  aim_of(i, &tx, &ty);
  float dx = tx - x;
  float dy = ty - y;
  return dx * dx + dy * dy <= CONTACT_R * CONTACT_R;
}

static void collide_pulse(Pulse* p, float x, float y) {
  if (!pulse_alive(p) || p->arrived) return;
  if (close_to(x, y, p->b)) {
    arrive_at(p, p->b);
    return;
  }
  for (int i = 0; i < count; i++) {
    if (i == p->a || p->hit[i]) continue;
    if (close_to(x, y, i)) {
      arrive_at(p, i);
      return;
    }
  }
}

extern "C" {

int nd_api(void) { return 1; }

int nd_spectrum_cap(void) { return MAX_BINS; }

unsigned char* nd_spectrum(void) { return spectrum; }

int nd_dancer_stride(void) { return 6; }

int nd_pulse_stride(void) { return PULSE_STRIDE; }

int nd_count(void) { return count; }

int nd_pulse_count(void) { return pulse_count; }

float* nd_dancers(void) { return dancer_view; }

float* nd_received(void) { return received_view; }

float* nd_pulses(void) { return pulse_view; }

float* nd_heads(void) { return head_in; }

int nd_set_heads(int n) {
  if (n < 0) n = 0;
  if (n > count) n = count;
  for (int i = 0; i < n; i++) {
    aim_x[i] = head_in[i * 2];
    aim_y[i] = head_in[i * 2 + 1];
  }
  for (int i = n; i < count; i++) {
    aim_x[i] = dancers[i].x;
    aim_y[i] = dancers[i].y;
  }
  heads_ready = n > 0 ? 1 : 0;
  return n;
}

float* nd_levels(void) { return levels; }

float* nd_sticker_in(void) { return sticker_in; }

void nd_hit(int type) {
  if (type < 0 || type > 3) return;
  pending_hits |= 1 << type;
}

// A heard attack that landed on a predicted beat (beat-entrain.js).
void nd_hit_on_beat(int type) {
  if (type < 0 || type > 3) return;
  pending_hits |= 1 << type;
  pending_onbeat |= 1 << type;
}
float nd_on_beat_gain(void) { return ON_BEAT_GAIN; }

void nd_set_bpm(float next) { bpm = next > 0.f ? next : 0.f; }

static float clampf_param(float v, float lo, float hi) {
  if (!(v > lo)) return lo;
  if (v > hi) return hi;
  return v;
}

void nd_set_gravity(float v) { gravity_pull = clampf_param(v, 0.f, 6.f); }

void nd_set_wander(float v) { wander_rate = clampf_param(v, 0.f, 0.8f); }

void nd_set_link_radius(float v) { LINK_R = clampf_param(v, 40.f, 240.f); }

float nd_link_radius(void) { return LINK_R; }

void nd_set_threshold(float v) { fire_threshold = clampf_param(v, 0.2f, 3.f); }

void nd_set_peak_hold(float v) { peak_hold = clampf_param(v, 0.05f, 12.f); }

float nd_peak_hold(void) { return peak_hold; }
// Locked listen tempo for the emit interval; 0 (or nonsense) means unlocked.
void nd_set_emit_bpm(float v) { emit_bpm = (v >= 30.f && v <= 300.f) ? v : 0.f; }
float nd_emit_interval(void) { return emit_interval(); }
float nd_peak_level(void) { return PEAK_LEVEL; }
float nd_rest_cap(void) { return REST_CAP; }
// Cumulative counters for tests and debug: dancer emissions (each one passes
// energy to neighbours) and visible pulses spawned.
int nd_emit_total(void) { return emit_total; }
int nd_spawn_total(void) { return spawn_total; }
int nd_dancer_hot(int index) { return index >= 0 && index < count ? dancers[index].hot : 0; }
float nd_dancer_peak_time(int index) { return index >= 0 && index < count ? dancers[index].peak : 0.f; }

void nd_set_band_sens(int band, float v) {
  if (band < 0 || band > 3) return;
  band_sens[band] = clampf_param(v, 0.f, 4.f);
}

// Hard gate for the built-in beat. Listening passes this as well as the
// per-frame flag, so a missed argument cannot keep the synthetic rhythm.
void nd_set_clock(int on) {
  int next = on ? 1 : 0;
  if (next == clock_on) return;
  clock_on = next;
  if (!clock_on) {
    pulse_count = 0;
    for (int i = 0; i < count; i++) {
      dancers[i].a = 0.f;
      dancers[i].recv = 0.f;
      dancers[i].peak = 0.f;
      dancers[i].hot = 0;
      dancers[i].charge = 0.f;
    }
    publish();
  }
}

void nd_set_low(int on) {
  low_power = on ? 1 : 0;
  // No eviction: pulses in flight finish; the lower cap only limits spawns.
  publish();
}

void nd_clear(void) {
  heads_ready = 0;
  sync_aims_from_hips();
  count = 0;
  pulse_count = 0;
  next_id = 1;
  sim_time = 0.f;
  was_listening = 0;
  pending_hits = 0;
  pending_onbeat = 0;
  emit_total = 0;
  spawn_total = 0;
  last_any_hit = -99.f;
  landed_total = 0;
  faded_total = 0;
  missed_total = 0;
  rng_state = 0xC0FFEEu;
  reset_onsets();
  for (int i = 0; i < 4; i++) levels[i] = 0.f;
  publish();
}

static int find_id(int id) {
  for (int i = 0; i < count; i++) if (dancers[i].id == id) return i;
  return -1;
}

// Full sticker map from the UV camera (or the traced stand-in).
// Each record is id, x, y, type in source-photo pixels.
// Matching ids keep their phase and activation so the camera can move stickers
// without restarting the network. Unknown ids are added. Missing ids are removed.
int nd_set_stickers(int n) {
  setup_bands();
  if (n < 0) n = 0;
  if (n > MAX_DANCERS) n = MAX_DANCERS;
  Dancer next[MAX_DANCERS];
  int next_count = 0;
  for (int s = 0; s < n; s++) {
    float* rec = sticker_in + s * 4;
    int id = (int)(rec[0] >= 0.f ? rec[0] + 0.5f : rec[0] - 0.5f);
    float x = rec[1];
    float y = rec[2];
    int type = (int)(rec[3] >= 0.f ? rec[3] + 0.5f : 0.f);
    if (type < 0) type = 0;
    if (type > 3) type = 3;
    int idx = id > 0 ? find_id(id) : -1;
    Dancer d;
    if (idx >= 0) {
      d = dancers[idx];
      d.x = x;
      d.y = y;
      d.k = type;
    } else {
      if (id <= 0) id = next_id++;
      else if (id >= next_id) next_id = id + 1;
      d.id = id;
      d.x = x;
      d.y = y;
      d.k = type;
      d.phase = (float)(id % 7) * 0.047f;
      d.a = 0.f;
      d.recv = 0.f;
      d.rest = 0.f;
      d.peak = 0.f;
      d.ref = 0.f;
      d.charge = 0.f;
      d.last_hit = -99.f;
      d.hot = 0;
    }
    int dup = 0;
    for (int j = 0; j < next_count; j++) if (next[j].id == d.id) dup = 1;
    if (dup) continue;
    next[next_count++] = d;
  }
  int remap[MAX_DANCERS];
  for (int i = 0; i < count; i++) remap[i] = -1;
  for (int j = 0; j < next_count; j++) {
    for (int i = 0; i < count; i++) {
      if (dancers[i].id == next[j].id) remap[i] = j;
    }
  }
  for (int p = pulse_count - 1; p >= 0; p--) {
    int na = pulses[p].a >= 0 && pulses[p].a < count ? remap[pulses[p].a] : -1;
    int nb = pulses[p].b >= 0 && pulses[p].b < count ? remap[pulses[p].b] : -1;
    if (nb < 0 && pulses[p].arrived) remove_pulse_at(p); // landed tail on a removed dancer
    else {
      unsigned char next_hit[MAX_DANCERS];
      memset(next_hit, 0, sizeof(next_hit));
      for (int i = 0; i < count; i++) if (remap[i] >= 0) next_hit[remap[i]] = pulses[p].hit[i];
      memcpy(pulses[p].hit, next_hit, sizeof(next_hit));
      // A removed source is fine (a = -1); a removed target retargets next frame.
      pulses[p].a = na;
      pulses[p].b = nb;
    }
  }
  for (int j = 0; j < next_count; j++) dancers[j] = next[j];
  count = next_count;
  publish();
  return count;
}

int nd_add(float x, float y, int k) {
  setup_bands();
  if (count >= MAX_DANCERS) return 0;
  if (k < 0) k = 0;
  if (k > 3) k = 3;
  int id = next_id++;
  Dancer* d = &dancers[count++];
  d->id = id;
  d->x = x;
  d->y = y;
  d->k = k;
  d->phase = (float)(id % 7) * 0.047f;
  d->a = 0.f;
  d->recv = 0.f;
  d->rest = 0.f;
  d->peak = 0.f;
  d->ref = 0.f;
  d->charge = 0.f;
  d->last_hit = -99.f;
  d->hot = 0;
  aim_x[count - 1] = x;
  aim_y[count - 1] = y;
  publish();
  return id;
}

void nd_remove(int id) {
  int idx = -1;
  for (int i = 0; i < count; i++) if (dancers[i].id == id) { idx = i; break; }
  if (idx < 0) return;
  for (int i = pulse_count - 1; i >= 0; i--) {
    // Only a landed tail on the removed dancer ends; flying pulses carry on.
    if (pulses[i].b == idx && pulses[i].arrived) remove_pulse_at(i);
  }
  for (int i = 0; i < pulse_count; i++) {
    if (pulses[i].a == idx) pulses[i].a = -1;
    else if (pulses[i].a > idx) pulses[i].a--;
    if (pulses[i].b == idx) pulses[i].b = -1;
    else if (pulses[i].b > idx) pulses[i].b--;
    for (int h = idx; h < count - 1; h++) pulses[i].hit[h] = pulses[i].hit[h + 1];
    pulses[i].hit[count - 1] = 0;
  }
  for (int i = idx; i < count - 1; i++) dancers[i] = dancers[i + 1];
  count--;
  publish();
}

void nd_move(int id, float x, float y) {
  for (int i = 0; i < count; i++) {
    if (dancers[i].id != id) continue;
    dancers[i].x = x;
    dancers[i].y = y;
    publish();
    return;
  }
}

int nd_band_range(int band, float sample_rate, int fft_size, int bin_count) {
  setup_bands();
  int i0 = 0, i1 = 0;
  if (!band_range(band, sample_rate, fft_size, bin_count, &i0, &i1)) return -1;
  return i0 | (i1 << 16);
}

static void drain() {
  int cap_pulses = pulse_cap();
  while (q_cursor < qn && q_cursor < MAX_DANCERS) {
    int ai = queue[q_cursor++];
    if (ai < 0 || ai >= count) continue;
    int k = dancers[ai].k;
    if (k >= 0 && k <= 3) tone_mask |= 1 << k;
    int g = fire_gen[ai];
    if (g >= MAX_GEN) continue;
    if (dancers[ai].rest > 0.f) continue;
    emit_total++;
    int trails = 0;
    for (int bi = 0; bi < count; bi++) {
      if (bi == ai || dancers[bi].rest > 0.f) continue;
      float dx = dancers[ai].x - dancers[bi].x;
      float dy = dancers[ai].y - dancers[bi].y;
      float dist = __builtin_sqrtf(dx * dx + dy * dy);
      if (dist >= LINK_R) continue;
      float sens = (k >= 0 && k <= 3) ? band_sens[k] : 1.f;
      if (!(sens > 0.f)) sens = 0.f;
      float used = received[bi];
      float amount = 0.65f - used;
      float falloff = 0.2f + 0.25f * (1.f - dist / LINK_R);
      if (falloff < amount) amount = falloff;
      amount *= sens;
      if (amount > 0.f) {
        received[bi] = used + amount;
        float cap = sens > 1.f ? 2.f * sens : 2.f;
        if (cap > 8.f) cap = 8.f;
        float next = dancers[bi].a + amount;
        if (next > cap) next = cap;
        dancers[bi].a = next;
        float rec = dancers[bi].recv + amount;
        if (rec > cap) rec = cap;
        dancers[bi].recv = rec;
        if (enter_peak(&dancers[bi]) && g + 1 < MAX_GEN && can_emit(&dancers[bi])) {
          dancers[bi].ref = sim_time + emit_interval();
          enqueue_gen(bi, g + 1);
        }
      }
      if (trails < 2 && pulse_count < cap_pulses) {
        spawn_pulse(ai, bi, dist);
        trails++;
      }
    }
  }
}


static void shift_trail(Pulse* p) {
  for (int s = 1; s < p->trail_len; s++) {
    p->trail_x[s - 1] = p->trail_x[s];
    p->trail_y[s - 1] = p->trail_y[s];
  }
  p->trail_len--;
}

// Advance every pulse: fly, retarget when the target is gone / resting /
// missed, land on contact, collapse the tail. Nothing is removed mid-flight;
// only a landed tail or the 20 s leak guard (fading) ends a pulse.
static void step_pulses(float dt) {
  // Music stopped (no band hit for QUIET_AFTER) or the room is hushed:
  // in-flight pulses switch to the full capture ramp and land quickly, and
  // landing no longer re-energises anyone, so the room settles.
  int quiet = settling || sim_time - last_any_hit > QUIET_AFTER;
  int was_settling = settling;
  for (int i = pulse_count - 1; i >= 0; i--) {
    Pulse* p = &pulses[i];
    settling = was_settling || quiet;
    if (!p->arrived && !p->fading) {
      if (count <= 0 || p->age > PULSE_HARD_LIFE) {
        p->fading = 1;
        faded_total++;
      }
    }
    if (p->fading) {
      // Leak guard: shrink in place, never pop. Keep age < duration so the
      // page keeps drawing it as in flight rather than snapping to a head.
      p->vx = p->vy = 0.f;
      p->duration = p->age + 1.f;
      if (p->trail_len <= 1) { remove_pulse_at(i); continue; }
      shift_trail(p);
      if (p->trail_len > 0) {
        p->px = p->trail_x[p->trail_len - 1];
        p->py = p->trail_y[p->trail_len - 1];
      }
      continue;
    }
    if (!p->arrived) {
      // Target gone (sticker removed) or resting while someone else is awake:
      // retarget to the nearest eligible dancer.
      if (!pulse_alive(p) || (dancers[p->b].rest > 0.f && any_awake_target(p))) retarget(p, nearest_target(p));
      if (!pulse_alive(p)) { p->fading = 1; faded_total++; continue; }
      p->age += dt;
      if (quiet && p->overtime < 0.8f) p->overtime = 0.8f;
      else if (p->overtime > 0.f) p->overtime += dt;
      if (p->duration > 0.f && p->age >= p->duration * 0.95f) {
        // Missed its window: pulled into the nearest dancer's gravity, with
        // the capture ramp switched on so it lands instead of orbiting.
        retarget(p, nearest_target(p));
        if (p->overtime <= 0.f) { p->overtime = 1e-3f; missed_total++; }
      }
      maybe_wander(p, dt);
      if (!pulse_alive(p)) retarget(p, nearest_target(p));
      home_toward(p, dt);
    }
    float qx, qy;
    head_pos(p, &qx, &qy);
    if (!p->arrived) {
      collide_pulse(p, qx, qy);
      if (p->arrived) landed_total++;
    }
    if (p->arrived && pulse_alive(p)) {
      // Snap the particle onto the live target head while the tail collapses.
      // Historical trail points stay where they were in stage space.
      aim_of(p->b, &qx, &qy);
      p->px = qx;
      p->py = qy;
      p->vx = p->vy = 0.f;
    }
    if (p->arrived) {
      // Tail catches up: drop the oldest trail point each tick and pin the
      // newest on the current target. Remove the pulse once the tail is gone.
      if (p->trail_len <= 1) {
        remove_pulse_at(i);
        continue;
      }
      shift_trail(p);
      p->trail_x[p->trail_len - 1] = qx;
      p->trail_y[p->trail_len - 1] = qy;
      continue;
    }
    if (p->trail_len >= MAX_TRAIL) {
      for (int s = 1; s < MAX_TRAIL; s++) {
        p->trail_x[s - 1] = p->trail_x[s];
        p->trail_y[s - 1] = p->trail_y[s];
      }
      p->trail_len = MAX_TRAIL - 1;
    }
    p->trail_x[p->trail_len] = qx;
    p->trail_y[p->trail_len] = qy;
    p->trail_len++;
  }
  settling = was_settling;
}

int nd_pulse_landed_total(void) { return landed_total; }
int nd_pulse_faded_total(void) { return faded_total; }
int nd_pulse_missed_total(void) { return missed_total; }

// Silence (TJ 8:32 PM): called each frame while Listen is hushed. Activation
// decays ~4x faster than normal and in-flight pulses age 2x faster, so the
// network is still within about 1 s; nothing new fires.
void nd_settle(float dt) {
  if (!(dt > 0.f)) return;
  if (dt > 0.067f) dt = 0.067f;
  pending_hits = 0;
  pending_onbeat = 0;
  for (int i = 0; i < count; i++) {
    Dancer* d = &dancers[i];
    d->a = d->a * (1.f - dt * 3.f) - dt * 3.f;
    if (d->a < 0.f) d->a = 0.f;
    d->peak = 0.f;
    d->hot = 0;
    d->charge = 0.f;
  }
  // In-flight pulses keep flying (a little faster) and land; they no longer
  // age out mid-air. Landing adds no energy while the room is silent.
  settling = 1;
  step_pulses(dt * 1.5f);
  settling = 0;
  publish();
}

int nd_update(float dt, int listening, int bin_count, float sample_rate, int fft_size, double now_ms) {
  setup_bands();
  if (dt < 0.f) dt = 0.f;
  if (dt > 0.067f) dt = 0.067f;
  if (!heads_ready) sync_aims_from_hips();
  sim_time += dt;
  tone_mask = 0;
  // Listening uses the page's locked tempo; the built-in clock knows its own.
  emit_tempo = listening ? emit_bpm : (clock_on ? bpm : 0.f);
  qn = 0;
  q_cursor = 0;
  for (int i = 0; i < count; i++) {
    emitted[i] = 0;
    received[i] = 0.f;
  }

  if (listening && !was_listening) {
    // Drop the built-in beat the moment the mic takes over.
    pulse_count = 0;
    for (int i = 0; i < count; i++) {
      dancers[i].a = 0.f;
      dancers[i].recv = 0.f;
      dancers[i].peak = 0.f;
      dancers[i].hot = 0;
      dancers[i].charge = 0.f;
    }
    reset_onsets();
  }
  was_listening = listening ? 1 : 0;

  // No band hit for QUIET_AFTER: the music stopped, so energy drains twice
  // as fast and the room settles (nd_settle does 4x once Listen hushes).
  float drain_rate = sim_time - last_any_hit > QUIET_AFTER ? 3.f : 1.5f;
  for (int i = 0; i < count; i++) {
    Dancer* d = &dancers[i];
    d->a -= dt * drain_rate;
    if (d->a < 0.f) d->a = 0.f;
    d->recv -= dt * drain_rate;
    if (d->recv < 0.f) d->recv = 0.f;
    d->charge -= d->charge * CHARGE_DECAY * dt;
    if (d->charge < 0.001f) d->charge = 0.f;
    if (clock_on && !listening) d->phase += dt * bpm * (1.f / 60.f) * RATES[d->k];
    d->rest -= dt;
    if (d->rest < 0.f) d->rest = 0.f;
    if (d->phase >= 1.f) {
      d->phase -= 1.f;
      if (d->phase >= 1.f) d->phase -= 1.f;
      if (clock_on && !listening) arm(i, band_sens[d->k]);
    }
  }

  if (listening && bin_count > 1) {
    int hits[4];
    int n_hits = detect_onsets(bin_count, sample_rate, fft_size, now_ms, hits);
    for (int h = 0; h < n_hits; h++) pending_hits |= 1 << hits[h];
  } else if (!listening) {
    for (int i = 0; i < 4; i++) bands[i].level = 0.f;
  }
  if (pending_hits) {
    for (int k = 0; k < 4; k++) {
      if (!(pending_hits & (1 << k))) continue;
      const int ob = (pending_onbeat >> k) & 1;
      for (int i = 0; i < count; i++) if (dancers[i].k == k) arm(i, band_sens[k], ob);
    }
    pending_hits = 0;
    pending_onbeat = 0;
  }

  drain();

  for (int i = 0; i < count; i++) {
    Dancer* d = &dancers[i];
    if (d->rest > 0.f) {
      d->hot = 0;
      if (d->a > REST_CAP) d->a = REST_CAP;
      continue;
    }
    if (!d->hot) {
      // Time at peak bleeds off between peak periods, so a short phrase gap
      // does not restart the 5 s clock but a real break does.
      d->peak -= dt * 0.6f;
      if (d->peak < 0.f) d->peak = 0.f;
      continue;
    }
    if (sim_time - d->last_hit > HOT_IDLE) {
      // Band went quiet: leave the peak period and decay normally from the
      // peak level (not from whatever the cap allowed).
      d->hot = 0;
      if (d->a > PEAK_LEVEL) d->a = PEAK_LEVEL;
      continue;
    }
    // Peak period: hold at peak while the band keeps hitting.
    if (d->a < PEAK_LEVEL) d->a = PEAK_LEVEL;
    d->peak += dt;
    if (d->peak > peak_hold) {
      d->rest = REST_TIME;
      d->peak = 0.f;
      d->hot = 0;
      d->charge = 0.f;
      d->a = 0.4f;
      if (d->recv > 0.4f) d->recv = 0.4f;
    }
  }

  step_pulses(dt);

  drain();
  publish();
  return tone_mask;
}

}  // extern "C"
