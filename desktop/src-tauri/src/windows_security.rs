use std::ffi::c_void;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW,
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, GetFileSecurityW, PROTECTED_DACL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, SetFileSecurityW,
};

use crate::error::{DesktopError, Result};

const PRIVATE_DIRECTORY_SDDL: &str = "D:P(A;OICI;FA;;;OW)";

pub fn restrict_to_owner(path: &Path) -> Result<()> {
    let path = wide(path.as_os_str());
    let sddl = wide(PRIVATE_DIRECTORY_SDDL.as_ref());
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        )
    };
    if converted == 0 {
        return Err(last_error("could not build the private Windows ACL"));
    }
    let _descriptor = LocalAllocation(descriptor);
    let applied = unsafe {
        SetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor,
        )
    };
    if applied == 0 {
        return Err(last_error("could not apply the private Windows ACL"));
    }
    Ok(())
}

pub fn has_private_owner_acl(path: &Path) -> Result<bool> {
    let require_protected = path.is_dir();
    let path = wide(path.as_os_str());
    let mut required = 0;
    unsafe {
        GetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            0,
            &mut required,
        );
    }
    if required == 0 {
        return Err(last_error("could not size the Windows ACL"));
    }
    let mut descriptor = vec![0_u8; required as usize];
    let loaded = unsafe {
        GetFileSecurityW(
            path.as_ptr(),
            DACL_SECURITY_INFORMATION,
            descriptor.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    };
    if loaded == 0 {
        return Err(last_error("could not read the Windows ACL"));
    }
    let mut string = ptr::null_mut();
    let converted = unsafe {
        ConvertSecurityDescriptorToStringSecurityDescriptorW(
            descriptor.as_mut_ptr().cast(),
            SDDL_REVISION_1,
            DACL_SECURITY_INFORMATION,
            &mut string,
            ptr::null_mut(),
        )
    };
    if converted == 0 {
        return Err(last_error("could not inspect the Windows ACL"));
    }
    let _string = LocalAllocation(string.cast());
    let length = (0..).position(|index| unsafe { *string.add(index) } == 0);
    let Some(length) = length else {
        return Err(DesktopError::Process(
            "Windows returned an unterminated ACL".to_owned(),
        ));
    };
    let value = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(string, length) });
    Ok((!require_protected || value.starts_with("D:P"))
        && value.starts_with("D:")
        && value.matches("(A;").count() == 1
        && value.contains(";FA;;;OW)"))
}

fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn last_error(context: &str) -> DesktopError {
    DesktopError::Process(format!("{context}: {}", io::Error::last_os_error()))
}

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}
