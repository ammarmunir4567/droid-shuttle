//! Fan-out of one live stream to several consumers: OBS connections and the in-app preview.
//!
//! A consumer that can't keep up never stalls the phone: it skips frames until the next key frame.

use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub type Chunk = Arc<Vec<u8>>;

/// Chunks a slow consumer may fall behind by before it starts skipping to the next key frame.
const BACKLOG: usize = 64;
/// Most we keep of the current group of pictures for late joiners; a longer one just isn't replayed.
const GOP_CAP: usize = 24 << 20;

#[derive(Default)]
pub struct Hub {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Chunks every new consumer must see first (stream tables, codec config, picture size), by slot.
    sticky: Vec<Option<Chunk>>,
    /// Key frame + the deltas since, for consumers that want to catch up instantly.
    gop: Vec<Chunk>,
    gop_bytes: usize,
    gop_valid: bool,
    clients: Vec<Client>,
}

struct Client {
    tx: mpsc::Sender<Chunk>,
    /// Skipping deltas until the next key frame (new, or fell behind).
    wait_key: bool,
}

impl Hub {
    /// Remember `data` for newcomers (replacing the slot's previous chunk) and pass it to everyone now.
    pub fn publish_sticky(&self, slot: usize, data: Vec<u8>) {
        let chunk: Chunk = Arc::new(data);
        let mut g = self.inner.lock().unwrap();
        if g.sticky.len() <= slot {
            g.sticky.resize(slot + 1, None);
        }
        g.sticky[slot] = Some(chunk.clone());
        g.clients.retain(|c| !matches!(c.tx.try_send(chunk.clone()), Err(mpsc::error::TrySendError::Closed(_))));
    }

    pub fn publish_frame(&self, key: bool, data: Vec<u8>) {
        let chunk: Chunk = Arc::new(data);
        let mut g = self.inner.lock().unwrap();
        if key {
            g.gop.clear();
            g.gop_bytes = 0;
            g.gop_valid = true;
        }
        if g.gop_valid {
            g.gop_bytes += chunk.len();
            if g.gop_bytes > GOP_CAP {
                g.gop.clear();
                g.gop_bytes = 0;
                g.gop_valid = false;
            } else {
                g.gop.push(chunk.clone());
            }
        }
        g.clients.retain_mut(|c| {
            if c.wait_key && !key {
                return true;
            }
            match c.tx.try_send(chunk.clone()) {
                Ok(()) => {
                    c.wait_key = false;
                    true
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    c.wait_key = true; // too slow: drop deltas until the next key frame
                    true
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            }
        });
    }

    /// A new consumer. It first gets the sticky chunks; with `replay` it then gets the current group of
    /// pictures (a decoder that renders as fast as it can catches up at once), otherwise it waits for the
    /// next key frame (right for a player that honours timestamps: replaying would add seconds of delay).
    pub fn subscribe(&self, replay: bool) -> mpsc::Receiver<Chunk> {
        let mut g = self.inner.lock().unwrap();
        let mut prime: Vec<Chunk> = g.sticky.iter().flatten().cloned().collect();
        let replayed = replay && g.gop_valid;
        if replayed {
            prime.extend(g.gop.iter().cloned());
        }
        let (tx, rx) = mpsc::channel(BACKLOG + prime.len());
        for c in prime {
            let _ = tx.try_send(c);
        }
        g.clients.push(Client { tx, wait_key: !replayed });
        rx
    }

    /// End every consumer's stream (they see the channel close).
    pub fn close(&self) {
        let mut g = self.inner.lock().unwrap();
        g.clients.clear();
        g.sticky.clear();
        g.gop.clear();
        g.gop_valid = false;
    }

    #[cfg(test)]
    fn clients(&self) -> usize {
        self.inner.lock().unwrap().clients.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(rx: &mut mpsc::Receiver<Chunk>) -> Vec<Vec<u8>> {
        let mut v = vec![];
        while let Ok(c) = rx.try_recv() {
            v.push((*c).clone());
        }
        v
    }

    #[test]
    fn a_late_joiner_gets_the_sticky_chunks_then_the_current_gop() {
        let h = Hub::default();
        h.publish_sticky(0, vec![b's']);
        h.publish_sticky(1, vec![b'c']);
        h.publish_frame(true, vec![b'K']); // an older GOP …
        h.publish_frame(false, vec![b'x']);
        h.publish_frame(true, vec![b'k']); // … replaced by this one
        h.publish_frame(false, vec![b'd']);
        let mut rx = h.subscribe(true);
        assert_eq!(drain(&mut rx), [vec![b's'], vec![b'c'], vec![b'k'], vec![b'd']]);
        h.publish_frame(false, vec![b'e']);
        assert_eq!(drain(&mut rx), [vec![b'e']], "then live");
    }

    #[test]
    fn without_replay_a_newcomer_waits_for_the_next_key_frame() {
        let h = Hub::default();
        h.publish_sticky(0, vec![b's']);
        h.publish_frame(true, vec![b'k']);
        let mut rx = h.subscribe(false);
        assert_eq!(drain(&mut rx), [vec![b's']]);
        h.publish_frame(false, vec![b'd']);
        assert!(drain(&mut rx).is_empty(), "deltas are useless before a key frame");
        h.publish_frame(true, vec![b'K']);
        h.publish_frame(false, vec![b'e']);
        assert_eq!(drain(&mut rx), [vec![b'K'], vec![b'e']]);
    }

    #[test]
    fn a_slow_consumer_skips_to_the_next_key_frame_instead_of_blocking() {
        let h = Hub::default();
        let mut rx = h.subscribe(false);
        h.publish_frame(true, vec![0]);
        for i in 0..BACKLOG + 10 {
            h.publish_frame(false, vec![1 + i as u8]); // never read → the queue fills
        }
        assert_eq!(h.clients(), 1, "still subscribed");
        let got = drain(&mut rx);
        assert_eq!(got.len(), BACKLOG, "bounded backlog");
        h.publish_frame(false, vec![99]);
        assert!(drain(&mut rx).is_empty(), "deltas stay dropped until a key frame");
        h.publish_frame(true, vec![100]);
        assert_eq!(drain(&mut rx), [vec![100]], "resumes on a key frame");
    }

    #[test]
    fn sticky_updates_reach_existing_consumers_and_closed_ones_are_dropped() {
        let h = Hub::default();
        let mut a = h.subscribe(false);
        let b = h.subscribe(false);
        drop(b);
        h.publish_sticky(0, vec![7]);
        assert_eq!(drain(&mut a), [vec![7]]);
        assert_eq!(h.clients(), 1, "the closed consumer is gone");
        h.close();
        assert!(matches!(a.try_recv(), Err(mpsc::error::TryRecvError::Disconnected)), "close ends the stream");
    }

    #[test]
    fn an_oversized_gop_is_not_replayed() {
        let h = Hub::default();
        h.publish_frame(true, vec![0; GOP_CAP / 2]);
        h.publish_frame(false, vec![0; GOP_CAP / 2 + 1]);
        let mut rx = h.subscribe(true);
        assert!(drain(&mut rx).is_empty());
        h.publish_frame(true, vec![5]);
        assert_eq!(drain(&mut rx), [vec![5]], "starts clean on the next key frame");
    }
}
