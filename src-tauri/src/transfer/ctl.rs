//! Pause / cancel handle shared by a job and every file task inside it.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::watch;

#[derive(Clone)]
pub struct Ctl {
    cancel: Arc<AtomicBool>,
    pause: watch::Receiver<bool>,
}

pub struct CtlOwner {
    cancel: Arc<AtomicBool>,
    pause: watch::Sender<bool>,
}

pub fn channel() -> (CtlOwner, Ctl) {
    let cancel = Arc::new(AtomicBool::new(false));
    let (tx, rx) = watch::channel(false);
    (CtlOwner { cancel: cancel.clone(), pause: tx }, Ctl { cancel, pause: rx })
}

impl CtlOwner {
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        let _ = self.pause.send(false); // wake anything parked on pause
    }
    pub fn set_paused(&self, p: bool) {
        let _ = self.pause.send(p);
    }
}

impl Ctl {
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Call between chunks: parks while paused, errors out when cancelled.
    pub async fn gate(&self) -> Result<(), crate::adb::AdbError> {
        let mut rx = self.pause.clone();
        while *rx.borrow() && !self.is_cancelled() {
            if rx.changed().await.is_err() {
                break;
            }
        }
        if self.is_cancelled() {
            Err(crate::adb::AdbError::Cancelled)
        } else {
            Ok(())
        }
    }
}
