use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};

use futures::StreamExt;

use crate::error::{BoxliteErrorCode, FFIError, error_to_code, null_pointer_error, write_error};
use crate::runtime::BoxHandle;
use crate::string::c_str_to_string;

pub struct SessionHandle {
    stdin: Option<boxlite::ExecStdin>,
    tokio_rt: std::sync::Arc<tokio::runtime::Runtime>,
}

pub type OutputCallback = extern "C" fn(*const c_char, c_int, *mut c_void);

pub unsafe fn session_start(
    handle: *mut BoxHandle,
    command: *const c_char,
    args: *const *const c_char,
    argc: c_int,
    callback: OutputCallback,
    user_data: *mut c_void,
    out_session: *mut *mut SessionHandle,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_session.is_null() {
            write_error(out_error, null_pointer_error("out_session"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let handle_ref = &mut *handle;

        let cmd_str = match c_str_to_string(command) {
            Ok(s) => s,
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                return code;
            }
        };

        let arg_vec = crate::ops::parse_c_string_array(args, argc);

        let mut cmd = boxlite::BoxCommand::new(cmd_str);
        cmd = cmd.args(arg_vec);
        cmd = cmd.tty(true);

        let result = handle_ref.tokio_rt.block_on(async {
            let mut run = handle_ref.handle.exec(cmd).await?;

            let stdin = run.stdin();
            let mut stdout = run.stdout();
            let mut stderr = run.stderr();

            let cb = callback;
            let ud_raw = user_data as usize;

            std::thread::spawn(move || {
                let user_data = ud_raw as *mut c_void;
                let cb = cb;
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                rt.block_on(async move {
                    loop {
                        tokio::select! {
                            Some(line) = async {
                                match &mut stdout {
                                    Some(s) => s.next().await,
                                    None => None,
                                }
                            } => {
                                if let Ok(c_text) = CString::new(line) {
                                    cb(c_text.as_ptr(), 0, user_data);
                                }
                            }
                            Some(line) = async {
                                match &mut stderr {
                                    Some(s) => s.next().await,
                                    None => None,
                                }
                            } => {
                                if let Ok(c_text) = CString::new(line) {
                                    cb(c_text.as_ptr(), 1, user_data);
                                }
                            }
                            else => break,
                        }
                    }
                });
            });

            Ok::<Option<boxlite::ExecStdin>, boxlite::BoxliteError>(stdin)
        });

        match result {
            Ok(stdin) => {
                *out_session = Box::into_raw(Box::new(SessionHandle {
                    stdin,
                    tokio_rt: handle_ref.tokio_rt.clone(),
                }));
                BoxliteErrorCode::Ok
            }
            Err(e) => {
                let code = error_to_code(&e);
                write_error(out_error, e);
                code
            }
        }
    }
}

pub unsafe fn session_write(
    session: *mut SessionHandle,
    data: *const c_char,
    len: c_int,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if session.is_null() {
            write_error(out_error, null_pointer_error("session"));
            return BoxliteErrorCode::InvalidArgument;
        }

        let session_ref = &mut *session;

        if let Some(ref mut stdin) = session_ref.stdin {
            let bytes = if !data.is_null() && len > 0 {
                std::slice::from_raw_parts(data as *const u8, len as usize).to_vec()
            } else {
                return BoxliteErrorCode::Ok;
            };

            let result = session_ref.tokio_rt.block_on(stdin.write(&bytes));
            match result {
                Ok(()) => BoxliteErrorCode::Ok,
                Err(e) => {
                    let code = error_to_code(&e);
                    write_error(out_error, e);
                    code
                }
            }
        } else {
            let err = boxlite::BoxliteError::Internal("stdin not available".to_string());
            write_error(out_error, err);
            BoxliteErrorCode::Internal
        }
    }
}

pub unsafe fn session_free(session: *mut SessionHandle) {
    if !session.is_null() {
        unsafe {
            drop(Box::from_raw(session));
        }
    }
}
