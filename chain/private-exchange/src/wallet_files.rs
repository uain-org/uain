// Read the opened descriptor, not a path checked before a second open. These
// files may contain a spending key or one-time private review material.
use std::{
    fs::OpenOptions,
    io::{self, Read},
    path::Path,
};
use zeroize::Zeroizing;

pub fn read_private(path: &Path, limit: usize) -> io::Result<Zeroizing<Vec<u8>>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // NONBLOCK avoids hanging on a FIFO before its type can be checked.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "bounded private regular file required",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != unsafe { libc::geteuid() }
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private file must be owned by this user",
            ));
        }
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "private file too large",
        ));
    }
    Ok(bytes)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fixture(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "uain-private-reader-{}-{}-{}",
            std::process::id(),
            module_path!(),
            name
        ));
        std::fs::create_dir(&root).unwrap();
        root
    }

    #[test]
    fn refuses_fifo_without_waiting_for_writer() {
        let root = fixture("fifo");
        let file = root.join("packet");
        let path = std::ffi::CString::new(file.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let result = read_private(&file, 32);
        std::fs::remove_dir_all(root).unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn refuses_directory() {
        let root = fixture("directory");
        let result = read_private(&root, 32);
        std::fs::remove_dir_all(root).unwrap();
        assert!(result.is_err());
    }

    #[test]
    fn enforces_byte_limit_and_private_permissions() {
        let root = fixture("bounds");
        let file = root.join("packet");
        std::fs::write(&file, [7u8; 33]).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_private(&file, 32).is_err());
        assert_eq!(read_private(&file, 33).unwrap().as_slice(), &[7u8; 33]);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert!(read_private(&file, 33).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
