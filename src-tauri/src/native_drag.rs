//! Native macOS drag-out: drag files from Droid Shuttle into Finder, Mail, Slack, …
//!
//! Phone files are *promised* (`NSFilePromiseProvider`): nothing is copied while you
//! drag. When the drop lands, macOS asks us to write the file and we pull it from the
//! phone through the normal transfer engine (so it shows up in the transfer tray).
//! Mac files are offered as ordinary file URLs.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragItemSpec {
    pub path: String,
    pub is_dir: bool,
}

#[cfg(target_os = "macos")]
mod mac {
    #![allow(non_snake_case)] // method names mirror the Objective-C selectors
    use super::DragItemSpec;
    use crate::transfer::{Conflict, Direction, Manager, TransferRequest};
    use block2::{DynBlock, RcBlock};
    use objc2::{
        define_class, msg_send, AllocAnyThread,
        rc::Retained,
        runtime::{NSObject, NSObjectProtocol, ProtocolObject},
        DefinedClass, MainThreadMarker, MainThreadOnly,
    };
    use objc2_app_kit::{
        NSApplication, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource, NSEvent,
        NSEventModifierFlags, NSEventType, NSFilePromiseProvider, NSFilePromiseProviderDelegate, NSPasteboard, NSPasteboardWriting, NSWorkspace,
    };
    use objc2_foundation::{NSArray, NSError, NSPoint, NSProcessInfo, NSRect, NSSize, NSString, NSURL};
    use std::{cell::RefCell, path::Path, sync::Arc};
    use tauri::{AppHandle, Manager as _, Runtime};

    struct PromiseIvars<R: Runtime> {
        app: AppHandle<R>,
        serial: String,
    }

    // Generic ObjC classes aren't possible, so the delegate is fixed to the real runtime.
    type Rt = tauri::Wry;

    define_class!(
        // SAFETY: NSObject has no subclassing requirements and we don't implement Drop.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = PromiseIvars<Rt>]
        struct PromiseDelegate;

        unsafe impl NSObjectProtocol for PromiseDelegate {}

        unsafe impl NSFilePromiseProviderDelegate for PromiseDelegate {
            #[unsafe(method_id(filePromiseProvider:fileNameForType:))]
            fn filePromiseProvider_fileNameForType(&self, provider: &NSFilePromiseProvider, _file_type: &NSString) -> Retained<NSString> {
                let (_, path) = promised_path(provider);
                NSString::from_str(path.rsplit('/').next().unwrap_or("file"))
            }

            #[unsafe(method(filePromiseProvider:writePromiseToURL:completionHandler:))]
            fn filePromiseProvider_writePromiseToURL_completionHandler(&self, provider: &NSFilePromiseProvider, url: &NSURL, completion: &DynBlock<dyn Fn(*mut NSError)>) {
                let (_, src) = promised_path(provider);
                let dest = url.path().map(|p| p.to_string()).unwrap_or_default();
                let done = SendBlock(completion.copy());
                let (app, serial) = (self.ivars().app.clone(), self.ivars().serial.clone());
                tauri::async_runtime::spawn(async move {
                    let ok = pull_promised(&app, serial, src, dest).await;
                    let err = (!ok).then(|| unsafe { NSError::errorWithDomain_code_userInfo(&NSString::from_str("ai.arqanum.droidshuttle"), 1, None) });
                    let ptr = err.as_ref().map(|e| Retained::as_ptr(e) as *mut NSError).unwrap_or(std::ptr::null_mut());
                    done.call(ptr);
                });
            }
        }
    );

    /// ObjC blocks are thread-safe to invoke; Rust just can't see that.
    struct SendBlock(RcBlock<dyn Fn(*mut NSError)>);
    unsafe impl Send for SendBlock {}
    impl SendBlock {
        // Method (not field access) so the closure captures the whole Send wrapper.
        fn call(&self, err: *mut NSError) {
            self.0.call((err,));
        }
    }

    fn promised_path(provider: &NSFilePromiseProvider) -> (bool, String) {
        let info = provider.userInfo().and_then(|o| o.downcast::<NSString>().ok()).map(|s| s.to_string()).unwrap_or_default();
        (info.starts_with("d:"), info.get(2..).unwrap_or("").to_string())
    }

    async fn pull_promised(app: &AppHandle<Rt>, serial: String, src: String, dest: String) -> bool {
        let p = Path::new(&dest);
        let (Some(dir), Some(name)) = (p.parent(), p.file_name()) else { return false };
        let mgr = app.state::<Arc<Manager>>().inner().clone();
        let id = mgr.start(
            app.clone(),
            TransferRequest {
                serial,
                direction: Direction::Pull,
                sources: vec![src],
                dest_dir: dir.to_string_lossy().into_owned(),
                conflict: Conflict::Replace, // Finder already resolved name clashes
                verify: false,
                delete_source: false,
                dest_name: Some(name.to_string_lossy().into_owned()),
                subdirs: None,
                record_import: false, silent: false, label: None,
            },
        );
        matches!(mgr.wait(id).await, Some(s) if s.errors.is_empty() && s.status == crate::transfer::Status::Done)
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = ()]
        struct DragSource;

        unsafe impl NSObjectProtocol for DragSource {}

        unsafe impl NSDraggingSource for DragSource {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn draggingSession_sourceOperationMaskForDraggingContext(&self, _session: &NSDraggingSession, _context: NSDraggingContext) -> NSDragOperation {
                NSDragOperation::Copy
            }
        }
    );

    thread_local! {
        // The provider's delegate and the session's source are unretained by AppKit; keep them alive.
        static KEEP_DELEGATE: RefCell<Option<Retained<PromiseDelegate>>> = const { RefCell::new(None) };
        static KEEP_SOURCE: RefCell<Option<Retained<DragSource>>> = const { RefCell::new(None) };
    }

    fn mouse_event(ns_window: &objc2_app_kit::NSWindow, mtm: MainThreadMarker) -> Option<Retained<NSEvent>> {
        let app = NSApplication::sharedApplication(mtm);
        if let Some(e) = app.currentEvent() {
            if matches!(e.r#type(), NSEventType::LeftMouseDown | NSEventType::LeftMouseDragged) {
                return Some(e);
            }
        }
        // Not inside a mouse event (we're called from an IPC task): synthesize a drag at the cursor.
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDragged,
            ns_window.mouseLocationOutsideOfEventStream(),
            NSEventModifierFlags::empty(),
            NSProcessInfo::processInfo().systemUptime(),
            ns_window.windowNumber(),
            None,
            0,
            1,
            1.0,
        )
    }

    type Writer = Retained<ProtocolObject<dyn NSPasteboardWriting>>;

    /// Pasteboard writers for the given items: promises for phone files, plain file URLs for Mac files.
    fn make_writers(mtm: MainThreadMarker, app: &AppHandle<Rt>, serial: &Option<String>, items: &[DragItemSpec]) -> (Vec<Writer>, Option<Retained<PromiseDelegate>>) {
        let delegate = serial.as_ref().map(|s| {
            let this = PromiseDelegate::alloc(mtm).set_ivars(PromiseIvars { app: app.clone(), serial: s.clone() });
            let d: Retained<PromiseDelegate> = unsafe { msg_send![super(this), init] };
            d
        });
        let writers = items
            .iter()
            .map(|spec| -> Writer {
                match &delegate {
                    Some(d) => {
                        let ftype = NSString::from_str(if spec.is_dir { "public.folder" } else { "public.data" });
                        let provider = NSFilePromiseProvider::initWithFileType_delegate(NSFilePromiseProvider::alloc(), &ftype, ProtocolObject::from_ref(&**d));
                        let info = NSString::from_str(&format!("{}:{}", if spec.is_dir { 'd' } else { 'f' }, spec.path));
                        unsafe { provider.setUserInfo(Some(&info)) };
                        ProtocolObject::from_retained(provider)
                    }
                    None => ProtocolObject::from_retained(NSURL::fileURLWithPath(&NSString::from_str(&spec.path))),
                }
            })
            .collect();
        (writers, delegate)
    }

    fn clipboard_write_on_main(app: &AppHandle<Rt>, serial: Option<String>, items: Vec<DragItemSpec>) -> Result<i64, String> {
        let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
        let (writers, delegate) = make_writers(mtm, app, &serial, &items);
        let array = NSArray::from_retained_slice(&writers);
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        if !pb.writeObjects(&array) {
            return Err("the system clipboard rejected the items".into());
        }
        KEEP_DELEGATE.with(|k| *k.borrow_mut() = delegate);
        Ok(pb.changeCount() as i64)
    }

    pub fn clipboard_write(app: &AppHandle<Rt>, serial: Option<String>, items: Vec<DragItemSpec>) -> Result<i64, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let app2 = app.clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(clipboard_write_on_main(&app2, serial, items));
        })
        .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|_| "timed out writing the clipboard".to_string())?
    }

    /// Change counter + any file URLs currently on the system clipboard (e.g. copied in Finder).
    pub fn clipboard_read() -> super::ClipInfo {
        let pb = NSPasteboard::generalPasteboard();
        let ty = NSString::from_str("public.file-url");
        let mut files = Vec::new();
        if let Some(items) = pb.pasteboardItems() {
            for it in items.iter() {
                if let Some(url) = it.stringForType(&ty).and_then(|u| NSURL::URLWithString(&u)).and_then(|u| u.path()) {
                    files.push(url.to_string());
                }
            }
        }
        super::ClipInfo { change_count: pb.changeCount() as i64, files }
    }

    fn begin_on_main(app: &AppHandle<Rt>, serial: Option<String>, items: Vec<DragItemSpec>) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
        let win = app.get_webview_window("main").ok_or("no main window")?;
        let ns_window = unsafe { &*(win.ns_window().map_err(|e| e.to_string())? as *mut objc2_app_kit::NSWindow) };
        let view = ns_window.contentView().ok_or("no content view")?;
        let event = mouse_event(ns_window, mtm).ok_or("no mouse event to start a drag from")?;
        let origin = view.convertPoint_fromView(event.locationInWindow(), None);

        let (writers, delegate) = make_writers(mtm, app, &serial, &items);

        let workspace = NSWorkspace::sharedWorkspace();
        let mut drag_items = Vec::new();
        for (i, (spec, writer)) in items.iter().zip(writers.iter()).enumerate() {
            let item = NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), writer);
            let ext = Path::new(&spec.path).extension().and_then(|e| e.to_str()).unwrap_or("");
            #[allow(deprecated)]
            let icon = workspace.iconForFileType(&NSString::from_str(if spec.is_dir { "public.folder" } else if ext.is_empty() { "public.data" } else { ext }));
            let off = (i.min(5) as f64) * 6.0;
            let frame = NSRect::new(NSPoint::new(origin.x - 24.0 + off, origin.y - 24.0 - off), NSSize::new(48.0, 48.0));
            unsafe { item.setDraggingFrame_contents(frame, Some(&icon)) };
            drag_items.push(item);
        }

        let source = DragSource::alloc(mtm).set_ivars(());
        let source: Retained<DragSource> = unsafe { msg_send![super(source), init] };
        let array = NSArray::from_retained_slice(&drag_items);
        view.beginDraggingSessionWithItems_event_source(&array, &event, ProtocolObject::from_ref(&*source));
        KEEP_DELEGATE.with(|k| *k.borrow_mut() = delegate);
        KEEP_SOURCE.with(|k| *k.borrow_mut() = Some(source));
        Ok(())
    }

    pub fn begin(app: &AppHandle<Rt>, serial: Option<String>, items: Vec<DragItemSpec>) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let app2 = app.clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(begin_on_main(&app2, serial, items));
        })
        .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(3)).map_err(|_| "timed out starting drag".to_string())?
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipInfo {
    pub change_count: i64,
    pub files: Vec<String>,
}

#[cfg(target_os = "macos")]
pub use mac::{begin, clipboard_read, clipboard_write};

#[cfg(not(target_os = "macos"))]
pub fn clipboard_write(_app: &tauri::AppHandle, _serial: Option<String>, _items: Vec<DragItemSpec>) -> Result<i64, String> {
    Err("clipboard integration is only available on macOS".into())
}

#[cfg(not(target_os = "macos"))]
pub fn clipboard_read() -> ClipInfo {
    ClipInfo { change_count: -1, files: vec![] }
}

#[cfg(not(target_os = "macos"))]
pub fn begin(_app: &tauri::AppHandle, _serial: Option<String>, _items: Vec<DragItemSpec>) -> Result<(), String> {
    Err("drag-out is only available on macOS".into())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use objc2::{rc::Retained, runtime::ProtocolObject};
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    /// Mutates the system clipboard: `cargo test live_clipboard -- --ignored`
    #[test]
    #[ignore]
    fn live_clipboard_read_sees_finder_style_file_copy() {
        let file = std::env::temp_dir().join(format!("db-clip-{}.txt", std::process::id()));
        std::fs::write(&file, "x").unwrap();
        // Same representation Finder writes for ⌘C on a file.
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        let url: Retained<ProtocolObject<dyn NSPasteboardWriting>> = ProtocolObject::from_retained(NSURL::fileURLWithPath(&NSString::from_str(&file.to_string_lossy())));
        assert!(pb.writeObjects(&NSArray::from_retained_slice(&[url])));

        let before = super::clipboard_read();
        assert_eq!(before.files.len(), 1, "{before:?}");
        assert!(before.files[0].ends_with(file.file_name().unwrap().to_str().unwrap()), "{before:?}");

        // Another copy bumps the change counter — that is how paste tells "ours" from "someone else's".
        pb.clearContents();
        pb.setString_forType(&NSString::from_str("plain text"), &NSString::from_str("public.utf8-plain-text"));
        let after = super::clipboard_read();
        assert_ne!(before.change_count, after.change_count);
        assert!(after.files.is_empty());
        std::fs::remove_file(file).unwrap();
    }
}
