//! Plays the phone's microphone into a Mac output device, normally BlackHole, which Zoom / Meet then
//! pick as their microphone.
//!
//! The phone sends raw 16-bit stereo PCM at 48 kHz (scrcpy `audio_codec=raw`). Phone and Mac clocks
//! drift apart slowly, so a small jitter buffer absorbs bursts and trims itself when it grows.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

pub const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: usize = 2;
/// Audio buffered before playback starts, on top of the user's delay (smooths USB/adb bursts).
const PRIME_MS: usize = 60;
/// Slack above the target before the oldest audio is dropped (a slow clock drift correction).
const SLACK_MS: usize = 200;

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevice {
    pub name: String,
    pub is_blackhole: bool,
    pub supports_48k: bool,
}

pub fn is_blackhole(name: &str) -> bool {
    name.to_ascii_lowercase().contains("blackhole")
}

/// Which device to use for `wanted` ("" = automatic): the exact name, else BlackHole 2ch, else any BlackHole.
pub fn choose<'a>(devices: &'a [OutputDevice], wanted: &str) -> Option<&'a OutputDevice> {
    if !wanted.is_empty() {
        return devices.iter().find(|d| d.name == wanted);
    }
    devices.iter().find(|d| d.name.eq_ignore_ascii_case("BlackHole 2ch") && d.supports_48k).or_else(|| devices.iter().find(|d| d.is_blackhole && d.supports_48k))
}

/// Mic level 0‥1 on a decibel scale (−60 dBFS → 0, 0 dBFS → 1), so quiet speech still moves the meter.
pub fn level(pcm: &[u8]) -> f32 {
    let n = pcm.len() / 2;
    if n == 0 {
        return 0.0;
    }
    let sum: f64 = pcm.chunks_exact(2).map(|b| (i16::from_le_bytes([b[0], b[1]]) as f64 / 32768.0).powi(2)).sum();
    let rms = (sum / n as f64).sqrt();
    if rms <= 0.0 {
        return 0.0;
    }
    (((20.0 * rms.log10()) + 60.0) / 60.0).clamp(0.0, 1.0) as f32
}

/// Lets the session retune the delay of a running player.
#[derive(Clone)]
pub struct RingHandle(Arc<Mutex<Ring>>);

impl RingHandle {
    pub fn set_delay(&self, delay_ms: u32) {
        if let Ok(mut r) = self.0.lock() {
            r.set_delay(delay_ms);
        }
    }
}

/// Interleaved stereo i16 jitter buffer with priming and drift trimming.
pub struct Ring {
    q: VecDeque<i16>,
    prime: usize,
    max: usize,
    playing: bool,
    pub underruns: u64,
    pub trimmed: u64,
}

impl Ring {
    /// `delay_ms` lines the mic up with video that OBS delivers late.
    pub fn new(delay_ms: u32) -> Self {
        let (prime, max) = Self::sizes(delay_ms);
        Self { q: VecDeque::new(), prime, max, playing: false, underruns: 0, trimmed: 0 }
    }

    fn sizes(delay_ms: u32) -> (usize, usize) {
        let samples = |ms: usize| ms * SAMPLE_RATE as usize / 1000 * CHANNELS;
        let prime = samples(PRIME_MS + delay_ms as usize);
        (prime, prime + samples(SLACK_MS))
    }

    /// Change the delay while playing. A longer delay pauses briefly to build up the extra audio; a shorter
    /// one drops the surplus on the next `push`.
    pub fn set_delay(&mut self, delay_ms: u32) {
        let (prime, max) = Self::sizes(delay_ms);
        if prime > self.prime {
            self.playing = false;
        }
        (self.prime, self.max) = (prime, max);
    }

    /// Append little-endian s16 stereo PCM.
    pub fn push(&mut self, pcm: &[u8]) {
        self.q.extend(pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])));
        if self.q.len() > self.max {
            // Keep whole stereo frames: drop down to the target fill.
            let drop = (self.q.len() - self.prime) & !1;
            self.q.drain(..drop);
            self.trimmed += 1;
        }
    }

    /// Fill `out` (interleaved, `channels` per frame) with f32 samples; silence while priming or starved.
    pub fn pull(&mut self, out: &mut [f32], channels: usize) {
        if !self.playing {
            if self.q.len() >= self.prime {
                self.playing = true;
            } else {
                out.fill(0.0);
                return;
            }
        }
        for frame in out.chunks_mut(channels.max(1)) {
            if self.q.len() >= 2 {
                let (l, r) = (self.q.pop_front().unwrap() as f32 / 32768.0, self.q.pop_front().unwrap() as f32 / 32768.0);
                match frame.len() {
                    1 => frame[0] = (l + r) * 0.5,
                    _ => {
                        frame[0] = l;
                        frame[1] = r;
                        frame[2..].fill(0.0);
                    }
                }
            } else {
                frame.fill(0.0);
                if self.playing {
                    self.playing = false; // starved: refill to the target before resuming, instead of crackling
                    self.underruns += 1;
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};
    use std::sync::atomic::{AtomicBool, Ordering};

    fn name_of(d: &cpal::Device) -> Option<String> {
        d.description().ok().map(|d| d.name().to_string())
    }

    /// Output configs at 48 kHz with at least two channels, best first (f32, then i16, then i32; fewest channels).
    fn configs_48k(d: &cpal::Device) -> Vec<cpal::SupportedStreamConfig> {
        let rank = |f: SampleFormat| match f { SampleFormat::F32 => 0, SampleFormat::I16 => 1, SampleFormat::I32 => 2, _ => 9 };
        let mut v: Vec<_> = d.supported_output_configs().map(|it| it.collect::<Vec<_>>()).unwrap_or_default().into_iter().filter(|c| c.channels() >= 2 && rank(c.sample_format()) < 9).filter_map(|c| c.try_with_sample_rate(SAMPLE_RATE)).collect();
        v.sort_by_key(|c| (rank(c.sample_format()), c.channels()));
        v
    }

    pub fn list() -> Vec<OutputDevice> {
        let Ok(devices) = cpal::default_host().output_devices() else { return vec![] };
        devices.filter_map(|d| name_of(&d).map(|name| OutputDevice { is_blackhole: is_blackhole(&name), supports_48k: !configs_48k(&d).is_empty(), name })).collect()
    }

    pub struct Player {
        pub device: String,
        ring: Arc<Mutex<Ring>>,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Player {
        pub fn push(&self, pcm: &[u8]) {
            if let Ok(mut r) = self.ring.lock() {
                r.push(pcm);
            }
        }
        pub fn handle(&self) -> RingHandle {
            RingHandle(self.ring.clone())
        }
    }

    impl Drop for Player {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(t) = self.thread.take() {
                t.thread().unpark();
                let _ = t.join();
            }
        }
    }

    fn run<T>(device: &cpal::Device, config: StreamConfig, ring: Arc<Mutex<Ring>>) -> Result<cpal::Stream, String>
    where
        T: SizedSample + FromSample<f32>,
    {
        let channels = config.channels as usize;
        let mut scratch: Vec<f32> = Vec::new();
        device
            .build_output_stream(
                config,
                move |data: &mut [T], _| {
                    scratch.resize(data.len(), 0.0);
                    match ring.try_lock() {
                        Ok(mut r) => r.pull(&mut scratch, channels),
                        Err(_) => scratch.fill(0.0), // never wait on the audio thread
                    }
                    for (o, s) in data.iter_mut().zip(&scratch) {
                        *o = T::from_sample(*s);
                    }
                },
                |e| tracing::warn!("webcam audio output: {e}"),
                None,
            )
            .map_err(|e| format!("Couldn't open the audio output: {e}"))
    }

    /// Open `wanted` ("" = BlackHole) and start playing what `push` receives.
    pub fn start(wanted: &str, delay_ms: u32) -> Result<Player, String> {
        let wanted = wanted.to_string();
        let ring = Arc::new(Mutex::new(Ring::new(delay_ms)));
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<String, String>>();
        let thread = {
            let (ring, stop) = (ring.clone(), stop.clone());
            // The cpal stream isn't `Send`, so one thread builds it, owns it, and drops it.
            std::thread::Builder::new().name("webcam-audio".into()).spawn(move || {
                let built = (|| {
                    let host = cpal::default_host();
                    let devices = host.output_devices().map_err(|e| format!("Couldn't list audio devices: {e}"))?.collect::<Vec<_>>();
                    let info: Vec<OutputDevice> = devices.iter().filter_map(name_of).map(|name| OutputDevice { is_blackhole: is_blackhole(&name), supports_48k: true, name }).collect();
                    let target = if wanted.is_empty() {
                        // The exact "BlackHole 2ch" if present, else any BlackHole.
                        choose(&info, "").map(|d| d.name.clone()).ok_or("BlackHole isn't installed. Install it (brew install --cask blackhole-2ch) or pick another output device.")?
                    } else {
                        wanted.clone()
                    };
                    let device = devices.iter().find(|d| name_of(d).as_deref() == Some(target.as_str())).ok_or_else(|| format!("The audio output “{target}” isn't available."))?;
                    let name = name_of(device).unwrap_or_default();
                    let cfg = configs_48k(device).into_iter().next().ok_or_else(|| format!("“{name}” can't play 48 kHz audio."))?;
                    let (format, config) = (cfg.sample_format(), cfg.config());
                    let stream = match format {
                        SampleFormat::F32 => run::<f32>(device, config, ring.clone()),
                        SampleFormat::I16 => run::<i16>(device, config, ring.clone()),
                        _ => run::<i32>(device, config, ring.clone()),
                    }?;
                    stream.play().map_err(|e| format!("Couldn't start the audio output: {e}"))?;
                    Ok::<_, String>((stream, name))
                })();
                match built {
                    Ok((stream, name)) => {
                        let _ = ready_tx.send(Ok(name));
                        while !stop.load(Ordering::Relaxed) {
                            std::thread::park_timeout(std::time::Duration::from_millis(200));
                        }
                        drop(stream);
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                }
            })
        }
        .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(Ok(device)) => Ok(Player { device, ring, stop, thread: Some(thread) }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("The audio output didn't respond.".into()),
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::{list as list_output_devices, start};

#[cfg(not(target_os = "macos"))]
pub struct Player {
    pub device: String,
}
#[cfg(not(target_os = "macos"))]
impl Player {
    pub fn push(&self, _pcm: &[u8]) {}
    pub fn handle(&self) -> RingHandle {
        RingHandle(Arc::new(Mutex::new(Ring::new(0))))
    }
}
#[cfg(not(target_os = "macos"))]
pub fn list_output_devices() -> Vec<OutputDevice> {
    vec![]
}
#[cfg(not(target_os = "macos"))]
pub fn start(_wanted: &str, _delay_ms: u32) -> Result<Player, String> {
    Err("Phone microphone output is only available on macOS.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(frames: &[(i16, i16)]) -> Vec<u8> {
        frames.iter().flat_map(|(l, r)| l.to_le_bytes().into_iter().chain(r.to_le_bytes())).collect()
    }
    fn dev(name: &str, ok: bool) -> OutputDevice {
        OutputDevice { name: name.into(), is_blackhole: is_blackhole(name), supports_48k: ok }
    }

    #[test]
    fn audio_waits_to_prime_then_plays_in_order() {
        let mut r = Ring::new(0);
        let prime_frames = PRIME_MS * 48; // 60 ms of frames
        r.push(&pcm(&vec![(16384, -16384); prime_frames - 1]));
        let mut out = vec![1.0f32; 4];
        r.pull(&mut out, 2);
        assert_eq!(out, [0.0; 4], "silence while priming");
        r.push(&pcm(&[(16384, -16384)]));
        r.pull(&mut out, 2);
        assert_eq!(out, [0.5, -0.5, 0.5, -0.5]);
    }

    #[test]
    fn extra_delay_means_more_audio_is_buffered_before_playing() {
        let mut r = Ring::new(100);
        r.push(&pcm(&vec![(1000, 1000); PRIME_MS * 48]));
        let mut out = [1.0f32; 2];
        r.pull(&mut out, 2);
        assert_eq!(out, [0.0; 2], "60 ms isn't enough when 160 ms is wanted");
        r.push(&pcm(&vec![(1000, 1000); 100 * 48]));
        r.pull(&mut out, 2);
        assert!(out[0] > 0.0);
    }

    #[test]
    fn running_dry_pads_with_silence_and_re_primes() {
        let mut r = Ring::new(0);
        r.push(&pcm(&vec![(8192, 8192); PRIME_MS * 48]));
        let mut out = vec![0.0f32; 2 * PRIME_MS * 48 + 4];
        r.pull(&mut out, 2);
        assert_eq!(r.underruns, 1);
        assert!(out[0] > 0.0 && out[2 * PRIME_MS * 48 + 1] == 0.0, "real audio, then silence");
        r.push(&pcm(&[(8192, 8192); 10]));
        r.pull(&mut out[..2], 2);
        assert_eq!(out[0], 0.0, "doesn't resume on a trickle — waits to re-prime");
    }

    #[test]
    fn the_delay_can_be_changed_while_playing() {
        let mut r = Ring::new(0);
        r.push(&pcm(&vec![(8192, 8192); PRIME_MS * 48]));
        let mut out = [0.0f32; 2];
        r.pull(&mut out, 2);
        assert!(out[0] > 0.0, "playing");
        r.set_delay(200); // longer: pause and build up the extra 200 ms first
        r.push(&pcm(&vec![(8192, 8192); 100 * 48]));
        r.pull(&mut out, 2);
        assert_eq!(out, [0.0; 2], "re-priming to 260 ms");
        r.push(&pcm(&vec![(8192, 8192); 160 * 48]));
        r.pull(&mut out, 2);
        assert!(out[0] > 0.0, "resumes once the new target is buffered");
        r.set_delay(0); // shorter: the next push drops the surplus down to the new target
        r.push(&pcm(&[(1, 1)]));
        assert_eq!(r.q.len(), PRIME_MS * 48 * 2, "back to 60 ms");
        assert_eq!(r.trimmed, 1);
    }

    #[test]
    fn a_growing_buffer_is_trimmed_to_the_target_in_whole_frames() {
        let mut r = Ring::new(0);
        r.push(&pcm(&vec![(1, 1); (PRIME_MS + SLACK_MS) * 48 + 5])); // over the limit
        assert_eq!(r.trimmed, 1);
        assert_eq!(r.q.len(), PRIME_MS * 48 * 2, "back to the prime level");
        assert_eq!(r.q.len() % 2, 0);
    }

    #[test]
    fn channel_layouts_are_mapped() {
        let mut r = Ring::new(0);
        r.playing = true;
        r.push(&pcm(&[(16384, -16384), (16384, -16384)]));
        let mut six = [9.0f32; 6];
        r.pull(&mut six, 6); // one 6-channel frame
        assert_eq!(six, [0.5, -0.5, 0.0, 0.0, 0.0, 0.0]);
        let mut mono = [9.0f32; 1];
        r.pull(&mut mono, 1);
        assert_eq!(mono, [0.0], "(0.5 + -0.5) / 2");
    }

    #[test]
    fn level_is_a_decibel_meter() {
        assert_eq!(level(&[]), 0.0);
        assert_eq!(level(&pcm(&vec![(0, 0); 100])), 0.0);
        let full = level(&pcm(&vec![(32767, 32767); 100]));
        assert!(full > 0.99, "{full}");
        let quiet = level(&pcm(&vec![(33, 33); 100])); // ≈ −60 dBFS
        assert!(quiet < 0.02, "{quiet}");
        let speech = level(&pcm(&vec![(1000, 1000); 100])); // ≈ −30 dBFS
        assert!((speech - 0.5).abs() < 0.05, "{speech}");
    }

    #[test]
    fn device_choice_prefers_blackhole_2ch_and_respects_a_named_device() {
        let all = [dev("MacBook Pro Speakers", true), dev("BlackHole 16ch", true), dev("BlackHole 2ch", true)];
        assert_eq!(choose(&all, "").unwrap().name, "BlackHole 2ch");
        assert_eq!(choose(&all, "MacBook Pro Speakers").unwrap().name, "MacBook Pro Speakers");
        assert!(choose(&all, "Nope").is_none());
        let only16 = [dev("BlackHole 16ch", true), dev("Speakers", true)];
        assert_eq!(choose(&only16, "").unwrap().name, "BlackHole 16ch");
        assert!(choose(&[dev("Speakers", true)], "").is_none(), "no BlackHole → no automatic choice");
        assert!(choose(&[dev("BlackHole 2ch", false)], "").is_none(), "a BlackHole that can't do 48 kHz isn't usable");
    }
}
