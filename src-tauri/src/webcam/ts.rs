//! A tiny MPEG-TS muxer: one H.264 (Annex B) video stream → 188-byte packets.
//!
//! OBS's "Media Source" (ffmpeg) plays this straight off a TCP socket, so the phone's H.264 reaches
//! OBS without being decoded or re-encoded on the Mac.

pub const PACKET: usize = 188;
const PID_PMT: u16 = 0x1000;
const PID_VIDEO: u16 = 0x0100;
/// Timestamps start at 1 s so the clock reference, which trails the PTS, never goes negative.
const PTS_BASE: u64 = 90_000;
/// How far the clock reference trails the frame's PTS (50 ms at 90 kHz).
const PCR_LEAD: u64 = 4_500;
const MASK_33: u64 = (1 << 33) - 1;

/// CRC-32/MPEG-2 (poly 0x04C11DB7, no reflection, no final xor), used by the PAT and PMT.
fn crc32_mpeg(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &b in data {
        crc ^= (b as u32) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 { (crc << 1) ^ 0x04c1_1db7 } else { crc << 1 };
        }
    }
    crc
}

/// A PSI table (without its CRC) in a single packet, padded with 0xff.
fn psi_packet(pid: u16, cc: &mut u8, mut section: Vec<u8>) -> [u8; PACKET] {
    let crc = crc32_mpeg(&section);
    section.extend_from_slice(&crc.to_be_bytes());
    let mut p = [0xffu8; PACKET];
    p[0] = 0x47;
    p[1] = 0x40 | (pid >> 8) as u8; // payload unit start
    p[2] = pid as u8;
    p[3] = 0x10 | (*cc & 0x0f);
    *cc = (*cc + 1) & 0x0f;
    p[4] = 0; // pointer field
    p[5..5 + section.len()].copy_from_slice(&section);
    p
}

/// 33-bit PTS in the 5-byte PES encoding (marker bits included).
fn pts_bytes(pts: u64) -> [u8; 5] {
    [
        0x21 | ((pts >> 29) & 0x0e) as u8,
        (pts >> 22) as u8,
        0x01 | ((pts >> 14) & 0xfe) as u8,
        (pts >> 7) as u8,
        0x01 | ((pts << 1) & 0xfe) as u8,
    ]
}

/// 33-bit PCR base (90 kHz) in the 6-byte adaptation-field encoding, extension 0.
fn pcr_bytes(base: u64) -> [u8; 6] {
    [(base >> 25) as u8, (base >> 17) as u8, (base >> 9) as u8, (base >> 1) as u8, (((base & 1) << 7) as u8) | 0x7e, 0]
}

/// An H.264 access unit as MPEG-TS wants it: an AUD, then (on key frames) the SPS/PPS the phone sends
/// as a separate "config" packet, then the frame itself.
pub fn access_unit(config: &[u8], frame: &[u8], key: bool) -> Vec<u8> {
    let mut au = Vec::with_capacity(6 + config.len() + frame.len());
    au.extend_from_slice(&[0, 0, 0, 1, 0x09, 0xf0]);
    if key {
        au.extend_from_slice(config);
    }
    au.extend_from_slice(frame);
    au
}

#[derive(Default)]
pub struct Muxer {
    cc_pat: u8,
    cc_pmt: u8,
    cc_video: u8,
}

impl Muxer {
    pub fn new() -> Self {
        Self::default()
    }

    /// PAT + PMT: what a player needs to find the video stream. Repeat them with every key frame.
    pub fn tables(&mut self) -> Vec<u8> {
        let pat = vec![
            0x00, // table id
            0xb0, 0x0d, // section length 13
            0x00, 0x01, // transport stream id
            0xc1, 0x00, 0x00, // version 0, current, section 0 of 0
            0x00, 0x01, // program 1 …
            0xe0 | (PID_PMT >> 8) as u8, PID_PMT as u8, // … is described on the PMT pid
        ];
        let pmt = vec![
            0x02, // table id
            0xb0, 0x12, // section length 18
            0x00, 0x01, // program 1
            0xc1, 0x00, 0x00,
            0xe0 | (PID_VIDEO >> 8) as u8, PID_VIDEO as u8, // PCR rides on the video pid
            0xf0, 0x00, // no program descriptors
            0x1b, 0xe0 | (PID_VIDEO >> 8) as u8, PID_VIDEO as u8, 0xf0, 0x00, // H.264 on the video pid
        ];
        let mut out = Vec::with_capacity(2 * PACKET);
        out.extend_from_slice(&psi_packet(0, &mut self.cc_pat, pat));
        out.extend_from_slice(&psi_packet(PID_PMT, &mut self.cc_pmt, pmt));
        out
    }

    /// One access unit → PES → TS packets. `pts_us` is the phone's timestamp in microseconds.
    pub fn video(&mut self, access_unit: &[u8], pts_us: u64, key: bool) -> Vec<u8> {
        let pts = PTS_BASE + pts_us * 9 / 100;
        let pcr = pts - PCR_LEAD;
        let mut pes = Vec::with_capacity(access_unit.len() + 14);
        pes.extend_from_slice(&[0, 0, 1, 0xe0, 0, 0]); // start code, video stream 0, unbounded length
        pes.extend_from_slice(&[0x80, 0x80, 5]); // PTS only, 5 header bytes
        pes.extend_from_slice(&pts_bytes(pts & MASK_33));
        pes.extend_from_slice(access_unit);

        let mut out = Vec::with_capacity((pes.len() / 176 + 2) * PACKET);
        let (mut off, mut first) = (0, true);
        while off < pes.len() {
            // The first packet of every frame carries the PCR (and a random-access flag on key frames).
            let af_head = if first { 8 } else { 0 };
            let room = 184 - af_head;
            let take = (pes.len() - off).min(room);
            let pad = room - take; // short last packet → stuff the adaptation field
            let mut p = [0xffu8; PACKET];
            p[0] = 0x47;
            p[1] = (if first { 0x40 } else { 0 }) | (PID_VIDEO >> 8) as u8;
            p[2] = PID_VIDEO as u8;
            let af_total = af_head + pad;
            p[3] = (if af_total > 0 { 0x30 } else { 0x10 }) | (self.cc_video & 0x0f);
            self.cc_video = (self.cc_video + 1) & 0x0f;
            let mut i = 4;
            if af_total > 0 {
                p[i] = (af_total - 1) as u8;
                if af_total > 1 {
                    p[i + 1] = if first { 0x10 | if key { 0x40 } else { 0 } } else { 0 };
                    if first {
                        p[i + 2..i + 8].copy_from_slice(&pcr_bytes(pcr & MASK_33));
                    }
                }
                i += af_total;
            }
            p[i..i + take].copy_from_slice(&pes[off..off + take]);
            out.extend_from_slice(&p);
            off += take;
            first = false;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Pkt {
        pid: u16,
        start: bool,
        cc: u8,
        random_access: bool,
        pcr: Option<u64>,
        payload: Vec<u8>,
    }

    fn parse(ts: &[u8]) -> Vec<Pkt> {
        assert_eq!(ts.len() % PACKET, 0, "whole packets only");
        ts.chunks(PACKET)
            .map(|p| {
                assert_eq!(p[0], 0x47, "sync byte");
                let (mut i, mut random_access, mut pcr) = (4, false, None);
                if p[3] & 0x20 != 0 {
                    let af = p[4] as usize;
                    if af > 0 {
                        random_access = p[5] & 0x40 != 0;
                        if p[5] & 0x10 != 0 {
                            let b = &p[6..12];
                            pcr = Some(((b[0] as u64) << 25) | ((b[1] as u64) << 17) | ((b[2] as u64) << 9) | ((b[3] as u64) << 1) | (b[4] as u64 >> 7));
                        }
                    }
                    i += 1 + af;
                }
                Pkt { pid: ((p[1] & 0x1f) as u16) << 8 | p[2] as u16, start: p[1] & 0x40 != 0, cc: p[3] & 0x0f, random_access, pcr, payload: p[i..].to_vec() }
            })
            .collect()
    }

    fn pts_from(b: &[u8]) -> u64 {
        (((b[0] >> 1) & 7) as u64) << 30 | (b[1] as u64) << 22 | ((b[2] >> 1) as u64) << 15 | (b[3] as u64) << 7 | (b[4] >> 1) as u64
    }

    #[test]
    fn tables_are_valid_psi_sections() {
        let mut m = Muxer::new();
        let t = m.tables();
        assert_eq!(t.len(), 2 * PACKET);
        let pk = parse(&t);
        assert_eq!((pk[0].pid, pk[1].pid), (0, PID_PMT));
        for p in &pk {
            assert!(p.start && p.payload[0] == 0, "pointer field 0");
            let len = (((p.payload[2] & 0x0f) as usize) << 8 | p.payload[3] as usize) + 3; // incl. header up to length field
            // CRC over the whole section (table id … CRC) is zero when it is correct.
            assert_eq!(crc32_mpeg(&p.payload[1..1 + len]), 0, "CRC of pid {}", p.pid);
        }
        // PAT announces program 1 on the PMT pid; PMT lists one H.264 stream on the video pid.
        assert_eq!(&pk[0].payload[9..13], &[0x00, 0x01, 0xe0 | (PID_PMT >> 8) as u8, PID_PMT as u8]);
        assert_eq!(&pk[1].payload[13..18], &[0x1b, 0xe0 | (PID_VIDEO >> 8) as u8, PID_VIDEO as u8, 0xf0, 0x00]);
        // Repeating the tables keeps each pid's continuity counter going.
        let again = parse(&m.tables());
        assert_eq!((again[0].cc, again[1].cc), (1, 1));
    }

    #[test]
    fn crc_matches_the_known_check_value() {
        assert_eq!(crc32_mpeg(b"123456789"), 0x0376_e6e7); // CRC-32/MPEG-2 catalogue check value
    }

    #[test]
    fn pts_and_pcr_round_trip_including_above_32_bits() {
        for v in [0u64, 1, 90_000, 0x1_2345_6789, MASK_33] {
            assert_eq!(pts_from(&pts_bytes(v)), v);
        }
        let b = pcr_bytes(0x1_2345_6789);
        let back = ((b[0] as u64) << 25) | ((b[1] as u64) << 17) | ((b[2] as u64) << 9) | ((b[3] as u64) << 1) | (b[4] as u64 >> 7);
        assert_eq!(back, 0x1_2345_6789);
        assert_eq!(b[4] & 0x7e, 0x7e, "reserved bits are ones");
    }

    #[test]
    fn frames_of_every_awkward_size_reassemble_exactly() {
        let mut m = Muxer::new();
        let mut expected_cc = 0u8;
        // Sizes around the 176/183/184-byte boundaries exercise every stuffing case.
        for (n, size) in [1usize, 2, 100, 165, 166, 167, 168, 175, 176, 177, 183, 184, 185, 350, 351, 1000, 50_000].into_iter().enumerate() {
            let au: Vec<u8> = (0..size).map(|i| (i * 7 + n) as u8).collect();
            let key = n % 3 == 0;
            let pts_us = 33_333 * n as u64;
            let pk = parse(&m.video(&au, pts_us, key));
            assert!(pk[0].start && pk.iter().skip(1).all(|p| !p.start), "only the first packet starts the PES (size {size})");
            assert_eq!(pk[0].random_access, key, "random access only on key frames");
            assert_eq!(pk[0].pcr, Some(PTS_BASE + pts_us * 9 / 100 - PCR_LEAD), "PCR trails the PTS");
            assert!(pk.iter().skip(1).all(|p| p.pcr.is_none()));
            for p in &pk {
                assert_eq!(p.pid, PID_VIDEO);
                assert_eq!(p.cc, expected_cc, "continuity (size {size})");
                expected_cc = (expected_cc + 1) & 0x0f;
            }
            let pes: Vec<u8> = pk.iter().flat_map(|p| p.payload.clone()).collect();
            assert_eq!(&pes[..4], &[0, 0, 1, 0xe0]);
            assert_eq!(pts_from(&pes[9..14]), PTS_BASE + pts_us * 9 / 100);
            assert_eq!(&pes[14..], &au[..], "payload intact (size {size})");
        }
    }

    #[test]
    fn access_unit_adds_an_aud_and_only_puts_the_config_on_key_frames() {
        let (cfg, frame) = ([0, 0, 0, 1, 0x67, 1, 2], [0, 0, 0, 1, 0x65, 9, 9]);
        let key = access_unit(&cfg, &frame, true);
        assert_eq!(&key[..6], &[0, 0, 0, 1, 0x09, 0xf0]);
        assert_eq!(&key[6..13], &cfg);
        assert_eq!(&key[13..], &frame);
        assert_eq!(access_unit(&cfg, &frame, false), [&[0u8, 0, 0, 1, 0x09, 0xf0][..], &frame[..]].concat());
    }

    /// NAL units of an Annex B stream, each with its start code.
    fn nal_units(es: &[u8]) -> Vec<&[u8]> {
        let mut starts = vec![];
        let mut i = 0;
        while i + 3 <= es.len() {
            if es[i..i + 3] == [0, 0, 1] {
                starts.push(if i > 0 && es[i - 1] == 0 { i - 1 } else { i });
                i += 3;
            } else {
                i += 1;
            }
        }
        starts.iter().enumerate().map(|(k, &s)| &es[s..*starts.get(k + 1).unwrap_or(&es.len())]).collect()
    }

    /// Real decoder check: have ffmpeg make a short H.264 clip, split it the way the phone does (SPS/PPS as a
    /// separate config, one packet per frame), mux it with ours and make ffmpeg decode the result.
    /// Skipped (with a note) when ffmpeg isn't installed.
    #[test]
    fn ffmpeg_can_decode_what_we_mux() {
        use std::process::Command;
        let ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].into_iter().find(|p| std::path::Path::new(p).exists());
        let Some(ffmpeg) = ffmpeg else { return eprintln!("ffmpeg not installed — skipping") };
        let dir = std::env::temp_dir().join(format!("droidshuttle-ts-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let h264 = dir.join("clip.h264");
        let made = Command::new(ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-t", "2", "-c:v", "libx264", "-x264-params", "aud=1:keyint=30:bframes=0", "-f", "h264"])
            .arg(&h264)
            .status();
        if !matches!(made, Ok(s) if s.success()) {
            let _ = std::fs::remove_dir_all(&dir);
            return eprintln!("ffmpeg has no libx264 — skipping");
        }
        let es = std::fs::read(&h264).unwrap();

        // Like the phone: SPS/PPS are the config; each frame is its slice NALs only (our access_unit adds an AUD).
        let (mut config, mut frames): (Vec<u8>, Vec<(Vec<u8>, bool)>) = (vec![], vec![]);
        for nal in nal_units(&es) {
            let t = nal[nal.iter().position(|&b| b == 1).unwrap() + 1] & 0x1f;
            match t {
                9 => frames.push((vec![], false)),
                7 | 8 if frames.len() <= 1 => config.extend_from_slice(nal), // only the first set
                7 | 8 => {}
                _ => {
                    let f = frames.last_mut().expect("AUD before slices");
                    f.0.extend_from_slice(nal);
                    f.1 |= t == 5;
                }
            }
        }
        assert!(frames.len() >= 55 && !config.is_empty(), "expected ~60 frames and an SPS/PPS, got {} / {}", frames.len(), config.len());

        let mut m = Muxer::new();
        let mut ts = Vec::new();
        for (k, (frame, key)) in frames.iter().enumerate() {
            if *key {
                ts.extend(m.tables());
            }
            ts.extend(m.video(&access_unit(&config, frame, *key), k as u64 * 33_333, *key));
        }
        let ts_path = dir.join("out.ts");
        std::fs::write(&ts_path, &ts).unwrap();

        let out = Command::new(ffmpeg).args(["-v", "error", "-i"]).arg(&ts_path).args(["-f", "null", "-"]).output().unwrap();
        assert!(out.status.success(), "ffmpeg failed to decode our stream: {}", String::from_utf8_lossy(&out.stderr));
        assert!(out.stderr.is_empty(), "ffmpeg reported errors: {}", String::from_utf8_lossy(&out.stderr));

        // Nothing may be dropped on the way: codec, size and the exact number of frames come out as they went in.
        let ffprobe = ffmpeg.replace("ffmpeg", "ffprobe");
        if std::path::Path::new(&ffprobe).exists() {
            let probe = Command::new(&ffprobe)
                .args(["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "csv=p=0"])
                .arg(&ts_path)
                .output()
                .unwrap();
            let line = String::from_utf8_lossy(&probe.stdout).lines().next().unwrap_or_default().trim().to_string(); // (ffprobe prints it twice with -count_frames)
            assert_eq!(line, format!("h264,320,240,{}", frames.len()), "ffprobe saw: {line}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
